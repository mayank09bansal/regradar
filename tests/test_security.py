"""Security regressions: secret handling and what error responses reveal."""

from __future__ import annotations

import re
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.config import build_settings
from backend.llm.providers import OpenAICompatibleClient
from backend.main import create_app

ROOT = Path(__file__).resolve().parent.parent


def test_no_llm_key_is_built_into_the_application(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    s = build_settings()
    assert s.openai_api_key == ""
    assert s.live_llm_configured is False


def test_backend_source_does_not_decode_embedded_credentials():
    for path in (ROOT / "backend").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "b64decode" not in text, path
        assert not re.search(r"\bgsk_[A-Za-z0-9]{16,}", text), path


def test_local_env_files_are_ignored_but_the_template_is_not():
    lines = (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert ".env" in lines and "!.env.example" in lines
    assert "frontend/dist/" in lines


def test_live_run_with_default_provider_and_no_key_returns_clear_400(settings):
    app = create_app(replace(settings, llm_provider="openai", llm_model="some-model", openai_api_key=""))
    body = {"mode": "live", "documents": [{
        "title": "Test circular", "regulator": "RBI",
        "text": "1. Regulated entities shall encrypt all customer data at rest using strong algorithms.",
    }]}
    with TestClient(app) as c:
        r = c.post("/api/runs", json=body)
    assert r.status_code == 400 and "OPENAI_API_KEY" in r.json()["detail"]


def test_unhandled_error_does_not_reveal_exception_text(settings, monkeypatch):
    secret = "postgresql://user:s3cret@db.internal/prod"

    def boom(*_args, **_kwargs):
        raise RuntimeError(f"cannot connect to {secret}")

    monkeypatch.setattr("backend.db._BaseDatabase.list_runs", boom)
    with TestClient(create_app(settings), raise_server_exceptions=False) as c:
        r = c.get("/api/runs")
    assert r.status_code == 500
    assert "s3cret" not in r.text and "RuntimeError" not in r.text


def test_health_failure_does_not_reveal_database_error(settings, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("password authentication failed for user s3cret")

    monkeypatch.setattr("backend.db._BaseDatabase.ping", boom)
    with TestClient(create_app(settings)) as c:
        r = c.get("/api/health")
    assert r.status_code == 503 and r.json() == {"detail": "Database unavailable"}


@pytest.mark.parametrize("path", ["/api/runs", "/api/runs?limit=1"])
def test_run_list_stays_a_summary(settings, path):
    with TestClient(create_app(settings)) as c:
        c.post("/api/demo/run")
        rows = c.get(path).json()
    assert rows and "result" not in rows[0] and rows[0]["stats"]["accepted_gaps"] == 9


def test_local_openai_compatible_server_needs_no_key():
    client = OpenAICompatibleClient(api_key="", base_url="http://localhost:11434/v1", model="llama3",
                                    timeout=5, max_retries=0, temperature=0.1)
    assert client.api_key == ""
