"""Loaders for the synthetic regulation dataset and the control knowledge base."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from backend.config import DATA_DIR

DEMO_DATASET_PATH = DATA_DIR / "demo" / "regulations_synthetic.json"
CONTROL_LIBRARY_PATH = DATA_DIR / "controls" / "control_library.json"


@lru_cache(maxsize=1)
def load_demo_dataset() -> dict[str, Any]:
    data = json.loads(DEMO_DATASET_PATH.read_text(encoding="utf-8"))
    if not data.get("synthetic"):
        raise ValueError("Demo dataset must be explicitly marked synthetic")
    return data


@lru_cache(maxsize=1)
def load_control_library() -> dict[str, Any]:
    data = json.loads(CONTROL_LIBRARY_PATH.read_text(encoding="utf-8"))
    ids = [c["id"] for c in data["controls"]]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate control IDs in control library")
    return data


def controls_by_id() -> dict[str, dict[str, Any]]:
    return {c["id"]: c for c in load_control_library()["controls"]}


def known_issues() -> list[dict[str, Any]]:
    return list(load_control_library().get("known_issues", []))
