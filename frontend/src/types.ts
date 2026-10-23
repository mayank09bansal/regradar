// Mirrors backend/schemas.py (API contract).

export type Severity = "low" | "medium" | "high" | "critical";
export type CoverageStatus = "covered" | "partial" | "gap";
export type GapStatus = "proposed" | "revised" | "accepted" | "rejected" | "withdrawn" | "escalated";
export type MessageType =
  | "task" | "result" | "proposal" | "feedback" | "revision"
  | "decision" | "escalation" | "report" | "error" | "info";

export interface LLMUsage {
  provider: string;
  model: string;
  reasoning_source: string;
  fallback: boolean;
  error: string | null;
}

export interface AgentMessage {
  id: string;
  run_id: string;
  seq: number;
  timestamp: string;
  sender: string;
  recipient: string;
  message_type: MessageType;
  summary: string;
  payload: Record<string, unknown>;
  revision_round: number;
  duration_ms: number | null;
  llm: LLMUsage | null;
}

export interface Clause { ref: string; text: string }

export interface RegulatoryDocument {
  id: string;
  regulator: string;
  title: string;
  issued: string | null;
  effective: string | null;
  url: string | null;
  source: "synthetic-demo" | "user-upload" | "live-rss";
  synthetic: boolean;
  themes: string[];
  clauses: Clause[];
  relevance_score: number;
}

export interface Obligation {
  id: string;
  document_id: string;
  regulator: string;
  clause_ref: string;
  citation: string;
  text: string;
  strength: "mandatory" | "recommended" | "permissive";
  modal: string;
  parameters: {
    deadline_hours: number | null;
    retention_days: number | null;
    frequency: string | null;
    frequency_per_year: number | null;
  };
  topics: string[];
  effective: string | null;
  extraction_method: string;
}

export interface CoverageItem {
  obligation_id: string;
  citation: string;
  regulator: string;
  obligation_text: string;
  strength: Obligation["strength"];
  status: CoverageStatus;
  best_control_id: string | null;
  best_control_title: string | null;
  similarity: number;
  candidates: { control_id: string; title: string; score: number }[];
  shortfalls: string[];
  rationale: string;
}

export interface GapRevisionRecord {
  revision: number;
  action: "proposed" | "revised" | "withdrawn" | "maintained";
  changes: Record<string, { from: unknown; to: unknown }>;
  response_to_feedback: string;
  reasoning_source: string;
}

export interface Gap {
  id: string;
  obligation_id: string;
  citation: string;
  title: string;
  description: string;
  gap_type: string;
  severity: Severity;
  classification: "mandatory" | "advisory";
  evidence_quote: string;
  related_control_ids: string[];
  recommended_action: string;
  status: GapStatus;
  revision: number;
  known_issue_id: string | null;
  response_to_feedback: string;
  reasoning_source: string;
  history: GapRevisionRecord[];
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: "blocking" | "advisory";
  field: string | null;
  expected: unknown;
}

export interface ValidationDecision {
  gap_id: string;
  round: number;
  gap_revision: number;
  decision: "accept" | "reject";
  issues: ValidationIssue[];
  checks_run: string[];
  reasoning_source: string;
  llm_notes: string;
}

export interface RemediationItem {
  gap_id: string;
  rank: number;
  priority: "P1" | "P2" | "P3";
  risk_score: number;
  title: string;
  citation: string;
  severity: Severity;
  owner: string;
  target_date: string;
  actions: string[];
  score_breakdown: Record<string, number>;
}

export interface RunStats {
  documents: number;
  obligations: number;
  controls: number;
  covered: number;
  partial: number;
  gap: number;
  coverage_pct: number;
  proposed_gaps: number;
  accepted_gaps: number;
  withdrawn_gaps: number;
  escalated_gaps: number;
  validation_rounds: number;
  revision_cycles: number;
  rejection_events: number;
  feedback_loop_triggered: boolean;
  source_errors: number;
}

export interface Report {
  run_id: string;
  generated_at: string;
  mode: string;
  reasoning_note: string;
  executive_summary: string;
  executive_summary_source: string;
  stats: RunStats;
  remediation_plan: RemediationItem[];
  accepted_gaps: Gap[];
  escalated_gaps: Gap[];
  withdrawn_gaps: Gap[];
  coverage_by_document: {
    document_id: string; title: string; regulator: string; source: string; synthetic: boolean;
    obligations: number; covered: number; partial: number; gap: number;
  }[];
  validation_rounds: { round: number; accepted: { gap_id: string }[]; rejected: { gap_id: string; issues: string[] }[] }[];
  sources: { id: string; title: string; regulator: string; source: string; url: string | null; synthetic: boolean }[];
  disclaimers: string[];
  markdown: string;
}

export interface RunSummary {
  id: string;
  created_at: string;
  completed_at: string | null;
  status: string;
  mode: string;
  llm_provider: string;
  llm_model: string;
  stats: Partial<RunStats>;
  error: string | null;
}

export interface RunDetail extends RunSummary {
  request: Record<string, unknown>;
  documents: RegulatoryDocument[];
  obligations: Obligation[];
  coverage: CoverageItem[];
  gaps: Gap[];
  validation_decisions: ValidationDecision[];
  remediation_plan: RemediationItem[];
  report: Report | null;
  route_history: string[];
  source_errors: string[];
  errors: string[];
  trace_length: number;
}

export interface AgentInfo {
  name: string;
  display_name: string;
  order: number;
  role: string;
  inputs: string[];
  outputs: string[];
  reasoning: string;
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

export interface PublicConfig {
  app_env: string;
  llm_provider: string;
  llm_model: string;
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
  cors_origins: string[];
  database: string;
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

export interface AnalysisRequestBody {
  mode: "demo" | "live";
  regulators: string[];
  include_live_feeds: boolean;
  documents: { title: string; regulator: string; text: string; reference_id?: string; effective_date?: string }[];
  max_revisions?: number;
  notify: boolean;
}
