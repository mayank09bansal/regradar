from __future__ import annotations

import os
import sys
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Tests must never depend on a developer's local .env or real API keys.
os.environ["LLM_PROVIDER"] = "demo"
for key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SLACK_WEBHOOK_URL", "N8N_WEBHOOK_URL", "LLM_MODEL",
            "DATABASE_URL", "POSTGRES_URL"):
    os.environ[key] = ""
os.environ.pop("VERCEL", None)

from backend.config import build_settings  # noqa: E402
from backend.db import Database  # noqa: E402

ANALYSIS_DATE = date(2026, 10, 13)


@pytest.fixture
def settings(tmp_path):
    return replace(
        build_settings(),
        database_url=f"sqlite:///{(tmp_path / 'test.db').as_posix()}",
        max_revisions=2,
        serve_frontend=False,  # API tests must not depend on whether frontend/dist was built
    )


@pytest.fixture
def db(settings):
    return Database(settings.database_path)
