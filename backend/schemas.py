"""Pydantic schemas for API input, shared agent data, agent messages and output.

These models are the contract between agents (via LangGraph shared state),
between backend and frontend (via the REST API) and for persisted traces.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

# How binding an obligation is, derived from its modal verb (shall / should / may).
Strength = Literal["mandatory", "recommended", "permissive"]
# Control Mapper verdict for one obligation.
CoverageStatus = Literal["covered", "partial", "gap"]
# Ordered by SEVERITY_ORDER; the validator enforces a minimum per obligation.
Severity = Literal["low", "medium", "high", "critical"]
# Kind of shortfall, chosen in agents/policy.py draft_gap_fields.
GapType = Literal["missing_control", "parameter_shortfall", "scope_gap", "governance_gap"]
# Lifecycle: proposed -> rejected -> revised -> accepted, or withdrawn / escalated.
GapStatus = Literal["proposed", "revised", "accepted", "rejected", "withdrawn", "escalated"]
# Novelty Validator verdict for one gap in one round.
Decision = Literal["accept", "reject"]
# Category of a trace message; the dashboard filters and colours by it.
MessageType = Literal[
    "task", "result", "proposal", "feedback", "revision", "decision", "escalation", "report", "error", "info"
]

# Numeric rank, so severities can be compared with max() and <.
SEVERITY_ORDER: dict[str, int] = {"low": 0, "medium": 1, "high": 2, "critical": 3}

# Graph node names, in pipeline order.
AGENT_NAMES = (
    "regulatory_scout",
    "obligation_extractor",
    "control_mapper",
    "gap_synthesiser",
    "novelty_validator",
    "output_agent",
)


def utcnow() -> datetime:
    return datetime.now(UTC)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------- input
class InputDocument(_Model):
    """A regulatory document supplied by the user (pasted circular text)."""

    title: str = Field(min_length=3, max_length=300)
    regulator: str = Field(min_length=2, max_length=40)
    text: str = Field(min_length=50, max_length=100_000)
    # Citation prefix for obligations; generated when omitted.
    reference_id: str | None = Field(default=None, max_length=80)
    url: str | None = Field(default=None, max_length=500)
    effective_date: date | None = None

    @field_validator("regulator")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.strip().upper()


class AnalysisRequest(_Model):
    mode: Literal["demo", "live"] = "demo"
    # Demo mode filters the dataset; live mode filters which RSS feeds are read.
    regulators: list[str] = Field(default_factory=list, description="Optional regulator filter, e.g. ['RBI']")
    include_live_feeds: bool = Field(default=False, description="Live mode: fetch RBI/SEBI RSS feeds")
    documents: list[InputDocument] = Field(default_factory=list, max_length=10)
    # None uses the MAX_REVISIONS setting; 0 escalates every first-round rejection.
    max_revisions: int | None = Field(default=None, ge=0, le=5)
    notify: bool = Field(default=False, description="Send Slack/n8n notification when finished")
    analysis_date: date | None = Field(default=None, description="Override 'today' (used for prioritisation)")

    @field_validator("regulators")
    @classmethod
    def _norm_regs(cls, v: list[str]) -> list[str]:
        return sorted({r.strip().upper() for r in v if r.strip()})

    @model_validator(mode="after")
    def _live_needs_input(self) -> AnalysisRequest:
        if self.mode == "live" and not self.documents and not self.include_live_feeds:
            raise ValueError("Live mode needs at least one pasted document or include_live_feeds=true")
        return self


# ------------------------------------------------------------------- agent data
class Clause(_Model):
    ref: str
    text: str


class RegulatoryDocument(_Model):
    id: str
    regulator: str
    title: str
    issued: date | None = None
    effective: date | None = None
    url: str | None = None
    # Where the text came from, so synthetic content is never mistaken for a real circular.
    source: Literal["synthetic-demo", "user-upload", "live-rss"]
    synthetic: bool = False
    themes: list[str] = Field(default_factory=list)
    clauses: list[Clause] = Field(default_factory=list)
    # Share of tokens matching company interests (0 to 1).
    relevance_score: float = 0.0


class ObligationParameters(_Model):
    # Quantities parsed from the sentence, compared with control parameters for shortfalls.
    deadline_hours: float | None = None
    retention_days: float | None = None
    frequency: str | None = None
    frequency_per_year: float | None = None


class Obligation(_Model):
    id: str
    document_id: str
    regulator: str
    clause_ref: str
    # Must match a gap's citation exactly (citation_consistency check).
    citation: str
    text: str
    strength: Strength
    # The exact phrase that set ``strength``, quoted back in validator feedback.
    modal: str
    parameters: ObligationParameters = Field(default_factory=ObligationParameters)
    topics: list[str] = Field(default_factory=list)
    effective: date | None = None
    # 'rule-based' or 'llm:<provider>'.
    extraction_method: str = "rule-based"


class ControlCandidate(_Model):
    control_id: str
    title: str
    score: float


class CoverageItem(_Model):
    obligation_id: str
    citation: str
    regulator: str
    obligation_text: str
    strength: Strength
    status: CoverageStatus
    best_control_id: str | None = None
    best_control_title: str | None = None
    # Blended score of the best control, kept even when the status is gap.
    similarity: float = 0.0
    # Top three controls, so a reviewer can challenge the match.
    candidates: list[ControlCandidate] = Field(default_factory=list)
    # Readable parameter mismatches, e.g. a 72h control against a 6h rule.
    shortfalls: list[str] = Field(default_factory=list)
    rationale: str = ""


class GapRevisionRecord(_Model):
    revision: int
    action: Literal["proposed", "revised", "withdrawn", "maintained"]
    # Field name to {'from': old, 'to': new}, shown on the Feedback Loop page.
    changes: dict[str, Any] = Field(default_factory=dict)
    response_to_feedback: str = ""
    reasoning_source: str = ""


class GapProposal(_Model):
    id: str
    obligation_id: str
    citation: str
    title: str
    description: str
    gap_type: GapType
    severity: Severity
    classification: Literal["mandatory", "advisory"] = "mandatory"
    # Must be verbatim from the obligation (evidence_grounding check).
    evidence_quote: str = ""
    related_control_ids: list[str] = Field(default_factory=list)
    recommended_action: str = ""
    status: GapStatus = "proposed"
    # Revision cycle that last changed this gap; 0 is the original draft.
    revision: int = 0
    # Set when withdrawn because the known-issues register already tracks it.
    known_issue_id: str | None = None
    response_to_feedback: str = ""
    reasoning_source: str = ""
    # Append-only record of every action taken on the gap.
    history: list[GapRevisionRecord] = Field(default_factory=list)


class ValidationIssue(_Model):
    code: str
    message: str
    # Only blocking issues cause a rejection.
    severity: Literal["blocking", "advisory"] = "blocking"
    # Gap field at fault, with ``expected`` giving the value that would pass.
    field: str | None = None
    expected: Any = None


class ValidationDecision(_Model):
    gap_id: str
    round: int
    gap_revision: int
    decision: Decision
    issues: list[ValidationIssue] = Field(default_factory=list)
    checks_run: list[str] = Field(default_factory=list)
    reasoning_source: str = "rule-based"
    llm_notes: str = ""


class RemediationItem(_Model):
    gap_id: str
    rank: int
    priority: Literal["P1", "P2", "P3"]
    # severity weight x urgency x exposure x classification factor.
    risk_score: float
    title: str
    citation: str
    severity: Severity
    owner: str
    target_date: date
    actions: list[str]
    # The factors behind risk_score, displayed on the Remediation page.
    score_breakdown: dict[str, float] = Field(default_factory=dict)


# ------------------------------------------------------------------- messages
class LLMUsage(_Model):
    provider: str
    model: str
    reasoning_source: str
    # True when the LLM failed and rule-based logic produced the result.
    fallback: bool = False
    error: str | None = None


class AgentMessage(_Model):
    """One message on the agent bus, persisted as part of the execution trace."""

    id: str
    run_id: str
    # Position across the whole run; messages are read back in this order.
    seq: int
    timestamp: datetime
    sender: str
    recipient: str
    message_type: MessageType
    summary: str
    payload: dict[str, Any] = Field(default_factory=dict)
    # Feedback-loop cycle, 0 outside the loop.
    revision_round: int = 0
    duration_ms: float | None = None
    llm: LLMUsage | None = None


# ------------------------------------------------------------------- output
class Report(_Model):
    run_id: str
    generated_at: datetime
    mode: str
    reasoning_note: str
    executive_summary: str
    # Records whether a model or the fallback template wrote the summary.
    executive_summary_source: str
    stats: dict[str, Any]
    remediation_plan: list[RemediationItem]
    accepted_gaps: list[GapProposal]
    escalated_gaps: list[GapProposal]
    withdrawn_gaps: list[GapProposal]
    coverage_by_document: list[dict[str, Any]]
    validation_rounds: list[dict[str, Any]]
    sources: list[dict[str, Any]]
    disclaimers: list[str]
    # Rendered from the other fields by output_agent.render_markdown.
    markdown: str


class RunSummary(BaseModel):
    id: str
    created_at: datetime
    completed_at: datetime | None = None
    status: str
    mode: str
    llm_provider: str
    llm_model: str
    stats: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


class RunDetail(RunSummary):
    request: dict[str, Any]
    documents: list[dict[str, Any]] = Field(default_factory=list)
    obligations: list[dict[str, Any]] = Field(default_factory=list)
    coverage: list[dict[str, Any]] = Field(default_factory=list)
    gaps: list[dict[str, Any]] = Field(default_factory=list)
    validation_decisions: list[dict[str, Any]] = Field(default_factory=list)
    remediation_plan: list[dict[str, Any]] = Field(default_factory=list)
    report: dict[str, Any] | None = None
    route_history: list[str] = Field(default_factory=list)
    source_errors: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)
    trace_length: int = 0
