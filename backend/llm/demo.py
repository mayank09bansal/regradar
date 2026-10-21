"""Deterministic demo responder.

This is NOT a language model. It stands in for the LLM so the complete LangGraph
pipeline (including the Gap Synthesiser <-> Novelty Validator feedback loop) can
be executed offline, repeatably and without an API key.

Every response is labelled ``reasoning_source = "deterministic-demo"`` in the
trace, report and dashboard.

How the demo produces a genuine rejection/revision cycle
-------------------------------------------------------
* The *first* gap draft deliberately behaves like a naive first-pass drafter. It
  starts from the same template the real synthesiser uses, then applies a small,
  documented script of realistic drafting mistakes (``FIRST_DRAFT_SCRIPT``) plus
  one systematic weakness: it labels every gap "mandatory", ignores the
  known-issues register and proposes gaps for every non-covered obligation.
* The Novelty Validator does NOT know about this script. It runs its normal,
  independent rule checks against the source obligations, coverage matrix and
  known-issues register, and rejects what fails.
* Revisions are computed from the validator's structured feedback codes
  (``revise_from_feedback``), so what changes in revision N is driven by what
  the validator said in round N - not by a pre-written trace.
"""

from __future__ import annotations

from typing import Any

from backend.agents.policy import draft_gap_fields
from backend.llm.base import LLMResult

# Realistic first-draft mistakes, keyed by citation.
FIRST_DRAFT_SCRIPT: dict[str, dict[str, Any]] = {
    # Understates severity of a 6-hour regulator-reporting obligation.
    "RBI-DEMO-2026-014 §3.1": {"severity": "low"},
    # Paraphrases the regulation instead of quoting it (evidence not grounded).
    "RBI-DEMO-2026-014 §3.4": {"evidence_quote": "Logs must be kept for roughly six months somewhere in India."},
    # Over-eager: proposes a gap for an obligation that an existing control fully covers.
    "RBI-DEMO-2026-014 §3.2": {"force_propose": True},
}

# Proposals the demo synthesiser defends instead of fixing (creates an escalation).
CONTESTED: dict[str, str] = {
    "RBI-DEMO-2026-014 §3.7": (
        "Maintained: Acme Pay's internal security policy already requires cyber drills, so the "
        "synthesiser keeps this as a mandatory regulatory gap."
    ),
}


class DemoLLM:
    provider = "demo"
    model = "deterministic-demo-responder"
    is_live = False

    def complete_json(self, task: str, system: str, prompt: str, payload: dict[str, Any]) -> LLMResult:
        handler = getattr(self, f"_task_{task}", None)
        if handler is None:
            raise ValueError(f"Demo responder has no handler for task {task!r}")
        return LLMResult(
            data=handler(payload),
            provider=self.provider,
            model=self.model,
            reasoning_source="deterministic-demo",
        )

    # ------------------------------------------------------------------ tasks
    def _task_synthesise_gaps(self, payload: dict[str, Any]) -> dict[str, Any]:
        controls = {c["id"]: c for c in payload["controls"]}
        obligations = {o["id"]: o for o in payload["obligations"]}
        gaps = []
        for item in payload["coverage"]:
            script = FIRST_DRAFT_SCRIPT.get(item["citation"], {})
            if item["status"] == "covered" and not script.get("force_propose"):
                continue
            obligation = obligations[item["obligation_id"]]
            if item["status"] == "covered":
                fields = draft_gap_fields({**item, "status": "partial"}, obligation, controls)
                fields["title"] = f"Strengthen {item.get('best_control_title') or 'control'} for {item['citation']}"
            else:
                fields = draft_gap_fields(item, obligation, controls)
            fields["classification"] = "mandatory"  # naive drafter: everything is mandatory
            for key in ("severity", "evidence_quote"):
                if key in script:
                    fields[key] = script[key]
            gaps.append(fields)
        return {"gaps": gaps, "notes": "Deterministic first-pass draft (demo responder)."}

    def _task_revise_gaps(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {"revisions": [revise_from_feedback(r) for r in payload["rejected"]]}

    def _task_executive_summary(self, payload: dict[str, Any]) -> dict[str, Any]:
        s = payload["stats"]
        top = payload.get("top_items") or []
        lines = [
            f"RegRadar analysed {s['documents']} regulatory document(s) containing {s['obligations']} "
            f"obligations against {s['controls']} internal controls.",
            f"Coverage: {s['covered']} covered, {s['partial']} partially covered and {s['gap']} uncovered "
            f"({s['coverage_pct']:.0f}% fully covered).",
            f"After {s['validation_rounds']} validation round(s), {s['accepted_gaps']} gap(s) were accepted, "
            f"{s['withdrawn_gaps']} withdrawn and {s['escalated_gaps']} escalated for human review.",
        ]
        if top:
            lines.append("Highest priority: " + "; ".join(f"{t['priority']} {t['title']}" for t in top[:3]) + ".")
        return {"summary": " ".join(lines)}


def revise_from_feedback(entry: dict[str, Any]) -> dict[str, Any]:
    """Apply validator feedback codes to a rejected gap (deterministic demo logic)."""
    gap = entry["gap"]
    issues = entry["issues"]
    codes = {i["code"]: i for i in issues}
    citation = gap["citation"]
    revision: dict[str, Any] = {"gap_id": gap["id"], "action": "revise", "changes": {}}

    if citation in CONTESTED and "non_mandatory_obligation" in codes:
        revision["action"] = "maintain"
        revision["response_to_feedback"] = CONTESTED[citation]
        return revision
    for code, why in (
        ("already_covered", "Withdrawn: the validator showed an existing control already satisfies this obligation."),
        ("already_tracked", "Withdrawn: this shortfall is already tracked in the known-issues register."),
        ("duplicate_proposal", "Withdrawn: duplicate of another proposal for the same obligation."),
    ):
        if code in codes:
            revision["action"] = "withdraw"
            revision["response_to_feedback"] = why
            if code == "already_tracked":
                revision["known_issue_id"] = codes[code].get("expected")
            return revision

    changes: dict[str, Any] = {}
    responses: list[str] = []
    if "evidence_not_grounded" in codes:
        changes["evidence_quote"] = entry["obligation_text"]
        responses.append("replaced paraphrase with the verbatim obligation text")
    if "severity_understated" in codes:
        changes["severity"] = codes["severity_understated"]["expected"]
        responses.append(f"raised severity to {changes['severity']}")
    if "citation_mismatch" in codes:
        changes["citation"] = codes["citation_mismatch"]["expected"]
        responses.append("corrected the citation")
    if "non_mandatory_obligation" in codes:
        changes["classification"] = "advisory"
        changes["severity"] = "low"
        responses.append("reclassified as an advisory (non-mandatory) improvement")
    if "insufficient_detail" in codes:
        changes["description"] = (
            gap["description"].rstrip() + f" Required outcome: {entry['obligation_text']}"
        )
        responses.append("expanded the description with the required outcome")
    revision["changes"] = changes
    revision["response_to_feedback"] = "Revised: " + ("; ".join(responses) or "no applicable change")
    return revision
