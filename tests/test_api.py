"""API tests using FastAPI's TestClient (runs the real app, graph and SQLite DB)."""

from __future__ import annotations

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from backend.main import create_app


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture
def demo_run(client):
    r = client.post("/api/demo/run")
    assert r.status_code == 201, r.text
    return r.json()


def test_health_and_root(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["database"] == "ok" and body["llm_provider"] == "demo"
    assert client.get("/").json()["docs"] == "/docs"
    assert client.get("/openapi.json").status_code == 200


def test_static_knowledge_endpoints(client):
    assert len(client.get("/api/agents").json()) == 6
    graph = client.get("/api/graph").json()
    assert {"from": "novelty_validator", "to": "gap_synthesiser"}.items() <= next(
        e for e in graph["edges"] if e["from"] == "novelty_validator" and e["to"] == "gap_synthesiser"
    ).items()
    ds = client.get("/api/sources/demo-dataset").json()
    assert ds["synthetic"] is True and len(ds["documents"]) == 3
    assert len(client.get("/api/controls").json()["controls"]) == 16


def test_config_has_no_secrets(settings):
    secret = "sk-test-should-never-leak"
    app = create_app(replace(settings, anthropic_api_key=secret))
    with TestClient(app) as c:
        text = c.get("/api/config").text
    assert secret not in text and '"anthropic_api_key_set":true' in text.replace(" ", "")


def test_demo_run_and_detail_endpoints(client, demo_run):
    run_id = demo_run["id"]
    assert demo_run["status"] == "completed" and demo_run["mode"] == "demo"
    assert demo_run["stats"]["feedback_loop_triggered"] is True
    assert demo_run["trace_length"] > 20

    runs = client.get("/api/runs").json()
    assert runs[0]["id"] == run_id
    assert client.get("/api/runs/latest").json()["id"] == run_id

    trace = client.get(f"/api/runs/{run_id}/trace").json()
    assert trace["count"] == demo_run["trace_length"]
    feedback = client.get(f"/api/runs/{run_id}/trace", params={"message_type": "feedback"}).json()
    assert feedback["count"] >= 5 and all(m["sender"] == "novelty_validator" for m in feedback["messages"])
    only_mapper = client.get(f"/api/runs/{run_id}/trace", params={"agent": "control_mapper"}).json()
    assert all("control_mapper" in (m["sender"], m["recipient"]) for m in only_mapper["messages"])

    cov = client.get(f"/api/runs/{run_id}/coverage").json()
    assert cov["counts"] == {"covered": 5, "partial": 9, "gap": 2}
    gaps = client.get(f"/api/runs/{run_id}/gaps").json()
    assert len(gaps["gaps"]) == 12 and len(gaps["validation_decisions"]) == 16
    rem = client.get(f"/api/runs/{run_id}/remediation").json()
    assert rem["items"][0]["rank"] == 1 and rem["items"][0]["priority"] == "P1"

    report = client.get(f"/api/runs/{run_id}/report").json()
    assert report["mode"] == "demo" and report["stats"]["accepted_gaps"] == 9
    md = client.get(f"/api/runs/{run_id}/report", params={"format": "md"})
    assert md.status_code == 200 and md.text.startswith("# RegRadar Compliance Gap Report")
    assert "attachment" in md.headers["content-disposition"]


def test_runs_persist_across_app_restarts(settings, demo_run):
    with TestClient(create_app(settings)) as c2:
        assert c2.get(f"/api/runs/{demo_run['id']}").status_code == 200


def test_not_found_and_validation_errors(client):
    assert client.get("/api/runs/does-not-exist").status_code == 404
    assert client.get("/api/runs/latest").status_code == 404
    r = client.post("/api/runs", json={"mode": "live"})
    assert r.status_code == 422 and "Live mode needs" in r.text
    r = client.post("/api/runs", json={"mode": "demo", "max_revisions": 9})
    assert r.status_code == 422
    r = client.post("/api/runs", json={"mode": "demo", "unknown_field": 1})
    assert r.status_code == 422


def test_live_mode_without_llm_key_returns_clear_400(settings):
    app = create_app(replace(settings, llm_provider="anthropic", llm_model="some-model", anthropic_api_key=""))
    body = {"mode": "live", "documents": [{
        "title": "Test circular", "regulator": "RBI",
        "text": "1. Regulated entities shall encrypt all customer data at rest using strong algorithms.",
    }]}
    with TestClient(app) as c:
        r = c.post("/api/runs", json=body)
    assert r.status_code == 400 and "ANTHROPIC_API_KEY" in r.json()["detail"]


def test_create_demo_run_with_options(client):
    r = client.post("/api/runs", json={"mode": "demo", "regulators": ["meity"], "max_revisions": 1})
    assert r.status_code == 201
    body = r.json()
    assert {d["regulator"] for d in body["documents"]} == {"MEITY"}
    assert body["request"]["max_revisions"] == 1


def test_delete_run(client, demo_run):
    assert client.delete(f"/api/runs/{demo_run['id']}").status_code == 204
    assert client.get(f"/api/runs/{demo_run['id']}").status_code == 404


def test_cors_preflight_allows_frontend_origin(client):
    r = client.options(
        "/api/health",
        headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"},
    )
    assert r.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_integration_test_requires_configuration(client):
    assert client.post("/api/integrations/test").status_code == 400


