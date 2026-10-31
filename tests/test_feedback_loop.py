"""Orchestration tests proving the Gap Synthesiser <-> Novelty Validator feedback loop.

These run the real compiled LangGraph graph end to end and inspect the
persisted execution trace, gap histories and validator decisions.
"""

from __future__ import annotations

from typing import Any

from backend.agents.policy import draft_gap_fields
from backend.llm.base import LLMError, LLMResult
from backend.orchestration.graph import route_after_validation
from backend.orchestration.runner import run_analysis
from backend.schemas import AnalysisRequest

from .conftest import ANALYSIS_DATE


def _demo(settings, db, **kw):
    return run_analysis(AnalysisRequest(mode="demo", analysis_date=ANALYSIS_DATE, **kw), settings, db)


def _gap_by_citation(detail, citation):
    return next(g for g in detail["result"]["gaps"] if g["citation"] == citation)


def test_demo_run_completes_through_graph(settings, db):
    detail = _demo(settings, db)
    assert detail["status"] == "completed", detail["error"]
    route = detail["result"]["route_history"]
    assert route[:4] == ["regulatory_scout", "obligation_extractor", "control_mapper", "gap_synthesiser"]
    assert route[-1] == "output_agent"
    # loop executed: synthesiser and validator each ran more than once
    assert route.count("gap_synthesiser") == 3
    assert route.count("novelty_validator") == 3
    assert "escalation" in route


def test_rejection_feedback_revision_and_revalidation_sequence(settings, db):
    """The core proof: propose -> reject with structured feedback -> feedback via state -> revise -> re-validate -> accept."""
    detail = _demo(settings, db)
    trace = db.get_trace(detail["id"])
    gap = _gap_by_citation(detail, "RBI-DEMO-2026-014 §3.1")
    gid = gap["id"]

    def idx(pred):
        return next(i for i, m in enumerate(trace) if pred(m))

    # 1. Gap Synthesiser proposes the gap
    i_prop = idx(lambda m: m["message_type"] == "proposal" and m["payload"]["gap"]["id"] == gid)
    assert trace[i_prop]["sender"] == "gap_synthesiser"
    assert trace[i_prop]["payload"]["gap"]["severity"] == "low"

    # 2-3. Novelty Validator rejects it with structured feedback addressed to the synthesiser
    i_rej = idx(lambda m: m["message_type"] == "feedback" and m["payload"]["decision"]["gap_id"] == gid)
    rej = trace[i_rej]
    assert rej["sender"] == "novelty_validator" and rej["recipient"] == "gap_synthesiser"
    decision = rej["payload"]["decision"]
    assert decision["decision"] == "reject" and decision["round"] == 1
    issue = next(i for i in decision["issues"] if i["code"] == "severity_understated")
    assert issue["expected"] == "critical" and issue["field"] == "severity"

    # 4. Synthesiser acknowledges receipt of that feedback from shared state
    i_ack = idx(lambda m: m["sender"] == "gap_synthesiser" and m["message_type"] == "info"
                and any(f["gap_id"] == gid for f in m["payload"]["feedback"]))
    received = next(f for f in trace[i_ack]["payload"]["feedback"] if f["gap_id"] == gid)
    assert received["issues"] == decision["issues"]  # identical structured feedback transferred

    # 5. Synthesiser revises the gap, changing exactly what the validator asked for
    i_rev = idx(lambda m: m["message_type"] == "revision" and m["payload"]["gap_id"] == gid)
    rev = trace[i_rev]
    assert rev["payload"]["action"] == "revised"
    assert rev["payload"]["changes"]["severity"] == {"from": "low", "to": "critical"}
    assert rev["revision_round"] == 1

    # 6-7. Validator runs again on the revised gap and accepts it
    i_acc = idx(lambda m: m["message_type"] == "decision" and m["payload"]["decision"]["gap_id"] == gid)
    acc = trace[i_acc]["payload"]["decision"]
    assert acc["decision"] == "accept" and acc["round"] == 2 and acc["gap_revision"] == 1

    # 8. Output Agent produces the final report afterwards, including the accepted revised gap
    i_report = idx(lambda m: m["message_type"] == "report")
    assert trace[i_report]["sender"] == "output_agent"
    assert i_prop < i_rej < i_ack < i_rev < i_acc < i_report
    report = detail["result"]["report"]
    assert gid in [g["id"] for g in report["accepted_gaps"]]
    assert gap["status"] == "accepted" and gap["severity"] == "critical" and gap["revision"] == 1
    assert [h["action"] for h in gap["history"]] == ["proposed", "revised"]


def test_withdrawals_and_escalation(settings, db):
    detail = _demo(settings, db)
    covered = _gap_by_citation(detail, "RBI-DEMO-2026-014 §3.2")
    tracked = _gap_by_citation(detail, "RBI-DEMO-2026-014 §3.3")
    contested = _gap_by_citation(detail, "RBI-DEMO-2026-014 §3.7")
    grounded = _gap_by_citation(detail, "RBI-DEMO-2026-014 §3.4")
    assert covered["status"] == "withdrawn"
    assert tracked["status"] == "withdrawn" and tracked["known_issue_id"] == "KI-2026-011"
    assert grounded["status"] == "accepted" and grounded["evidence_quote"].startswith("System and security logs")
    # contested gap rejected in every round, then escalated at the revision limit
    assert contested["status"] == "escalated"
    rounds = [d for d in detail["result"]["validation_decisions"] if d["gap_id"] == contested["id"]]
    assert [d["decision"] for d in rounds] == ["reject", "reject", "reject"]
    trace = db.get_trace(detail["id"])
    esc = [m for m in trace if m["message_type"] == "escalation"]
    assert len(esc) == 1 and esc[0]["recipient"] == "human_reviewer"
    stats = detail["stats"]
    assert stats["accepted_gaps"] == 9 and stats["withdrawn_gaps"] == 2 and stats["escalated_gaps"] == 1
    assert stats["validation_rounds"] == 3 and stats["revision_cycles"] == 2 and stats["feedback_loop_triggered"]


def test_max_revisions_zero_escalates_immediately(settings, db):
    detail = _demo(settings, db, max_revisions=0)
    route = detail["result"]["route_history"]
    assert route.count("gap_synthesiser") == 1 and route.count("novelty_validator") == 1
    assert detail["stats"]["escalated_gaps"] == 5
    assert detail["stats"]["revision_cycles"] == 0


def test_router_decisions():
    gaps_rejected = [{"status": "rejected"}]
    assert route_after_validation({"gaps": [{"status": "accepted"}]}) == "finalise"
    assert route_after_validation({"gaps": gaps_rejected, "revision_count": 0, "max_revisions": 2}) == "revise"
    assert route_after_validation({"gaps": gaps_rejected, "revision_count": 2, "max_revisions": 2}) == "escalate"


def test_trace_is_ordered_and_persisted(settings, db):
    detail = _demo(settings, db)
    trace = db.get_trace(detail["id"])
    assert [m["seq"] for m in trace] == list(range(1, len(trace) + 1))
    assert trace[0]["sender"] == "orchestrator" and trace[0]["message_type"] == "task"
    senders = {m["sender"] for m in trace}
    assert {"regulatory_scout", "obligation_extractor", "control_mapper", "gap_synthesiser",
            "novelty_validator", "output_agent"} <= senders
    # every demo LLM-backed message is explicitly labelled as deterministic demo behaviour
    labelled = [m for m in trace if m.get("llm")]
    assert labelled and all(m["llm"]["reasoning_source"] == "deterministic-demo" for m in labelled)
    assert detail["result"]["report"]["reasoning_note"].startswith("DEMO MODE")


class ScriptedLLM:
    """A fake 'live' LLM, independent of the demo responder, that records what it receives."""

    provider = "scripted"
    model = "scripted-test-model"
    is_live = True

    def __init__(self):
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def complete_json(self, task, system, prompt, payload):
        self.calls.append((task, payload))
        if task == "extract_obligations":
            raise LLMError("extraction disabled in this test")  # forces rule-based fallback
        if task == "synthesise_gaps":
            controls = {c["id"]: c for c in payload["controls"]}
            obligations = {o["id"]: o for o in payload["obligations"]}
            gaps = []
            for item in payload["coverage"]:
                if item["citation"] == "MEITY-DEMO-2026-03 §2.3":
                    g = draft_gap_fields(item, obligations[item["obligation_id"]], controls)
                    g["citation"] = "MEITY-DEMO-2026-03 §2.9"  # wrong citation on purpose
                    gaps.append(g)
            data = {"gaps": gaps}
        elif task == "revise_gaps":
            data = {"revisions": [
                {"gap_id": r["gap"]["id"], "action": "revise",
                 "changes": {"citation": next(i["expected"] for i in r["issues"] if i["code"] == "citation_mismatch")},
                 "response_to_feedback": "Fixed citation per validator."}
                for r in payload["rejected"]
            ]}
        elif task == "critique_gaps":
            data = {"reviews": [{"gap_id": g["gap_id"], "actionable": True, "note": "ok"} for g in payload["gaps"]]}
        else:
            data = {"summary": "Scripted summary."}
        return LLMResult(data=data, provider=self.provider, model=self.model,
                         reasoning_source=f"llm:{self.provider}/{self.model}")


def test_feedback_reaches_synthesiser_llm_through_state(settings, db):
    """With a non-demo LLM: the revise call receives the validator's issues, and the fix is re-validated."""
    llm = ScriptedLLM()
    detail = run_analysis(
        AnalysisRequest(mode="demo", analysis_date=ANALYSIS_DATE), settings, db, llm=llm
    )
    assert detail["status"] == "completed", detail["error"]
    revise_calls = [p for t, p in llm.calls if t == "revise_gaps"]
    assert len(revise_calls) == 1
    entry = revise_calls[0]["rejected"][0]
    assert entry["issues"][0]["code"] == "citation_mismatch"
    assert entry["issues"][0]["expected"] == "MEITY-DEMO-2026-03 §2.3"
    gap = detail["result"]["gaps"][0]
    assert gap["status"] == "accepted" and gap["citation"] == "MEITY-DEMO-2026-03 §2.3"
    assert gap["reasoning_source"] == "llm:scripted/scripted-test-model"
    assert detail["result"]["report"]["executive_summary"] == "Scripted summary."


class FailingLLM(ScriptedLLM):
    def complete_json(self, task, system, prompt, payload):
        raise LLMError("simulated provider outage")


def test_llm_failure_falls_back_and_is_reported(settings, db):
    detail = run_analysis(AnalysisRequest(mode="demo", analysis_date=ANALYSIS_DATE), settings, db, llm=FailingLLM())
    assert detail["status"] == "completed"
    trace = db.get_trace(detail["id"])
    errors = [m for m in trace if m["message_type"] == "error"]
    assert any("using deterministic templates" in m["summary"] for m in errors)
    assert all(m["llm"]["fallback"] for m in errors if m.get("llm"))
    assert detail["result"]["report"]["executive_summary_source"] == "rule-based-fallback"
    # template drafts are well-formed, so they pass validation without the scripted demo mistakes
    assert detail["stats"]["accepted_gaps"] >= 1
