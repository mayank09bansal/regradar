"""REST API routes."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import PlainTextResponse

from backend import __version__
from backend.agents import AGENT_REGISTRY
from backend.config import Settings
from backend.db import RunStore
from backend.integrations.n8n import load_n8n_workflow
from backend.integrations.notify import notify_run_completed
from backend.llm.base import LLMAuthError
from backend.orchestration.graph import GRAPH_SPEC
from backend.orchestration.runner import run_analysis
from backend.retrieval.knowledge import load_control_library, load_demo_dataset
from backend.schemas import AnalysisRequest, RunDetail, RunSummary

log = logging.getLogger("regradar.api")

router = APIRouter(prefix="/api")


def get_db(request: Request) -> RunStore:
    return request.app.state.db


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


def to_detail(row: dict[str, Any]) -> dict[str, Any]:
    result = row.get("result") or {}
    detail = RunDetail(
        id=row["id"], created_at=row["created_at"], completed_at=row["completed_at"], status=row["status"],
        mode=row["mode"], llm_provider=row["llm_provider"], llm_model=row["llm_model"], stats=row["stats"],
        error=row["error"], request=row["request"],
        documents=result.get("documents") or [], obligations=result.get("obligations") or [],
        coverage=result.get("coverage") or [], gaps=result.get("gaps") or [],
        validation_decisions=result.get("validation_decisions") or [],
        remediation_plan=result.get("remediation_plan") or [], report=result.get("report") or None,
        route_history=result.get("route_history") or [], source_errors=result.get("source_errors") or [],
        errors=result.get("errors") or [], trace_length=row.get("trace_length", 0),
    )
    return detail.model_dump(mode="json")


def _require_run(db: RunStore, run_id: str) -> dict[str, Any]:
    row = db.get_run(run_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")
    return row


# ---------------------------------------------------------------- system
@router.get("/health")
def health(db: RunStore = Depends(get_db), settings: Settings = Depends(get_settings_dep)) -> dict[str, Any]:
    try:
        db_ok = db.ping()
    except Exception as exc:
        log.exception("Database healthcheck failed")
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
    return {
        "status": "ok",
        "version": __version__,
        "database": "ok" if db_ok else "error",
        "llm_provider": settings.llm_provider,
        "live_llm_configured": settings.live_llm_configured,
        "storage": settings.database_label,
        "storage_persistent": settings.storage_persistent,
        "deployment": "vercel" if settings.on_vercel else "local",
        "time": datetime.now(UTC).isoformat(),
    }


@router.get("/config")
def config(settings: Settings = Depends(get_settings_dep)) -> dict[str, Any]:
    return settings.public_dict()


@router.get("/agents")
def agents() -> list[dict[str, Any]]:
    return AGENT_REGISTRY


@router.get("/graph")
def graph() -> dict[str, Any]:
    return GRAPH_SPEC


@router.get("/sources/demo-dataset")
def demo_dataset() -> dict[str, Any]:
    return load_demo_dataset()


@router.get("/controls")
def controls() -> dict[str, Any]:
    return load_control_library()


# ---------------------------------------------------------------- runs
def _execute(body: AnalysisRequest, settings: Settings, db: RunStore) -> dict[str, Any]:
    try:
        row = run_analysis(body, settings, db)
    except LLMAuthError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Live LLM is not configured: {exc}. Set LLM_PROVIDER, LLM_MODEL and the API key in .env, "
                   "or use mode='demo'.",
        ) from exc
    return to_detail(row)


@router.post("/runs", status_code=201)
def create_run(
    body: AnalysisRequest, db: RunStore = Depends(get_db), settings: Settings = Depends(get_settings_dep)
) -> dict[str, Any]:
    """Run an analysis synchronously through the LangGraph pipeline."""
    return _execute(body, settings, db)


@router.post("/demo/run", status_code=201)
def run_demo(
    max_revisions: int | None = Query(default=None, ge=0, le=5),
    notify: bool = False,
    db: RunStore = Depends(get_db),
    settings: Settings = Depends(get_settings_dep),
) -> dict[str, Any]:
    """Deterministic demo: executes the real graph over the synthetic dataset (no API key needed)."""
    return _execute(AnalysisRequest(mode="demo", max_revisions=max_revisions, notify=notify), settings, db)


@router.get("/runs", response_model=list[RunSummary])
def list_runs(limit: int = Query(default=50, ge=1, le=200), db: RunStore = Depends(get_db)) -> list[dict[str, Any]]:
    return db.list_runs(limit)


@router.get("/runs/latest")
def latest_run(db: RunStore = Depends(get_db)) -> dict[str, Any]:
    runs = db.list_runs(1)
    if not runs:
        raise HTTPException(status_code=404, detail="No runs yet - start the demo with POST /api/demo/run")
    return to_detail(_require_run(db, runs[0]["id"]))


@router.get("/runs/{run_id}")
def get_run(run_id: str, db: RunStore = Depends(get_db)) -> dict[str, Any]:
    return to_detail(_require_run(db, run_id))


@router.delete("/runs/{run_id}", status_code=204)
def delete_run(run_id: str, db: RunStore = Depends(get_db)) -> None:
    if not db.delete_run(run_id):
        raise HTTPException(status_code=404, detail=f"Run {run_id} not found")


@router.get("/runs/{run_id}/trace")
def get_trace(
    run_id: str,
    agent: str | None = Query(default=None, description="Filter by sender or recipient"),
    message_type: str | None = Query(default=None),
    db: RunStore = Depends(get_db),
) -> dict[str, Any]:
    _require_run(db, run_id)
    trace = db.get_trace(run_id)
    if agent:
        trace = [m for m in trace if agent in (m["sender"], m["recipient"])]
    if message_type:
        trace = [m for m in trace if m["message_type"] == message_type]
    return {"run_id": run_id, "count": len(trace), "messages": trace}


@router.get("/runs/{run_id}/coverage")
def get_coverage(run_id: str, db: RunStore = Depends(get_db)) -> dict[str, Any]:
    detail = to_detail(_require_run(db, run_id))
    cov = detail["coverage"]
    return {
        "run_id": run_id,
        "counts": {k: sum(1 for c in cov if c["status"] == k) for k in ("covered", "partial", "gap")},
        "items": cov,
    }


@router.get("/runs/{run_id}/gaps")
def get_gaps(run_id: str, db: RunStore = Depends(get_db)) -> dict[str, Any]:
    detail = to_detail(_require_run(db, run_id))
    return {"run_id": run_id, "gaps": detail["gaps"], "validation_decisions": detail["validation_decisions"]}


@router.get("/runs/{run_id}/remediation")
def get_remediation(run_id: str, db: RunStore = Depends(get_db)) -> dict[str, Any]:
    detail = to_detail(_require_run(db, run_id))
    return {"run_id": run_id, "items": detail["remediation_plan"]}


@router.get("/runs/{run_id}/report", response_model=None)
def get_report(
    run_id: str, format: Literal["json", "md"] = "json", db: RunStore = Depends(get_db)
) -> dict[str, Any] | PlainTextResponse:
    detail = to_detail(_require_run(db, run_id))
    report = detail["report"]
    if not report:
        raise HTTPException(status_code=409, detail=f"Run {run_id} has no report (status: {detail['status']})")
    if format == "md":
        return PlainTextResponse(
            report["markdown"], media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="regradar-{run_id}.md"'},
        )
    return report


@router.get("/integrations/n8n/workflow")
def n8n_workflow() -> dict[str, Any]:
    """The importable n8n workflow export. It holds no secrets: URLs are read from n8n's $env at runtime."""
    try:
        return load_n8n_workflow()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"n8n workflow export not found: {exc.filename}") from exc


@router.post("/integrations/test")
def test_integrations(settings: Settings = Depends(get_settings_dep)) -> dict[str, Any]:
    if not (settings.slack_webhook_url or settings.n8n_webhook_url):
        raise HTTPException(status_code=400, detail="Neither SLACK_WEBHOOK_URL nor N8N_WEBHOOK_URL is set in .env")
    return {"results": notify_run_completed(settings, "integration-test", {"accepted_gaps": 0, "coverage_pct": 0})}
