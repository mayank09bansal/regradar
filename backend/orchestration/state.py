"""LangGraph shared state for a RegRadar run.

All agent-to-agent communication goes through this structured state:
each node reads what earlier agents wrote and returns a partial update.
``trace``, ``errors`` and ``route_history`` use additive reducers so every
message ever sent is kept in order; everything else is replaced by the latest
writer (e.g. the validator replaces ``pending_feedback`` each round).
"""

from __future__ import annotations

import operator
from dataclasses import dataclass
from datetime import date
from typing import Annotated, Any, TypedDict

from backend.config import Settings
from backend.llm.base import LLMClient


class RegRadarState(TypedDict, total=False):
    run_id: str
    mode: str
    request: dict[str, Any]
    analysis_date: str

    documents: list[dict[str, Any]]
    source_errors: list[str]
    obligations: list[dict[str, Any]]
    coverage: list[dict[str, Any]]

    gaps: list[dict[str, Any]]
    pending_feedback: list[dict[str, Any]]  # validator -> synthesiser, consumed on revision
    validation_decisions: list[dict[str, Any]]
    validation_round: int
    revision_count: int
    max_revisions: int

    remediation_plan: list[dict[str, Any]]
    report: dict[str, Any]
    status: str

    trace: Annotated[list[dict[str, Any]], operator.add]
    errors: Annotated[list[str], operator.add]
    route_history: Annotated[list[str], operator.add]


@dataclass
class RunContext:
    """Non-serialisable dependencies injected into agents (not part of state)."""

    run_id: str
    settings: Settings
    llm: LLMClient
    analysis_date: date
