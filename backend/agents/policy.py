"""Shared, explainable domain rules used by several agents.

Keeping these in one module means the Gap Synthesiser's drafting heuristics and
the Novelty Validator's checks reason about severity the same way, while the
validator still independently re-derives everything from the source obligation.
"""

from __future__ import annotations

import re
from typing import Any

from backend.schemas import SEVERITY_ORDER

# A deadline only drives severity when the sentence is about telling someone, not doing a task.
REPORTING_WORDS = re.compile(r"\b(report|notify|notification|inform)\b", re.I)


def minimum_severity(obligation: dict[str, Any]) -> tuple[str, list[str]]:
    """Lowest defensible severity for a gap against this obligation, with reasons."""
    text = obligation["text"].lower()
    params = obligation.get("parameters") or {}
    strength = obligation["strength"]
    reasons: list[str] = []
    if strength != "mandatory":
        return "low", [f"obligation is {strength} ('{obligation.get('modal', '')}')"]
    level = "medium"
    reasons.append("mandatory obligation")
    deadline = params.get("deadline_hours")
    if deadline is not None and REPORTING_WORDS.search(text):
        if deadline <= 24:
            level = "critical"
            reasons.append(f"regulatory reporting deadline of {deadline:g} hours")
        elif deadline <= 72:
            level = max(level, "high", key=SEVERITY_ORDER.get)
            reasons.append(f"notification deadline of {deadline:g} hours")
    if "breach" in text or "child" in text:
        level = max(level, "high", key=SEVERITY_ORDER.get)
        reasons.append("involves personal-data breach or children's data")
    return level, reasons


def short_summary(text: str, limit: int = 72) -> str:
    """Shorten an obligation into a readable gap title fragment.

        Drops the leading subject ("Regulated entities") and modal verb, capitalises
        the result, then truncates at a word boundary so titles never end mid-word.

        Args:
            text: Obligation sentence.
            limit: Maximum characters before truncation.

        Returns:
            The summary without a trailing period, or ending in "..." if truncated.
    """
    text = re.sub(r"^(Regulated entities|A data fiduciary|The data fiduciary|Every|The board)\s+", "", text.strip())
    text = re.sub(r"^(shall|must|should|may)\s+", "", text)
    text = text[0].upper() + text[1:] if text else text
    if len(text) <= limit:
        return text.rstrip(".")
    cut = text[:limit].rsplit(" ", 1)[0]
    return cut.rstrip(",;") + "..."


def draft_gap_fields(item: dict[str, Any], obligation: dict[str, Any], controls: dict[str, dict]) -> dict[str, Any]:
    """Deterministic template draft of a gap from a coverage item.

    Used by the demo responder and as the fallback when a live LLM fails.
    """
    status = item["status"]
    shortfalls = item.get("shortfalls") or []
    control = controls.get(item.get("best_control_id") or "", {})
    text = obligation["text"]
    lowered = text.lower()
    if shortfalls:
        gap_type = "parameter_shortfall"
        title = f"{control.get('title', 'Existing control')} falls short of {obligation['citation']}"
    elif status == "gap" and ("board" in lowered or "committee" in lowered):
        gap_type = "governance_gap"
        title = f"No governance control for: {short_summary(text)}"
    elif status == "gap":
        gap_type = "missing_control"
        title = f"No control for: {short_summary(text)}"
    else:
        gap_type = "scope_gap"
        title = f"Partial coverage of: {short_summary(text)}"

    base = "high" if status == "gap" else "medium"
    floor, _ = minimum_severity(obligation)
    severity = max(base, floor, key=SEVERITY_ORDER.get)

    coverage_note = (
        f"Closest control {control['id']} ('{control['title']}') matches with similarity {item['similarity']:.2f}."
        if control
        else "No control in the library matches this obligation."
    )
    description = (
        f"{obligation['citation']} requires that: \"{text}\" {coverage_note} "
        + (f"Shortfall: {'; '.join(shortfalls)}. " if shortfalls else "")
        + ("The requirement is not addressed by any documented control." if status == "gap" else
           "The existing control only partly addresses the requirement.")
    )
    if shortfalls and control:
        action = f"Update {control['id']} ({control['title']}) so that it meets the regulatory parameter: {shortfalls[0]}."
    elif control and status == "partial":
        action = f"Extend the scope of {control['id']} to explicitly cover {obligation['citation']} and record evidence."
    else:
        action = (
            f"Design and implement a new control satisfying {obligation['citation']}, assign an owner, "
            "and define test evidence."
        )
    return {
        "obligation_id": obligation["id"],
        "citation": obligation["citation"],
        "title": title,
        "description": description,
        "gap_type": gap_type,
        "severity": severity,
        "classification": "mandatory" if obligation["strength"] == "mandatory" else "advisory",
        "evidence_quote": text,
        "related_control_ids": [control["id"]] if control else [],
        "recommended_action": action,
    }
