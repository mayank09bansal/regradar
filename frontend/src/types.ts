// Mirrors backend/schemas.py (API contract).

export type Severity = "low" | "medium" | "high" | "critical";
export type CoverageStatus = "covered" | "partial" | "gap";
export type GapStatus = "proposed" | "revised" | "accepted" | "rejected" | "withdrawn" | "escalated";
export type MessageType =
  | "task" | "result" | "proposal" | "feedback" | "revision"
  | "decision" | "escalation" | "report" | "error" | "info";

/** Which reasoning source produced a trace message. */
export interface LLMUsage {
  /** Provider name: "demo", "openai" or "anthropic". */
  provider: string;
  /** Model identifier used for the call. */
  model: string;
  /** "deterministic-demo", "rule-based-fallback" or "llm:<provider>/<model>"; see reasoningLabel(). */
  reasoning_source: string;
  /** True when the LLM failed and rule-based logic produced the result. */
  fallback: boolean;
  /** Failure text, shortened by the backend; null on success. */
  error: string | null;
}

/** One entry on the agent bus, as persisted in the execution trace. */
export interface AgentMessage {
  /** Short random message id. */
  id: string;
  /** Run this message belongs to. */
  run_id: string;
  /** 1-based position across the whole run. */
  seq: number;
  /** ISO 8601 UTC time the message was emitted. */
  timestamp: string;
  /** Graph node or "orchestrator" that sent the message. */
  sender: string;
  /** Target node, "orchestrator" or "human_reviewer". */
  recipient: string;
  /** Category, used for trace filtering and colour. */
  message_type: MessageType;
  /** One-line description shown in the timeline. */
  summary: string;
  /** Structured detail shown behind "Show payload". */
  payload: Record<string, unknown>;
  /** Feedback-loop cycle; 0 outside the loop. */
  revision_round: number;
  /** Node duration, set on a node's final message only. */
  duration_ms: number | null;
  /** Set when the message came from an LLM step. */
  llm: LLMUsage | null;
}

export interface Clause { ref: string; text: string }

/** A regulation retrieved by the Regulatory Scout. */
export interface RegulatoryDocument {
  /** Citation prefix, e.g. "RBI-DEMO-2026-014". */
  id: string;
  /** Upper-case regulator code. */
  regulator: string;
  title: string;
  /** ISO date issued, when known. */
  issued: string | null;
  /** ISO date it takes effect; drives remediation urgency. */
  effective: string | null;
  /** Original location; absent for demo and pasted documents. */
  url: string | null;
  /** Where the text came from. */
  source: "synthetic-demo" | "user-upload" | "live-rss";
  /** True for demo data, which is always labelled in the UI. */
  synthetic: boolean;
  /** Subject tags from the demo dataset. */
  themes: string[];
  /** Text split into citable clauses. */
  clauses: Clause[];
  /** Share of tokens matching company interests (0 to 1). */
  relevance_score: number;
}

/** One atomic requirement extracted from a clause. */
export interface Obligation {
  /** "<document>:<clause>", with "-n" for later sentences in a clause. */
  id: string;
  document_id: string;
  regulator: string;
  clause_ref: string;
  /** Human-readable reference, e.g. "RBI-DEMO-2026-014 §3.1". */
  citation: string;
  /** Verbatim sentence from the regulation. */
  text: string;
  /** How binding it is, derived from the modal verb. */
  strength: "mandatory" | "recommended" | "permissive";
  /** The exact phrase that set the strength. */
  modal: string;
  /** Quantities compared with control parameters to find shortfalls. */
  parameters: {
    deadline_hours: number | null;
    retention_days: number | null;
    frequency: string | null;
    frequency_per_year: number | null;
  };
  /** Subject tags used for owner assignment and exposure scoring. */
  topics: string[];
  effective: string | null;
  /** "rule-based" or "llm:<provider>". */
  extraction_method: string;
}

/** Control Mapper verdict for one obligation. */
export interface CoverageItem {
  obligation_id: string;
  citation: string;
  regulator: string;
  obligation_text: string;
  strength: Obligation["strength"];
  /** covered, partial or gap, from the score bands and shortfalls. */
  status: CoverageStatus;
  /** Linked control; null when the status is gap. */
  best_control_id: string | null;
  best_control_title: string | null;
  /** Blended score of the best control, even for a gap. */
  similarity: number;
  /** Top three controls, so a reviewer can challenge the match. */
  candidates: { control_id: string; title: string; score: number }[];
  /** Readable parameter mismatches with the best control. */
  shortfalls: string[];
  /** Plain-language reason for the status. */
  rationale: string;
}

/** One action in a gap's append-only history. */
export interface GapRevisionRecord {
  /** Revision cycle; 0 is the original draft. */
  revision: number;
  action: "proposed" | "revised" | "withdrawn" | "maintained";
  /** Field name to old and new value. */
  changes: Record<string, { from: unknown; to: unknown }>;
  /** The synthesiser's answer to the validator. */
  response_to_feedback: string;
  reasoning_source: string;
}

/** A compliance gap proposal and its final state. */
export interface Gap {
  /** "GAP-001" style id, unique within a run only. */
  id: string;
  /** Stable across runs of the same documents, unlike the gap id. */
  obligation_id: string;
  citation: string;
  title: string;
  description: string;
  /** missing_control, parameter_shortfall, scope_gap or governance_gap. */
  gap_type: string;
  severity: Severity;
  /** Advisory gaps score at half weight in the remediation plan. */
  classification: "mandatory" | "advisory";
  /** Verbatim obligation text; checked by the validator. */
  evidence_quote: string;
  /** Controls involved; the first one supplies the owner. */
  related_control_ids: string[];
  recommended_action: string;
  /** Final state: accepted, withdrawn or escalated after a finished run. */
  status: GapStatus;
  revision: number;
  /** Set when already tracked in the known-issues register. */
  known_issue_id: string | null;
  /** Latest answer to the validator; escalations show the disagreement here. */
  response_to_feedback: string;
  /** What produced the current version; see reasoningLabel(). */
  reasoning_source: string;
  /** Every action taken on the gap, oldest first. */
  history: GapRevisionRecord[];
}

/** One problem found by a validator check. */
export interface ValidationIssue {
  /** Machine-readable reason, e.g. "evidence_not_grounded". */
  code: string;
  message: string;
  /** Only blocking issues cause a rejection. */
  severity: "blocking" | "advisory";
  /** Gap field at fault. */
  field: string | null;
  /** Value that would pass, when one can be stated. */
  expected: unknown;
}

/** Validator verdict for one gap in one round. */
export interface ValidationDecision {
  gap_id: string;
  /** 1-based validation round. */
  round: number;
  /** Gap revision that was checked. */
  gap_revision: number;
  decision: "accept" | "reject";
  issues: ValidationIssue[];
  /** Names of the checks applied. */
  checks_run: string[];
  /** "rule-based", plus "llm-advisory" when a note exists. */
  reasoning_source: string;
  /** Advisory comment; it never changes the decision. */
  llm_notes: string;
}

/** One ranked action in the Output Agent's plan. */
export interface RemediationItem {
  gap_id: string;
  /** 1 is the highest risk score. */
  rank: number;
  /** P1 for scores of 10+, P2 for 5+, otherwise P3. */
  priority: "P1" | "P2" | "P3";
  /** Severity weight x urgency x exposure x classification factor. */
  risk_score: number;
  title: string;
  citation: string;
  severity: Severity;
  /** From the related control, else the topic, else the CCO. */
  owner: string;
  /** Priority SLA, or the effective date if that is sooner. */
  target_date: string;
  /** Concrete steps to close the gap. */
  actions: string[];
  /** The factors behind risk_score. */
  score_breakdown: Record<string, number>;
}

/** Headline figures computed by the Output Agent. */
export interface RunStats {
  /** Documents analysed. */
  documents: number;
  /** Obligations extracted. */
  obligations: number;
  /** Controls in the library. */
  controls: number;
  /** Obligations with full coverage. */
  covered: number;
  /** Obligations with partial coverage. */
  partial: number;
  /** Obligations with no matching control. */
  gap: number;
  /** Fully covered share only; partial coverage is excluded. */
  coverage_pct: number;
  /** All gaps ever proposed in the run. */
  proposed_gaps: number;
  /** Gaps that passed validation. */
  accepted_gaps: number;
  /** Gaps removed after feedback. */
  withdrawn_gaps: number;
  /** Gaps unresolved at the revision limit. */
  escalated_gaps: number;
  /** Times the validator ran. */
  validation_rounds: number;
  /** Times the synthesiser revised gaps. */
  revision_cycles: number;
  /** Total rejections across all rounds. */
  rejection_events: number;
  /** True when at least one gap was rejected. */
  feedback_loop_triggered: boolean;
  /** Sources that could not be retrieved. */
  source_errors: number;
}

/** Final report written by the Output Agent. Immutable once the run ends. */
export interface Report {
  run_id: string;
  generated_at: string;
  mode: string;
  /** States how the run's reasoning was produced. */
  reasoning_note: string;
  executive_summary: string;
  /** Whether a model or the fallback template wrote the summary. */
  executive_summary_source: string;
  stats: RunStats;
  remediation_plan: RemediationItem[];
  /** Validated findings. */
  accepted_gaps: Gap[];
  /** Needs a human decision; not confirmed findings. */
  escalated_gaps: Gap[];
  /** Removed, listed for transparency. */
  withdrawn_gaps: Gap[];
  coverage_by_document: {
    document_id: string; title: string; regulator: string; source: string; synthetic: boolean;
    obligations: number; covered: number; partial: number; gap: number;
  }[];
  validation_rounds: { round: number; accepted: { gap_id: string }[]; rejected: { gap_id: string; issues: string[] }[] }[];
  sources: { id: string; title: string; regulator: string; source: string; url: string | null; synthetic: boolean }[];
  /** Always shown, including a synthetic-data warning when relevant. */
  disclaimers: string[];
  /** Full rendered report, shown by the Markdown component. */
  markdown: string;
}

/** Light run record from the list endpoint. */
export interface RunSummary {
  id: string;
  created_at: string;
  /** Null while running or if the process stopped first. */
  completed_at: string | null;
  status: string;
  /** "demo" or "live". */
  mode: string;
  llm_provider: string;
  llm_model: string;
  /** Partial because failed runs may have no statistics. */
  stats: Partial<RunStats>;
  /** Failure reason for failed runs. */
  error: string | null;
}

/** Everything stored for a run. */
export interface RunDetail extends RunSummary {
  /** Exact request that started the run. */
  request: Record<string, unknown>;
  documents: RegulatoryDocument[];
  obligations: Obligation[];
  coverage: CoverageItem[];
  gaps: Gap[];
  validation_decisions: ValidationDecision[];
  remediation_plan: RemediationItem[];
  report: Report | null;
  /** Graph nodes in execution order, including loop repeats. */
  route_history: string[];
  /** Retrieval failures, kept visible instead of hidden. */
  source_errors: string[];
  /** Agent errors recorded during the run. */
  errors: string[];
  /** Stored messages; fetch them from the trace endpoint. */
  trace_length: number;
}

/** Agent registry entry from /api/agents. */
export interface AgentInfo {
  name: string;
  display_name: string;
  /** Position in the pipeline. */
  order: number;
  role: string;
  inputs: string[];
  outputs: string[];
  /** How the agent reaches its conclusions. */
  reasoning: string;
  /** False for fully rule-based agents. */
  uses_llm_in_live_mode: boolean;
}

export interface GraphSpec {
  nodes: { id: string; label: string; kind: "agent" | "control" }[];
  edges: { from: string; to: string; condition?: string }[];
}

/** n8n workflow export (n8n/regradar_workflow.json), served by /api/integrations/n8n/workflow. */
export interface N8nWorkflowExport {
  name: string;
  nodes: { id: string; name: string; type: string; typeVersion: number; position: [number, number]; parameters: Record<string, unknown> }[];
  connections: Record<string, { main: { node: string; type: string; index: number }[][] }>;
  settings?: Record<string, unknown>;
}

/** Non-sensitive configuration from /api/config. Secrets appear only as "is set" flags. */
export interface PublicConfig {
  app_env: string;
  llm_provider: string;
  llm_model: string;
  /** True when a live run can start. */
  live_llm_configured: boolean;
  anthropic_api_key_set: boolean;
  openai_api_key_set: boolean;
  openai_base_url: string;
  max_revisions: number;
  live_sources_enabled: boolean;
  rbi_rss_url: string;
  sebi_rss_url: string;
  slack_configured: boolean;
  n8n_configured: boolean;
  /** True when REGRADAR_API_TOKEN protects write endpoints. */
  write_auth_required: boolean;
  cors_origins: string[];
  database: string;
  /** False when runs may be lost on restart. */
  storage_persistent: boolean;
  deployment: "local" | "vercel";
}

export interface Health {
  status: string;
  version: string;
  database: string;
  llm_provider: string;
  live_llm_configured: boolean;
  storage: string;
  storage_persistent: boolean;
  deployment: "local" | "vercel";
  time: string;
}

export interface ControlLibrary {
  library: string;
  synthetic: boolean;
  organisation: string;
  controls: {
    id: string; domain: string; owner: string; title: string; description: string;
    keywords: string[]; parameters: Record<string, string | number>; criticality: string;
  }[];
  known_issues: {
    id: string; title: string; related_control_ids: string[]; related_citations: string[];
    status: string; owner: string; target_date: string;
  }[];
}

export interface DemoDataset {
  dataset: string;
  synthetic: boolean;
  disclaimer: string;
  organisation_profile: { name: string; type: string; jurisdiction: string; themes_of_interest: string[] };
  documents: {
    id: string; regulator: string; title: string; issued: string; effective: string;
    themes: string[]; clauses: Clause[];
  }[];
}

/** Body of POST /api/runs. */
export interface AnalysisRequestBody {
  mode: "demo" | "live";
  /** Empty means all regulators. */
  regulators: string[];
  /** Live mode only: read RBI and SEBI RSS feeds. */
  include_live_feeds: boolean;
  /** Pasted circulars; live mode only. */
  documents: { title: string; regulator: string; text: string; reference_id?: string; effective_date?: string }[];
  /** Omit to use the server default. */
  max_revisions?: number;
  /** Send Slack and n8n notifications when finished. */
  notify: boolean;
}
