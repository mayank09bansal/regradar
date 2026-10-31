"""Unit tests for individual agents (run as plain callables on shared state)."""

from __future__ import annotations

import pytest

from backend.agents.control_mapper import ControlMapper
from backend.agents.novelty_validator import NoveltyValidator
from backend.agents.obligation_extractor import ObligationExtractor
from backend.agents.output_agent import OutputAgent, urgency_factor
from backend.agents.policy import minimum_severity
from backend.agents.regulatory_scout import RegulatoryScout
from backend.llm.demo import DemoLLM
from backend.orchestration.state import RunContext
from backend.schemas import GapProposal

from .conftest import ANALYSIS_DATE


def _apply(state, update):
    for k, v in update.items():
        if k in ("trace", "errors", "route_history"):
            state[k] = state.get(k, []) + v
        else:
            state[k] = v


@pytest.fixture
def ctx(settings):
    return RunContext(run_id="test-run", settings=settings, llm=DemoLLM(), analysis_date=ANALYSIS_DATE)


@pytest.fixture
def mapped_state(ctx):
    state = {"request": {"mode": "demo"}, "trace": [], "max_revisions": 2}
    for agent in (RegulatoryScout, ObligationExtractor, ControlMapper):
        _apply(state, agent(ctx)(state))
    return state


def test_scout_loads_only_synthetic_docs_in_demo(ctx):
    update = RegulatoryScout(ctx)({"request": {"mode": "demo"}, "trace": []})
    assert len(update["documents"]) == 3
    assert all(d["synthetic"] and d["source"] == "synthetic-demo" for d in update["documents"])
    assert update["trace"][0]["sender"] == "regulatory_scout"
    assert update["trace"][0]["recipient"] == "obligation_extractor"


def test_scout_regulator_filter(ctx):
    update = RegulatoryScout(ctx)({"request": {"mode": "demo", "regulators": ["MEITY"]}, "trace": []})
    assert [d["regulator"] for d in update["documents"]] == ["MEITY"]


def test_extractor_finds_obligations_and_strengths(mapped_state):
    obs = {o["citation"]: o for o in mapped_state["obligations"]}
    assert len(obs) == 16  # 19 clauses minus 3 background clauses
    assert obs["RBI-DEMO-2026-014 §3.1"]["parameters"]["deadline_hours"] == 6
    assert obs["RBI-DEMO-2026-014 §3.7"]["strength"] == "recommended"
    assert obs["RBI-DEMO-2026-021 §4.4"]["strength"] == "permissive"
    assert "RBI-DEMO-2026-014 §1.1" not in obs


def test_mapper_detects_coverage_and_shortfalls(mapped_state):
    cov = {c["citation"]: c for c in mapped_state["coverage"]}
    assert cov["RBI-DEMO-2026-014 §3.2"]["status"] == "covered"
    assert cov["RBI-DEMO-2026-014 §3.2"]["best_control_id"] == "CTRL-IAM-02"
    assert cov["RBI-DEMO-2026-014 §3.1"]["status"] == "partial"
    assert "24h" in cov["RBI-DEMO-2026-014 §3.1"]["shortfalls"][0]
    assert "90 days" in cov["RBI-DEMO-2026-014 §3.4"]["shortfalls"][0]
    assert cov["MEITY-DEMO-2026-03 §2.3"]["status"] == "gap"
    assert cov["MEITY-DEMO-2026-03 §2.3"]["best_control_id"] is None


def test_minimum_severity_rules(mapped_state):
    obs = {o["citation"]: o for o in mapped_state["obligations"]}
    assert minimum_severity(obs["RBI-DEMO-2026-014 §3.1"])[0] == "critical"
    assert minimum_severity(obs["MEITY-DEMO-2026-03 §2.3"])[0] == "high"
    assert minimum_severity(obs["RBI-DEMO-2026-014 §3.7"])[0] == "low"


def _gap(ob, **kw):
    base = dict(
        id="GAP-X", obligation_id=ob["id"], citation=ob["citation"], title="A sufficiently long title",
        description="A description that is comfortably longer than forty characters.", gap_type="scope_gap",
        severity="critical", classification="mandatory", evidence_quote=ob["text"],
        recommended_action="Implement a specific control with evidence.", status="proposed",
    )
    base.update(kw)
    return GapProposal(**base)


@pytest.mark.parametrize(
    "citation,overrides,expected_code",
    [
        ("RBI-DEMO-2026-014 §3.1", {"severity": "low"}, "severity_understated"),
        ("RBI-DEMO-2026-014 §3.1", {"evidence_quote": "Report incidents quickly to the regulator please."}, "evidence_not_grounded"),
        ("RBI-DEMO-2026-014 §3.1", {"citation": "RBI-DEMO-2026-014 §9.9"}, "citation_mismatch"),
        ("RBI-DEMO-2026-014 §3.1", {"description": "short"}, "insufficient_detail"),
        ("RBI-DEMO-2026-014 §3.2", {}, "already_covered"),
        ("RBI-DEMO-2026-014 §3.3", {}, "already_tracked"),
        ("RBI-DEMO-2026-014 §3.7", {"severity": "low"}, "non_mandatory_obligation"),
    ],
)
def test_validator_checks(ctx, mapped_state, citation, overrides, expected_code):
    ob = next(o for o in mapped_state["obligations"] if o["citation"] == citation)
    obligations = {o["id"]: o for o in mapped_state["obligations"]}
    coverage = {c["obligation_id"]: c for c in mapped_state["coverage"]}
    issues = NoveltyValidator(ctx).check_gap(_gap(ob, **overrides), obligations, coverage, {})
    codes = {i.code for i in issues}
    assert expected_code in codes
    issue = next(i for i in issues if i.code == expected_code)
    assert issue.message  # structured, human-readable feedback


def test_validator_accepts_well_formed_gap(ctx, mapped_state):
    ob = next(o for o in mapped_state["obligations"] if o["citation"] == "MEITY-DEMO-2026-03 §2.3")
    issues = NoveltyValidator(ctx).check_gap(
        _gap(ob, severity="high"),
        {o["id"]: o for o in mapped_state["obligations"]},
        {c["obligation_id"]: c for c in mapped_state["coverage"]},
        {},
    )
    assert issues == []


def test_validator_flags_duplicates(ctx, mapped_state):
    ob = next(o for o in mapped_state["obligations"] if o["citation"] == "MEITY-DEMO-2026-03 §2.3")
    issues = NoveltyValidator(ctx).check_gap(
        _gap(ob, id="GAP-B", severity="high"),
        {o["id"]: o for o in mapped_state["obligations"]},
        {c["obligation_id"]: c for c in mapped_state["coverage"]},
        {ob["id"]: "GAP-A"},
    )
    assert [i.code for i in issues] == ["duplicate_proposal"]


def test_urgency_factor():
    assert urgency_factor(None, ANALYSIS_DATE)[0] == 1.1
    assert urgency_factor(ANALYSIS_DATE, ANALYSIS_DATE)[0] == 1.6


def test_output_agent_prioritises_by_risk(ctx, mapped_state):
    obs = {o["citation"]: o for o in mapped_state["obligations"]}
    critical = _gap(obs["RBI-DEMO-2026-014 §3.1"], id="GAP-1", status="accepted")
    advisory = _gap(obs["RBI-DEMO-2026-014 §3.7"], id="GAP-2", status="accepted", severity="low", classification="advisory")
    plan = OutputAgent(ctx).prioritise([advisory, critical], {o["id"]: o for o in mapped_state["obligations"]}, ANALYSIS_DATE)
    assert [p.gap_id for p in plan] == ["GAP-1", "GAP-2"]
    assert plan[0].priority == "P1" and plan[1].priority == "P3"
    assert plan[0].owner == "CISO"
    assert plan[0].target_date <= ANALYSIS_DATE.replace(month=11, day=15)
