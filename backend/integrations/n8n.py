"""The n8n workflow export shipped in n8n/ (import it into n8n; see README)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from backend.config import PROJECT_ROOT

N8N_WORKFLOW_PATH = PROJECT_ROOT / "n8n" / "regradar_workflow.json"


def load_n8n_workflow(path: Path = N8N_WORKFLOW_PATH) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))
