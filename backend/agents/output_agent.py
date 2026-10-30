"""Agent 6 - Output Agent: prioritises remediation and writes the final report."""

from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

from backend.agents.base import Agent, MessageBuffer
from backend.retrieval.knowledge import controls_by_id, load_control_library
from backend.schemas import GapProposal, RemediationItem, Report, utcnow

# Base of the risk score. The P1/P2 cut-offs in OutputAgent.prioritise are calibrated against it.
SEVERITY_WEIGHT = {"critical": 10.0, "high": 7.0, "medium": 4.0, "low": 2.0}
# Days allowed to remediate at each priority, counted from the analysis date.
PRIORITY_SLA_DAYS = {"P1": 30, "P2": 60, "P3": 90}
# Fallback owner when a gap has no related control. Dict order sets precedence.
TOPIC_OWNERS = {  # checked in this priority order
    "data protection": "Data Protection Officer",
    "incident reporting": "CISO",
    "vendor risk": "Vendor Risk Manager",
    "governance": "Company Secretary",
    "resilience": "Chief Risk Officer",
}
# "Use only the facts provided" keeps a board-facing summary tied to computed statistics.
SYSTEM_SUMMARY = (
    "You are writing the executive summary of a regulatory compliance gap report for the board. "
    "Use only the facts provided. 4-6 sentences, plain English, no markdown."
)
# Always included in the report; run() adds a synthetic-data warning when relevant.
DISCLAIMERS = [
    "RegRadar is an academic decision-support prototype; findings must be reviewed by a qualified compliance professional.",
]


def urgency_factor(effective: date | None, today: date) -> tuple[float, str]:
    """Convert time until a requirement takes effect into a score multiplier.

    Multipliers: 1.6 once effective, 1.4 within 30 days, 1.2 within 90 days, 1.0 beyond
    that. An unknown date gets 1.1: uncertain, so it is not treated as the most relaxed case.

    Returns:
        The multiplier and a phrase explaining it, used in remediation actions.
    """
    if effective is None:
        return 1.1, "effective date unknown"
    days = (effective - today).days
    if days <= 0:
        return 1.6, f"already effective ({-days} days ago)"
    if days <= 30:
        return 1.4, f"effective in {days} days"
    if days <= 90:
        return 1.2, f"effective in {days} days"
    return 1.0, f"effective in {days} days"


class OutputAgent(Agent):
    """Agent 6: turns validated gaps into the remediation plan and final report.

    It only reports gaps the validator accepted; escalated and withdrawn gaps are
    listed separately so they cannot be mistaken for confirmed findings.
    """
    name = "output_agent"
    display_name = "Output Agent"
    role = "Scores accepted gaps (severity x urgency x exposure), builds the remediation plan and writes the final report."

    def prioritise(self, gaps: list[GapProposal], obligations: dict[str, dict], today: date) -> list[RemediationItem]:
        """Score gaps and build a ranked remediation plan.

        Score = severity weight x urgency x exposure x classification factor.
        Exposure is 1.25 for incident reporting and data protection topics, and
        advisory gaps count half. Scores of 10+ are P1, 5+ are P2, the rest P3.

        The target date is the priority SLA, moved earlier to the effective date
        when that comes first. An owner comes from the first related control,
        then ``TOPIC_OWNERS``, then the Chief Compliance Officer.

        Args:
            gaps: Accepted gaps.
            obligations: Source obligations by id.
            today: Analysis date, used for urgency and target dates.

        Returns:
            Items sorted by score, then target date, then gap id, with ``rank`` set.
        """
        controls = controls_by_id()
        items: list[RemediationItem] = []
        for gap in gaps:
            ob = obligations.get(gap.obligation_id, {})
            effective = date.fromisoformat(ob["effective"]) if ob.get("effective") else None
            urgency, urgency_note = urgency_factor(effective, today)
            topics = ob.get("topics", [])
            exposure = 1.25 if {"incident reporting", "data protection"} & set(topics) else 1.0
            class_factor = 1.0 if gap.classification == "mandatory" else 0.5
            score = round(SEVERITY_WEIGHT[gap.severity] * urgency * exposure * class_factor, 2)
            priority = "P1" if score >= 10 else "P2" if score >= 5 else "P3"
            sla_date = today + timedelta(days=PRIORITY_SLA_DAYS[priority])
            target = min(sla_date, effective) if effective and effective > today else sla_date
            owner = next((controls[c]["owner"] for c in gap.related_control_ids if c in controls), None)
            owner = owner or next((o for t, o in TOPIC_OWNERS.items() if t in topics), "Chief Compliance Officer")
            actions = [gap.recommended_action or f"Address {gap.citation}"]
            actions.append("Update the control test procedure and collect implementation evidence.")
            if effective and effective <= today + timedelta(days=30):
                actions.append(f"Deadline-driven: requirement {urgency_note}; brief the compliance committee.")
            items.append(RemediationItem(
                gap_id=gap.id, rank=0, priority=priority, risk_score=score, title=gap.title,  # type: ignore[arg-type]
                citation=gap.citation, severity=gap.severity, owner=owner, target_date=target, actions=actions,
                score_breakdown={"severity_weight": SEVERITY_WEIGHT[gap.severity], "urgency": urgency,
                                 "exposure": exposure, "classification_factor": class_factor},
            ))
        items.sort(key=lambda r: (-r.risk_score, r.target_date, r.gap_id))
        for rank, item in enumerate(items, start=1):
            item.rank = rank
        return items

    def build_stats(self, state, gaps: list[GapProposal]) -> dict[str, Any]:
        """Compute the run statistics used by the report and dashboard.

        ``coverage_pct`` counts fully covered obligations only; partial coverage
        is reported separately so the headline figure is not inflated.
        """
        coverage = state.get("coverage", [])
        counts = {k: sum(1 for c in coverage if c["status"] == k) for k in ("covered", "partial", "gap")}
        decisions = state.get("validation_decisions", [])
        rejections = sum(1 for d in decisions if d["decision"] == "reject")
        return {
            "documents": len(state.get("documents", [])),
            "obligations": len(state.get("obligations", [])),
            "controls": len(load_control_library()["controls"]),
            **counts,
            "coverage_pct": round(100 * counts["covered"] / len(coverage), 1) if coverage else 0.0,
            "proposed_gaps": len(gaps),
            "accepted_gaps": sum(1 for g in gaps if g.status == "accepted"),
            "withdrawn_gaps": sum(1 for g in gaps if g.status == "withdrawn"),
            "escalated_gaps": sum(1 for g in gaps if g.status == "escalated"),
            "validation_rounds": state.get("validation_round", 0),
            "revision_cycles": state.get("revision_count", 0),
            "rejection_events": rejections,
            "feedback_loop_triggered": rejections > 0,
            "source_errors": len(state.get("source_errors", [])),
        }

    def run(self, state, buf: MessageBuffer) -> dict[str, Any]:
        """Build the plan, summary and report, then finish the run.

        The summary falls back to the demo template if the LLM fails or returns
        nothing usable, and records that source. A run therefore always gets a
        report, and readers can see how the summary was produced.

        Returns:
            State update with the plan, the report and ``status`` set to completed.
        """
        today = self.ctx.analysis_date
        gaps = [GapProposal.model_validate(g) for g in state.get("gaps", [])]
        obligations = {o["id"]: o for o in state.get("obligations", [])}
        accepted = [g for g in gaps if g.status == "accepted"]
        plan = self.prioritise(accepted, obligations, today)
        stats = self.build_stats(state, gaps)

        payload = {"stats": stats, "top_items": [p.model_dump(mode="json") for p in plan[:5]]}
        prompt = f"Facts (JSON):\n{json.dumps(payload, ensure_ascii=False, default=str)}\n\nReturn {{\"summary\": str}}"
        result, usage = self.call_llm("executive_summary", SYSTEM_SUMMARY, prompt, payload)
        if result is not None and isinstance(result.data.get("summary"), str) and result.data["summary"].strip():
            summary, summary_source = result.data["summary"].strip(), usage.reasoning_source
        else:
            from backend.llm.demo import DemoLLM  # deterministic template, same as demo mode
            summary = DemoLLM().complete_json("executive_summary", "", "", payload).data["summary"]
            summary_source = "rule-based-fallback"
            if result is None:
                buf.emit("orchestrator", "error", "Executive summary LLM call failed; used template",
                         {"error": usage.error}, llm=usage)

        mode = state.get("mode", "demo")
        reasoning_note = (
            "DEMO MODE: agent 'reasoning' was produced by the deterministic demo responder and rule-based "
            "agents over a SYNTHETIC dataset. The LangGraph orchestration, routing, validation checks and "
            "feedback loop executed for real."
            if mode == "demo" else
            f"LIVE MODE: LLM steps used {self.ctx.llm.provider}/{self.ctx.llm.model}; rule-based checks remain authoritative."
        )
        coverage_by_doc = []
        for doc in state.get("documents", []):
            items = [c for c in state.get("coverage", []) if c["obligation_id"].startswith(doc["id"] + ":")]
            coverage_by_doc.append({
                "document_id": doc["id"], "title": doc["title"], "regulator": doc["regulator"],
                "source": doc["source"], "synthetic": doc.get("synthetic", False),
                "obligations": len(items),
                **{k: sum(1 for c in items if c["status"] == k) for k in ("covered", "partial", "gap")},
            })
        rounds: dict[int, dict[str, Any]] = {}
        for d in state.get("validation_decisions", []):
            r = rounds.setdefault(d["round"], {"round": d["round"], "accepted": [], "rejected": []})
            r["accepted" if d["decision"] == "accept" else "rejected"].append(
                {"gap_id": d["gap_id"], "issues": [i["code"] for i in d["issues"] if i["severity"] == "blocking"]}
            )
        sources = [{"id": d["id"], "title": d["title"], "regulator": d["regulator"], "source": d["source"],
                    "url": d.get("url"), "synthetic": d.get("synthetic", False)} for d in state.get("documents", [])]
        disclaimers = list(DISCLAIMERS)
        if any(s["synthetic"] for s in sources):
            disclaimers.insert(0, "Contains SYNTHETIC demo regulations and a fictional organisation (Acme Pay). Not real regulatory text.")

        report = Report(
            run_id=self.ctx.run_id, generated_at=utcnow(), mode=mode, reasoning_note=reasoning_note,
            executive_summary=summary, executive_summary_source=summary_source, stats=stats,
            remediation_plan=plan, accepted_gaps=accepted,
            escalated_gaps=[g for g in gaps if g.status == "escalated"],
            withdrawn_gaps=[g for g in gaps if g.status == "withdrawn"],
            coverage_by_document=coverage_by_doc, validation_rounds=[rounds[k] for k in sorted(rounds)],
            sources=sources, disclaimers=disclaimers, markdown="",
        )
        report.markdown = render_markdown(report, state.get("source_errors", []))
        buf.emit(
            "orchestrator", "report",
            f"Final report: {stats['accepted_gaps']} accepted gap(s), {stats['escalated_gaps']} escalated, "
            f"{len([p for p in plan if p.priority == 'P1'])} P1 remediation item(s)",
            {"stats": stats, "remediation_preview": [
                {"rank": p.rank, "gap_id": p.gap_id, "priority": p.priority, "score": p.risk_score} for p in plan]},
            llm=usage if result is not None else None,
        )
        return {
            "remediation_plan": [p.model_dump(mode="json") for p in plan],
            "report": report.model_dump(mode="json"),
            "status": "completed",
        }


def _md_escape(text: str) -> str:
    """Make text safe for a Markdown table cell (pipes and newlines would break the row)."""
    return text.replace("|", "\\|").replace("\n", " ")


def render_markdown(r: Report, source_errors: list[str]) -> str:
    """Render the report as the Markdown document shown and downloaded by users.

    Args:
        r: Completed report model.
        source_errors: Retrieval failures, listed so missing sources stay visible.

    Returns:
        Complete Markdown text.
    """
    s = r.stats
    out = [
        f"# RegRadar Compliance Gap Report - run `{r.run_id}`",
        "",
        f"*Generated {r.generated_at:%Y-%m-%d %H:%M UTC} - mode: **{r.mode.upper()}***",
        "",
        f"> {r.reasoning_note}",
        "",
        "## Executive summary",
        "",
        r.executive_summary,
        "",
        f"*Summary source: {r.executive_summary_source}*",
        "",
        "## Key figures",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Documents analysed | {s['documents']} |",
        f"| Obligations extracted | {s['obligations']} |",
        f"| Covered / partial / gap | {s['covered']} / {s['partial']} / {s['gap']} |",
        f"| Fully covered | {s['coverage_pct']}% |",
        f"| Gaps accepted / withdrawn / escalated | {s['accepted_gaps']} / {s['withdrawn_gaps']} / {s['escalated_gaps']} |",
        f"| Validation rounds / revision cycles | {s['validation_rounds']} / {s['revision_cycles']} |",
        "",
        "## Prioritised remediation plan",
        "",
        "| # | Priority | Gap | Citation | Severity | Owner | Target | Score |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for p in r.remediation_plan:
        out.append(f"| {p.rank} | {p.priority} | {p.gap_id}: {_md_escape(p.title)} | {p.citation} | {p.severity} | "
                   f"{p.owner} | {p.target_date} | {p.risk_score} |")
    if not r.remediation_plan:
        out.append("| - | - | No accepted gaps | - | - | - | - | - |")
    out += ["", "## Accepted gaps", ""]
    for g in r.accepted_gaps:
        out += [
            f"### {g.id} - {g.title}",
            "",
            f"- **Citation:** {g.citation}  ",
            f"- **Type / severity / classification:** {g.gap_type} / {g.severity} / {g.classification}  ",
            f"- **Evidence:** \"{g.evidence_quote}\"  ",
            f"- **Related controls:** {', '.join(g.related_control_ids) or 'none'}  ",
            f"- **Recommended action:** {g.recommended_action}  ",
            f"- **Revisions:** {g.revision}" + (f" - {g.response_to_feedback}" if g.response_to_feedback else ""),
            "",
            g.description,
            "",
        ]
    out += ["## Escalated for human review", ""]
    if r.escalated_gaps:
        for g in r.escalated_gaps:
            out.append(f"- **{g.id}** ({g.citation}) {g.title} - synthesiser's position: {g.response_to_feedback or 'n/a'}")
    else:
        out.append("None.")
    out += ["", "## Withdrawn after validation", ""]
    if r.withdrawn_gaps:
        for g in r.withdrawn_gaps:
            ki = f" (tracked as {g.known_issue_id})" if g.known_issue_id else ""
            out.append(f"- **{g.id}** ({g.citation}) {g.title}{ki} - {g.response_to_feedback}")
    else:
        out.append("None.")
    out += ["", "## Validation rounds", ""]
    for rnd in r.validation_rounds:
        rej = ", ".join(f"{x['gap_id']} ({', '.join(x['issues'])})" for x in rnd["rejected"]) or "none"
        out.append(f"- Round {rnd['round']}: accepted {len(rnd['accepted'])}; rejected: {rej}")
    out += ["", "## Coverage by document", "", "| Document | Regulator | Source | Obligations | Covered | Partial | Gap |", "|---|---|---|---|---|---|---|"]
    for c in r.coverage_by_document:
        tag = " (synthetic)" if c["synthetic"] else ""
        out.append(f"| {c['document_id']}: {_md_escape(c['title'])} | {c['regulator']} | {c['source']}{tag} | "
                   f"{c['obligations']} | {c['covered']} | {c['partial']} | {c['gap']} |")
    out += ["", "## Sources", ""]
    for src in r.sources:
        out.append(f"- {src['id']} - {src['title']} ({src['regulator']}, {src['source']})" + (f" <{src['url']}>" if src.get("url") else ""))
    if source_errors:
        out += ["", "### Source errors", ""] + [f"- {e}" for e in source_errors]
    out += ["", "## Disclaimers", ""] + [f"- {d}" for d in r.disclaimers] + [""]
    return "\n".join(out)
