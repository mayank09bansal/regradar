"""Vercel serverless entrypoint for RegRadar FastAPI application."""

from __future__ import annotations

import sys
from pathlib import Path

# Ensure the project root is in sys.path
root = Path(__file__).resolve().parent.parent
if str(root) not in sys.path:
    sys.path.insert(0, str(root))

from backend.main import app  # noqa: E402
