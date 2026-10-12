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


TOKEN = "correct-horse-battery-staple"


@pytest.fixture
def secured_client(settings):
    with TestClient(create_app(replace(settings, api_token=TOKEN))) as c:
        yield c


@pytest.mark.parametrize(("method", "path"), [
    ("post", "/api/runs"),
    ("post", "/api/demo/run"),
    ("delete", "/api/runs/run-1"),
    ("post", "/api/integrations/test"),
])
@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": f"Basic {TOKEN}"}])
def test_write_endpoints_reject_missing_or_wrong_token(secured_client, method, path, headers):
    r = secured_client.request(method, path, headers=headers, json={"mode": "demo"} if path == "/api/runs" else None)
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"
    assert TOKEN not in r.text


def test_valid_token_allows_writes_and_reads_stay_open(secured_client):
    auth = {"Authorization": f"Bearer {TOKEN}"}
    created = secured_client.post("/api/demo/run", headers=auth)
    assert created.status_code == 201
    assert secured_client.get(f"/api/runs/{created.json()['id']}").status_code == 200
    assert secured_client.delete(f"/api/runs/{created.json()['id']}", headers=auth).status_code == 204


def test_token_is_reported_as_required_but_never_exposed(secured_client):
    r = secured_client.get("/api/config")
    assert r.json()["write_auth_required"] is True and TOKEN not in r.text


def test_writes_stay_open_when_no_token_is_configured(settings):
    with TestClient(create_app(settings)) as c:
        assert c.get("/api/config").json()["write_auth_required"] is False
        assert c.post("/api/demo/run").status_code == 201


def test_token_is_excluded_from_settings_repr(monkeypatch):
    monkeypatch.setenv("REGRADAR_API_TOKEN", TOKEN)
    s = build_settings()
    assert s.api_token == TOKEN and TOKEN not in repr(s)


def test_security_headers_on_api_and_csp_exempts_swagger(settings):
    with TestClient(create_app(settings)) as c:
        api = c.get("/api/health")
        assert api.headers["x-content-type-options"] == "nosniff"
        assert api.headers["x-frame-options"] == "DENY"
        assert "script-src 'self'" in api.headers["content-security-policy"]
        docs = c.get("/docs")
        assert docs.status_code == 200 and docs.headers["x-content-type-options"] == "nosniff"
        assert "content-security-policy" not in docs.headers


def test_browser_can_send_the_token_and_patch_cross_origin(settings):
    with TestClient(create_app(settings)) as c:
        r = c.options("/api/runs/x/remediation/GAP-001", headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "PATCH",
            "Access-Control-Request-Headers": "authorization,content-type",
        })
    assert r.status_code == 200
    assert "PATCH" in r.headers["access-control-allow-methods"]
    assert "authorization" in r.headers["access-control-allow-headers"].lower()


def test_dashboard_entry_has_no_inline_script():
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    assert not re.search(r"<script(?![^>]*\bsrc=)[^>]*>", html)
