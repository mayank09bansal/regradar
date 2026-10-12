"""Agent 5 - Novelty Validator: independently checks every proposed/revised gap.

The validator never trusts the synthesiser. It re-derives facts from the source
obligation, the coverage matrix, the known-issues register and other proposals,
then accepts or rejects each gap with structured, machine-readable feedback that
the synthesiser receives through shared state.
"""

from __future__ import annotations

import json
from typing import Any

from backend.agents.base import Agent, MessageBuffer
from backend.agents.policy import minimum_severity
from backend.retrieval.knowledge import known_issues
from backend.retrieval.text import normalise_ws
from backend.schemas import SEVERITY_ORDER, GapProposal, ValidationDecision, ValidationIssue

# Recorded on every decision as ``checks_run`` so a reader can see what each verdict covered.
# Keep in step with check_gap and the "9 Validation Checks" table in README.md.
CHECKS = (
    "obligation_exists",
    "required_detail",
    "citation_consistency",
    "evidence_grounding",
    "not_already_covered",
    "novel_vs_known_issues",
    "not_duplicate",
    "mandatory_classification",
    "severity_calibration",
)

# Advisory only: LLM notes are displayed beside a decision and never change accept or reject.
SYSTEM_CRITIQUE = (
    "You are an independent compliance quality reviewer. For each proposed gap, say whether the "
    "recommended action is specific and actionable. Be concise."
)


def _norm(text: str) -> str:
    """Normalise text so quote matching ignores spacing, case and surrounding punctuation."""
    return normalise_ws(text).lower().strip(" .\"'")


class NoveltyValidator(Agent):
    """Agent 5: rule-based quality gate for gap proposals.

    Decisions come from deterministic checks, which keeps them reproducible and
    prevents a model from approving its own output.
    """
    name = "novelty_validator"
    display_name = "Novelty Validator"
    role = "Independently validates gaps (grounding, citation, coverage, novelty, duplication, modality, severity) and returns structured feedback."

    def check_gap(
        self,
        gap: GapProposal,
        obligations: dict[str, dict[str, Any]],
        coverage: dict[str, dict[str, Any]],
        claimed_obligations: dict[str, str],
    ) -> list[ValidationIssue]:
        """Run all rule checks against one gap.

        An unknown obligation returns immediately because the remaining checks
        compare against it. All other checks run in full, so one round reports
        every problem and the synthesiser can fix them together.

        Args:
            gap: Proposal under review.
            obligations: Source obligations by id.
            coverage: Coverage items by obligation id.
            claimed_obligations: Obligation id to the gap id that owns it (duplicate check).

        Returns:
            Issues found; an empty list means the gap passed.
        """
        issues: list[ValidationIssue] = []
        ob = obligations.get(gap.obligation_id)
        if ob is None:
            return [ValidationIssue(code="unknown_obligation", field="obligation_id",
                                    message=f"Obligation {gap.obligation_id} does not exist in this run.")]

        if len(gap.title.strip()) < 8 or len(gap.description.strip()) < 40 or len(gap.recommended_action.strip()) < 15:
            issues.append(ValidationIssue(
                code="insufficient_detail", field="description",
                message="Title, description and recommended action must be specific (min 8/40/15 characters).",
            ))

        if gap.citation.strip() != ob["citation"]:
            issues.append(ValidationIssue(
                code="citation_mismatch", field="citation", expected=ob["citation"],
                message=f"Citation '{gap.citation}' does not match the obligation's source '{ob['citation']}'.",
            ))

        evidence = _norm(gap.evidence_quote)
        if len(evidence) < 20 or evidence not in _norm(ob["text"]):
            issues.append(ValidationIssue(
                code="evidence_not_grounded", field="evidence_quote", expected="verbatim text from the obligation",
                message="Evidence quote is not a verbatim extract of the cited obligation (possible paraphrase or hallucination).",
            ))

        cov = coverage.get(gap.obligation_id, {})
        if cov.get("status") == "covered":
            issues.append(ValidationIssue(
                code="already_covered", field="obligation_id", expected=cov.get("best_control_id"),
                message=(f"Coverage matrix shows {cov.get('best_control_id')} already covers this obligation "
                         f"(score {cov.get('similarity', 0):.2f}, no parameter shortfall)."),
            ))

        for ki in known_issues():
            if ob["citation"] in ki.get("related_citations", []):
                issues.append(ValidationIssue(
                    code="already_tracked", field="known_issue_id", expected=ki["id"],
                    message=f"Not novel: already tracked as {ki['id']} ('{ki['title']}', {ki['status']}).",
                ))
                break

        owner = claimed_obligations.get(gap.obligation_id)
        if owner and owner != gap.id:
            issues.append(ValidationIssue(
                code="duplicate_proposal", field="obligation_id", expected=owner,
                message=f"Duplicate: {owner} already addresses obligation {gap.obligation_id}.",
            ))

        if gap.classification == "mandatory" and ob["strength"] != "mandatory":
            issues.append(ValidationIssue(
                code="non_mandatory_obligation", field="classification", expected="advisory",
                message=(f"Source uses '{ob['modal']}' ({ob['strength']}); a mandatory gap cannot be raised. "
                         "Reclassify as advisory or withdraw."),
            ))

        floor, reasons = minimum_severity(ob)
        if SEVERITY_ORDER[gap.severity] < SEVERITY_ORDER[floor]:
            issues.append(ValidationIssue(
                code="severity_understated", field="severity", expected=floor,
                message=f"Severity '{gap.severity}' is below the defensible minimum '{floor}' ({'; '.join(reasons)}).",
            ))
        return issues

    def _llm_critique(self, gaps: list[GapProposal], buf: MessageBuffer, round_no: int) -> dict[str, str]:
        """Collect optional actionability notes from a live LLM.

        Skipped for the demo responder. A failure is logged to the trace and
        returns no notes, because the rule checks already decide the outcome.

        Returns:
            Gap id to note, capped at 400 characters each.
        """
        if not self.ctx.llm.is_live or not gaps:
            return {}
        items = [{"gap_id": g.id, "title": g.title, "recommended_action": g.recommended_action} for g in gaps]
        prompt = (f"Gaps:\n{json.dumps(items, ensure_ascii=False)}\n\n"
                  'Return {"reviews": [{"gap_id": str, "actionable": bool, "note": str}]}')
        result, usage = self.call_llm("critique_gaps", SYSTEM_CRITIQUE, prompt, {"gaps": items})
        if result is None:
            buf.emit("orchestrator", "error", "Advisory LLM critique failed; rule checks remain authoritative",
                     {"error": usage.error}, llm=usage, revision_round=round_no)
            return {}
        notes = {}
        for r in result.data.get("reviews", []):
            if isinstance(r, dict) and r.get("gap_id"):
                flag = "" if r.get("actionable", True) else "[not actionable] "
                notes[str(r["gap_id"])] = (flag + str(r.get("note", "")))[:400]
        return notes

    def run(self, state, buf: MessageBuffer) -> dict[str, Any]:
        """Validate each proposed or revised gap and publish the round's outcome.

        Accepted gaps stay accepted and are not checked again. Rejections are
        stored in ``pending_feedback``, which is how the synthesiser receives them;
        ``route_after_validation`` then decides between revising and escalating.

        Returns:
            State update with gaps, cumulative decisions, feedback and the round number.
        """
        round_no = state.get("validation_round", 0) + 1
        revision = state.get("revision_count", 0)
        obligations = {o["id"]: o for o in state.get("obligations", [])}
        coverage = {c["obligation_id"]: c for c in state.get("coverage", [])}
        gaps = [GapProposal.model_validate(g) for g in state.get("gaps", [])]

        # obligations already claimed by accepted gaps, then by earlier pending ones (first wins)
        claimed: dict[str, str] = {g.obligation_id: g.id for g in gaps if g.status == "accepted"}
        to_check = [g for g in gaps if g.status in ("proposed", "revised")]
        for g in to_check:
            claimed.setdefault(g.obligation_id, g.id)

        notes = self._llm_critique(to_check, buf, revision)
        decisions: list[ValidationDecision] = []
        for gap in to_check:
            issues = self.check_gap(gap, obligations, coverage, claimed)
            blocking = [i for i in issues if i.severity == "blocking"]
            decision = ValidationDecision(
                gap_id=gap.id,
                round=round_no,
                gap_revision=gap.revision,
                decision="reject" if blocking else "accept",
                issues=issues,
                checks_run=list(CHECKS),
                reasoning_source="rule-based" + (" + llm-advisory" if gap.id in notes else ""),
                llm_notes=notes.get(gap.id, ""),
            )
            gap.status = "rejected" if blocking else "accepted"
            decisions.append(decision)
            if blocking:
                buf.emit(
                    "gap_synthesiser", "feedback",
                    f"REJECT {gap.id} (rev {gap.revision}): " + "; ".join(i.code for i in blocking),
                    {"decision": decision.model_dump(mode="json")}, revision_round=revision,
                )
            else:
                buf.emit(
                    "output_agent", "decision",
                    f"ACCEPT {gap.id} (rev {gap.revision}): {gap.title}",
                    {"decision": decision.model_dump(mode="json")}, revision_round=revision,
                )

        rejected = [d for d in decisions if d.decision == "reject"]
        max_rev = state.get("max_revisions", 2)
        if not rejected:
            next_step = "all proposals accepted -> Output Agent"
        elif revision < max_rev:
            next_step = f"{len(rejected)} rejected -> back to Gap Synthesiser (revision {revision + 1}/{max_rev})"
        else:
            next_step = f"{len(rejected)} still rejected after {max_rev} revision(s) -> escalate to human review"
        buf.emit(
            "orchestrator", "result",
            f"Validation round {round_no}: {len(decisions) - len(rejected)} accepted, {len(rejected)} rejected; {next_step}",
            {"round": round_no, "accepted": [d.gap_id for d in decisions if d.decision == "accept"],
             "rejected": [d.gap_id for d in rejected], "next": next_step, "checks": list(CHECKS)},
            revision_round=revision,
        )
        all_decisions = list(state.get("validation_decisions", [])) + [d.model_dump(mode="json") for d in decisions]
        return {
            "gaps": [g.model_dump(mode="json") for g in gaps],
            "validation_decisions": all_decisions,
            "pending_feedback": [d.model_dump(mode="json") for d in rejected],
            "validation_round": round_no,
        }
