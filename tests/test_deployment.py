"""Deployment tests: Vercel defaults, PostgreSQL storage, and serving the built dashboard."""

from __future__ import annotations

import os
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from backend.config import build_settings
from backend.db import PostgresDatabase, open_database
from backend.main import create_app
from backend.orchestration.runner import run_analysis
from backend.schemas import AnalysisRequest

from .conftest import ANALYSIS_DATE

POSTGRES_URL = os.environ.get("REGRADAR_TEST_POSTGRES_URL", "")


def test_vercel_defaults_to_temporary_sqlite(monkeypatch):
    monkeypatch.setenv("VERCEL", "1")
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("POSTGRES_URL", "")
    s = build_settings()
    assert s.on_vercel and s.database_url == "sqlite:////tmp/regradar.db"
    assert s.storage_persistent is False
    assert "temporary" in s.database_label
    assert s.public_dict()["deployment"] == "vercel"


def test_postgres_url_fallback_and_label_hides_password(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "")
    monkeypatch.setenv("POSTGRES_URL", "postgresql://user:s3cret@ep-cool-1.aws.neon.tech/neondb?sslmode=require")
    s = build_settings()
    assert s.is_postgres and s.storage_persistent
    assert s.database_label == "postgresql (ep-cool-1.aws.neon.tech)"
    assert "s3cret" not in str(s.public_dict())


def _write_dist(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>RegRadar</title><div id=root></div>", encoding="utf-8")
    (dist / "assets" / "main.js").write_text("console.log('ok')", encoding="utf-8")
    return dist


def test_serves_built_dashboard_with_spa_fallback(settings, tmp_path):
    dist = _write_dist(tmp_path)
    app = create_app(replace(settings, serve_frontend=True, frontend_dir=str(dist)))
    html = {"Accept": "text/html,application/xhtml+xml"}
    with TestClient(app) as c:
        assert "RegRadar" in c.get("/", headers=html).text
        # React Router deep link refresh -> index.html
        deep = c.get("/runs/run-123/trace", headers=html)
        assert deep.status_code == 200 and "<div id=root>" in deep.text
        assert c.get("/assets/main.js").text == "console.log('ok')"
        # API routes and docs still win over the frontend
        assert c.get("/api/health", headers=html).json()["status"] == "ok"
        assert c.get("/openapi.json").status_code == 200
        assert c.post("/api/demo/run").status_code == 201


def test_api_only_mode_without_dist(settings, tmp_path):
    app = create_app(replace(settings, serve_frontend=True, frontend_dir=str(tmp_path / "missing")))
    with TestClient(app) as c:
        assert c.get("/").json()["health"] == "/api/health"


@pytest.mark.skipif(not POSTGRES_URL, reason="set REGRADAR_TEST_POSTGRES_URL to run PostgreSQL tests")
def test_postgres_storage_end_to_end(settings):
    pg_settings = replace(settings, database_url=POSTGRES_URL)
    db = open_database(pg_settings)
    assert isinstance(db, PostgresDatabase) and db.ping()
    detail = run_analysis(AnalysisRequest(mode="demo", analysis_date=ANALYSIS_DATE), pg_settings, db)
    assert detail["status"] == "completed"
    trace = db.get_trace(detail["id"])
    assert len(trace) == detail["trace_length"] > 20
    assert [m["seq"] for m in trace] == list(range(1, len(trace) + 1))
    assert detail["id"] in [r["id"] for r in db.list_runs()]
    # a brand-new connection object (like another serverless instance) sees the same run
    again = open_database(pg_settings).get_run(detail["id"])
    assert again["stats"]["accepted_gaps"] == 9
    with TestClient(create_app(pg_settings)) as c:
        h = c.get("/api/health").json()
        assert h["storage_persistent"] is True and h["storage"].startswith("postgresql")
        assert c.get(f"/api/runs/{detail['id']}/trace?message_type=feedback").json()["count"] == 7
        assert c.delete(f"/api/runs/{detail['id']}").status_code == 204
    assert db.get_run(detail["id"]) is None
