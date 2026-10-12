"""LangGraph definition: six agents, conditional routing, revision loop and escalation.

    START -> regulatory_scout --(documents?)--> obligation_extractor -> control_mapper
          -> gap_synthesiser -> novelty_validator --(route_after_validation)-->
               "revise"   -> gap_synthesiser   (feedback loop, bounded by max_revisions)
               "escalate" -> escalation -> output_agent
               "finalise" -> output_agent
    regulatory_scout --(no documents)--> output_agent
    output_agent -> END
"""

from __future__ import annotations

from typing import Any

from langgraph.graph import END, START, StateGraph

from backend.agents.base import MessageBuffer
from backend.agents.control_mapper import ControlMapper
from backend.agents.gap_synthesiser import GapSynthesiser
from backend.agents.novelty_validator import NoveltyValidator
from backend.agents.obligation_extractor import ObligationExtractor
from backend.agents.output_agent import OutputAgent
from backend.agents.regulatory_scout import RegulatoryScout
from backend.orchestration.state import RegRadarState, RunContext


def route_after_scout(state: RegRadarState) -> str:
    """Skip straight to the report when no documents were retrieved."""
    return "extract" if state.get("documents") else "no_documents"


def route_after_validation(state: RegRadarState) -> str:
    """The adaptive feedback-loop decision."""
    rejected = [g for g in state.get("gaps", []) if g["status"] == "rejected"]
    if not rejected:
        return "finalise"
    if state.get("revision_count", 0) < state.get("max_revisions", 2):
        return "revise"
    return "escalate"


def make_escalation_node(ctx: RunContext):
    """Create the node that hands unresolved gaps to a human.

    Runs only when gaps are still rejected at the revision limit. Each becomes
    "escalated" and is reported with the validator's last objection and the
    synthesiser's position, so a reviewer sees both sides of the disagreement.
    """
    def escalation(state: RegRadarState) -> dict[str, Any]:
        buf = MessageBuffer(state, ctx, "orchestrator")
        gaps = [dict(g) for g in state.get("gaps", [])]
        feedback = {f["gap_id"]: f for f in state.get("pending_feedback", [])}
        escalated = []
        for g in gaps:
            if g["status"] == "rejected":
                g["status"] = "escalated"
                escalated.append(g["id"])
                fb = feedback.get(g["id"], {})
                buf.emit(
                    "human_reviewer", "escalation",
                    f"ESCALATE {g['id']}: unresolved after {state.get('revision_count', 0)} revision(s) - "
                    + "; ".join(i["code"] for i in fb.get("issues", [])),
                    {"gap": g, "last_feedback": fb, "synthesiser_position": g.get("response_to_feedback", "")},
                    revision_round=state.get("revision_count", 0),
                )
        buf.emit("output_agent", "info", f"{len(escalated)} gap(s) escalated for human review; continuing to report",
                 {"escalated": escalated})
        return {"gaps": gaps, "pending_feedback": [], "trace": buf.messages, "route_history": ["escalation"]}

    return escalation


def build_graph(ctx: RunContext):
    """Compile the pipeline, with ``ctx`` bound into each node.

    A fresh graph per run keeps per-run objects out of shared module state.
    """
    graph = StateGraph(RegRadarState)
    graph.add_node("regulatory_scout", RegulatoryScout(ctx))
    graph.add_node("obligation_extractor", ObligationExtractor(ctx))
    graph.add_node("control_mapper", ControlMapper(ctx))
    graph.add_node("gap_synthesiser", GapSynthesiser(ctx))
    graph.add_node("novelty_validator", NoveltyValidator(ctx))
    graph.add_node("escalation", make_escalation_node(ctx))
    graph.add_node("output_agent", OutputAgent(ctx))

    graph.add_edge(START, "regulatory_scout")
    graph.add_conditional_edges(
        "regulatory_scout", route_after_scout, {"extract": "obligation_extractor", "no_documents": "output_agent"}
    )
    graph.add_edge("obligation_extractor", "control_mapper")
    graph.add_edge("control_mapper", "gap_synthesiser")
    graph.add_edge("gap_synthesiser", "novelty_validator")
    graph.add_conditional_edges(
        "novelty_validator",
        route_after_validation,
        {"revise": "gap_synthesiser", "escalate": "escalation", "finalise": "output_agent"},
    )
    graph.add_edge("escalation", "output_agent")
    graph.add_edge("output_agent", END)
    return graph.compile()


# Static description for /api/graph and the Architecture page. Keep in step with build_graph.
GRAPH_SPEC = {
    "nodes": [
        {"id": "regulatory_scout", "label": "Regulatory Scout", "kind": "agent"},
        {"id": "obligation_extractor", "label": "Obligation Extractor", "kind": "agent"},
        {"id": "control_mapper", "label": "Control Mapper", "kind": "agent"},
        {"id": "gap_synthesiser", "label": "Gap Synthesiser", "kind": "agent"},
        {"id": "novelty_validator", "label": "Novelty Validator", "kind": "agent"},
        {"id": "escalation", "label": "Escalation", "kind": "control"},
        {"id": "output_agent", "label": "Output Agent", "kind": "agent"},
    ],
    "edges": [
        {"from": "START", "to": "regulatory_scout"},
        {"from": "regulatory_scout", "to": "obligation_extractor", "condition": "documents found"},
        {"from": "regulatory_scout", "to": "output_agent", "condition": "no documents"},
        {"from": "obligation_extractor", "to": "control_mapper"},
        {"from": "control_mapper", "to": "gap_synthesiser"},
        {"from": "gap_synthesiser", "to": "novelty_validator"},
        {"from": "novelty_validator", "to": "gap_synthesiser", "condition": "revise: rejections and revisions < max"},
        {"from": "novelty_validator", "to": "escalation", "condition": "escalate: rejections at max revisions"},
        {"from": "novelty_validator", "to": "output_agent", "condition": "finalise: no rejections"},
        {"from": "escalation", "to": "output_agent"},
        {"from": "output_agent", "to": "END"},
    ],
}
