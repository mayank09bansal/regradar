"""Execute one RegRadar analysis through the LangGraph graph and persist it."""

from __future__ import annotations

import logging
import uuid
from datetime import date
from typing import Any

from langgraph.errors import GraphRecursionError

from backend.agents.base import AgentFailure, MessageBuffer
from backend.config import Settings
from backend.db import RunStore
from backend.integrations.notify import notify_run_completed
from backend.llm.base import LLMClient
from backend.llm.factory import get_llm_client
from backend.orchestration.graph import build_graph
from backend.orchestration.state import RegRadarState, RunContext
from backend.schemas import AnalysisRequest, utcnow

log = logging.getLogger("regradar.runner")

# State keys persisted as the run result. Trace messages are stored in their own table.
RESULT_KEYS = (
    "documents", "obligations", "coverage", "gaps", "validation_decisions", "remediation_plan",
    "report", "route_history", "source_errors", "errors", "validation_round", "revision_count", "max_revisions",
)


def new_run_id() -> str:
    """Create a sortable, readable id: UTC timestamp plus a random suffix for uniqueness."""
    return f"run-{utcnow():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:6]}"


def run_analysis(
    request: AnalysisRequest,
    settings: Settings,
    db: RunStore,
    llm: LLMClient | None = None,
) -> dict[str, Any]:
    """Run the full graph synchronously; returns the persisted run detail.

    Raises ``LLMAuthError`` before starting if a live run lacks LLM configuration.
    ``llm`` can be injected (tests use scripted clients).
    """
    llm = llm or get_llm_client(settings, request.mode)
    run_id = new_run_id()
    analysis_date = request.analysis_date or date.today()
    max_revisions = request.max_revisions if request.max_revisions is not None else settings.max_revisions
    ctx = RunContext(run_id=run_id, settings=settings, llm=llm, analysis_date=analysis_date)
    request_dict = request.model_dump(mode="json")

    db.create_run(run_id, utcnow().isoformat(), request.mode, llm.provider, llm.model, request_dict)

    initial: RegRadarState = {
        "run_id": run_id,
        "mode": request.mode,
        "request": request_dict,
        "analysis_date": analysis_date.isoformat(),
        "documents": [], "source_errors": [], "obligations": [], "coverage": [], "gaps": [],
        "pending_feedback": [], "validation_decisions": [], "validation_round": 0, "revision_count": 0,
        "max_revisions": max_revisions, "remediation_plan": [], "report": {}, "status": "running",
        "trace": [], "errors": [], "route_history": [],
    }
    kickoff = MessageBuffer(initial, ctx, "orchestrator")
    kickoff.emit(
        "regulatory_scout", "task",
        f"Start {request.mode.upper()} analysis (max {max_revisions} revision cycle(s); reasoning: "
        f"{'deterministic demo responder' if not llm.is_live else f'{llm.provider}/{llm.model}'})",
        {"request": request_dict, "llm_provider": llm.provider, "llm_model": llm.model, "live_llm": llm.is_live},
    )
    initial["trace"] = kickoff.messages

    graph = build_graph(ctx)
    final: dict[str, Any] = dict(initial)
    status, error = "completed", None
    try:
        for snapshot in graph.stream(initial, config={"recursion_limit": 60}, stream_mode="values"):
            final = snapshot
    except AgentFailure as exc:
        status, error = "failed", str(exc)
        final = dict(final)
        final["trace"] = list(final.get("trace", [])) + exc.messages
    except GraphRecursionError as exc:
        status, error = "failed", f"Graph recursion limit reached: {exc}"
    except Exception as exc:  # pragma: no cover - defensive
        log.exception("Run %s failed", run_id)
        status, error = "failed", f"{type(exc).__name__}: {exc}"

    if status == "completed" and final.get("status") != "completed":
        status, error = "failed", error or "Graph finished without producing a report"

    result = {k: final.get(k) for k in RESULT_KEYS}
    stats = (final.get("report") or {}).get("stats", {})
    db.finish_run(run_id, utcnow().isoformat(), status, stats, result, final.get("trace", []), error)

    if request.notify and status == "completed":
        notify_run_completed(settings, run_id, stats)
    detail = db.get_run(run_id)
    assert detail is not None
    return detail
