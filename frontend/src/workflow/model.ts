// Data model for the n8n Workflow page.
// The "n8n" lane mirrors n8n/regradar_workflow.json (the page checks it against /api/integrations/n8n/workflow);
// the "regradar" lane mirrors backend/orchestration/graph.py, backend/agents/__init__.py and
// backend/integrations/notify.py. Update this file when either changes.

export type NodeKind = "trigger" | "integration" | "agent" | "decision" | "control" | "output";
export type Lane = "n8n" | "regradar";
export type IconName =
  | "clock" | "globe" | "bolt" | "branch" | "chat" | "monitor" | "server" | "search" | "doc"
  | "link" | "pen" | "shield" | "person" | "chart" | "send";
export type Side = "left" | "right" | "top" | "bottom";

export interface WorkflowNode {
  id: string;
  label: string;
  lane: Lane;
  kind: NodeKind;
  icon: IconName;
  x: number;
  y: number;
  /** Short technology tag shown under the label. */
  tech: string;
  purpose: string;
  responsibilities: string[];
  inputs: string[];
  outputs: string[];
  files: string[];
  integration?: string;
  /** Exact node name in the n8n export (n8n lane only). */
  n8nName?: string;
  /** From AGENT_REGISTRY.uses_llm_in_live_mode (agents only). */
  usesLlm?: boolean;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  style?: "flow" | "conditional" | "loop" | "remote";
  fromSide?: Side;
  toSide?: Side;
  /** Orthogonal waypoints; the edge is drawn as a polyline through them. */
  via?: [number, number][];
  /** Perpendicular shift in px, for parallel edges between the same two nodes. */
  offset?: number;
  labelAt?: [number, number];
}

export interface LaneBox { id: Lane; title: string; subtitle: string; x: number; y: number; w: number; h: number }

export const NODE_W = 210;
export const NODE_H = 60;
export const CANVAS_W = 1600;
export const CANVAS_H = 760;

export const LANES: LaneBox[] = [
  { id: "n8n", title: "n8n", subtitle: "n8n/regradar_workflow.json", x: 10, y: 10, w: 1580, h: 262 },
  { id: "regradar", title: "RegRadar backend", subtitle: "FastAPI + LangGraph", x: 10, y: 298, w: 1580, h: 452 },
];

export const KIND_LABEL: Record<NodeKind, string> = {
  trigger: "Trigger / input",
  integration: "Integration / API",
  agent: "Agent",
  decision: "Decision / routing",
  control: "Human escalation",
  output: "Output",
};

const WORKFLOW_FILE = "n8n/regradar_workflow.json";
const LIVE_LLM = "LLM in live mode (LLM_PROVIDER: anthropic or an OpenAI-compatible API); deterministic responder in demo mode";

export const NODES: WorkflowNode[] = [
  // ---------------------------------------------------------------- n8n lane
  {
    id: "n8n_schedule", n8nName: "Weekday 09:00", label: "Weekday 09:00", lane: "n8n", kind: "trigger", icon: "clock",
    x: 160, y: 100, tech: "n8n · Schedule Trigger",
    purpose: "Starts the scheduled regulatory scan every weekday morning.",
    responsibilities: [
      "Cron expression 0 9 * * 1-5 (Monday to Friday, 09:00)",
      "Uses n8n's GENERIC_TIMEZONE (Asia/Kolkata in docker-compose.yml)",
    ],
    inputs: ["None (time-based trigger)"],
    outputs: ["An empty item that starts the HTTP Request node"],
    files: [WORKFLOW_FILE],
    integration: "n8n-nodes-base.scheduleTrigger",
  },
  {
    id: "n8n_http", n8nName: "Run RegRadar analysis", label: "Run RegRadar analysis", lane: "n8n", kind: "integration",
    icon: "globe", x: 420, y: 100, tech: "n8n · HTTP Request",
    purpose: "Runs a full RegRadar analysis through the backend REST API.",
    responsibilities: [
      "POST {{ $env.REGRADAR_API_URL || 'http://backend:8000' }}/api/demo/run",
      "Waits for the synchronous response (timeout 120 s)",
      "Passes the returned run detail to the IF node",
    ],
    inputs: ["Trigger item from Weekday 09:00"],
    outputs: ["RunDetail JSON: id, status, stats, gaps, report"],
    files: [WORKFLOW_FILE],
    integration: "n8n-nodes-base.httpRequest → RegRadar API",
  },
  {
    id: "n8n_webhook", n8nName: "RegRadar run.completed webhook", label: "run.completed webhook", lane: "n8n",
    kind: "trigger", icon: "bolt", x: 940, y: 205, tech: "n8n · Webhook",
    purpose: "Receives completion events pushed by the RegRadar backend.",
    responsibilities: [
      "Listens on POST /webhook/regradar and responds as soon as the event arrives",
      "Fires for runs started with notify = true when N8N_WEBHOOK_URL points at it",
    ],
    inputs: ["{ event: 'run.completed', run_id, stats, text } from the backend"],
    outputs: ["The request body (body.run_id, body.stats) for the IF node"],
    files: [WORKFLOW_FILE],
    integration: "n8n-nodes-base.webhook",
  },
  {
    id: "n8n_if", n8nName: "Any gaps or escalations?", label: "Gaps or escalations?", lane: "n8n", kind: "decision",
    icon: "branch", x: 1200, y: 110, tech: "n8n · IF",
    purpose: "Decides whether a finished run needs the compliance team's attention.",
    responsibilities: [
      "Condition: stats.accepted_gaps + stats.escalated_gaps > 0",
      "Reads $json.stats (HTTP path) or $json.body.stats (webhook path)",
      "true → Slack alert; false output is not connected, so the workflow ends",
    ],
    inputs: ["Run detail from the HTTP node, or the webhook body"],
    outputs: ["true branch → Slack alert"],
    files: [WORKFLOW_FILE],
    integration: "n8n-nodes-base.if",
  },
  {
    id: "n8n_slack", n8nName: "Alert compliance channel (Slack)", label: "Slack alert", lane: "n8n", kind: "output",
    icon: "chat", x: 1460, y: 110, tech: "n8n · HTTP Request",
    purpose: "Posts a summary of the run to the compliance Slack channel.",
    responsibilities: [
      "POST {{ $env.SLACK_WEBHOOK_URL }} with a JSON text body",
      "Message: run id, accepted gap count and escalated gap count",
    ],
    inputs: ["Items from the IF node's true branch"],
    outputs: ["Slack incoming-webhook message"],
    files: [WORKFLOW_FILE],
    integration: "Slack incoming webhook (URL from n8n's environment)",
  },

  // ---------------------------------------------------------------- RegRadar lane
  {
    id: "dashboard_analyze", label: "New Analysis page", lane: "regradar", kind: "trigger", icon: "monitor",
    x: 160, y: 390, tech: "React · /analyze",
    purpose: "Starts a run from the dashboard, optionally with notifications.",
    responsibilities: [
      "Submits the analysis form to POST /api/runs",
      "The 'Send Slack / n8n notification' checkbox sets notify = true",
    ],
    inputs: ["Mode, regulators, pasted documents, max revisions"],
    outputs: ["AnalysisRequest body"],
    files: ["frontend/src/pages/AnalyzePage.tsx"],
  },
  {
    id: "run_api", label: "Run endpoints", lane: "regradar", kind: "integration", icon: "server",
    x: 420, y: 390, tech: "FastAPI · REST",
    purpose: "Validates the request and runs the LangGraph pipeline synchronously.",
    responsibilities: [
      "POST /api/demo/run: demo mode over the synthetic dataset (called by n8n)",
      "POST /api/runs: full AnalysisRequest (called by the dashboard)",
      "Persists the run and its agent trace, then returns RunDetail (HTTP 201)",
    ],
    inputs: ["AnalysisRequest"],
    outputs: ["RunDetail JSON"],
    files: ["backend/api/routes.py", "backend/orchestration/runner.py"],
    integration: "SQLite / PostgreSQL run store",
  },
  {
    id: "regulatory_scout", label: "Regulatory Scout", lane: "regradar", kind: "agent", icon: "search",
    x: 680, y: 390, tech: "Agent 1 · deterministic", usesLlm: false,
    purpose: "Retrieves regulatory documents and ranks their relevance to the organisation.",
    responsibilities: [
      "Loads the synthetic dataset, pasted text or RBI/SEBI RSS feeds (live mode)",
      "Records unreachable sources in source_errors instead of failing",
      "Routes to the Output Agent when no documents are found",
    ],
    inputs: ["AnalysisRequest (mode, regulators, pasted documents, live-feed flag)"],
    outputs: ["documents", "source_errors"],
    files: ["backend/agents/regulatory_scout.py", "backend/retrieval/sources.py"],
    integration: "RBI / SEBI RSS feeds (live sources)",
  },
  {
    id: "obligation_extractor", label: "Obligation Extractor", lane: "regradar", kind: "agent", icon: "doc",
    x: 940, y: 390, tech: "Agent 2 · LLM in live mode", usesLlm: true,
    purpose: "Turns clauses into atomic obligations with strength (shall/should/may) and parameters.",
    responsibilities: [
      "Rule-based modal-verb parser in demo mode",
      "In live mode an LLM extracts obligations; only verbatim ones are kept",
    ],
    inputs: ["documents"],
    outputs: ["obligations"],
    files: ["backend/agents/obligation_extractor.py"],
    integration: LIVE_LLM,
  },
  {
    id: "control_mapper", label: "Control Mapper", lane: "regradar", kind: "agent", icon: "link",
    x: 1200, y: 390, tech: "Agent 3 · deterministic", usesLlm: false,
    purpose: "Maps obligations to the control library and builds the coverage matrix.",
    responsibilities: [
      "TF-IDF cosine + keyword overlap retrieval against the control library",
      "Quantitative shortfall checks (deadline, retention, frequency)",
    ],
    inputs: ["obligations", "control library"],
    outputs: ["coverage"],
    files: ["backend/agents/control_mapper.py", "data/controls/control_library.json"],
  },
  {
    id: "gap_synthesiser", label: "Gap Synthesiser", lane: "regradar", kind: "agent", icon: "pen",
    x: 1200, y: 555, tech: "Agent 4 · LLM in live mode", usesLlm: true,
    purpose: "Drafts gap proposals and revises them from validator feedback.",
    responsibilities: [
      "Drafts a gap for each uncovered or partially covered obligation",
      "On a revision turn, consumes pending_feedback and revises or withdraws gaps",
      "Template fallback if the LLM call fails",
    ],
    inputs: ["coverage", "obligations", "pending_feedback (on revision)"],
    outputs: ["gaps", "revision_count"],
    files: ["backend/agents/gap_synthesiser.py"],
    integration: LIVE_LLM,
  },
  {
    id: "novelty_validator", label: "Novelty Validator", lane: "regradar", kind: "decision", icon: "shield",
    x: 940, y: 555, tech: "Agent 5 · conditional edge", usesLlm: true,
    purpose: "Independently accepts or rejects each gap with structured feedback.",
    responsibilities: [
      "Nine rule-based checks are authoritative; an LLM critique is advisory in live mode",
      "Checks gaps against the known-issues register and other proposals",
      "route_after_validation: finalise (no rejections), revise (rejections, revisions < max), escalate (at max)",
    ],
    inputs: ["gaps", "obligations", "coverage", "known-issues register"],
    outputs: ["validation_decisions", "pending_feedback", "gap statuses"],
    files: ["backend/agents/novelty_validator.py", "backend/orchestration/graph.py"],
  },
  {
    id: "escalation", label: "Escalation", lane: "regradar", kind: "control", icon: "person",
    x: 680, y: 680, tech: "Graph node · orchestrator",
    purpose: "Hands unresolved gaps to a human reviewer instead of looping forever.",
    responsibilities: [
      "Marks still-rejected gaps as escalated after the revision limit",
      "Emits an escalation message (with the last feedback) to human_reviewer",
      "Continues to the Output Agent so the report is still produced",
    ],
    inputs: ["gaps", "pending_feedback", "revision_count"],
    outputs: ["gaps (status: escalated)"],
    files: ["backend/orchestration/graph.py"],
  },
  {
    id: "output_agent", label: "Output Agent", lane: "regradar", kind: "output", icon: "chart",
    x: 420, y: 555, tech: "Agent 6 · LLM in live mode", usesLlm: true,
    purpose: "Prioritises remediation and writes the final report.",
    responsibilities: [
      "Transparent risk score: severity × urgency × exposure",
      "Builds the remediation plan and the Markdown/JSON report with run stats",
      "LLM executive summary in live mode",
    ],
    inputs: ["accepted gaps", "obligations", "validation history"],
    outputs: ["remediation_plan", "report (incl. stats)"],
    files: ["backend/agents/output_agent.py"],
    integration: LIVE_LLM,
  },
  {
    id: "notify", label: "Run notifications", lane: "regradar", kind: "integration", icon: "send",
    x: 160, y: 555, tech: "Python · webhook POST",
    purpose: "Pushes a finished run to n8n and/or Slack.",
    responsibilities: [
      "Runs only when the request had notify = true and the run completed",
      "POSTs { event: 'run.completed', run_id, stats, text } to N8N_WEBHOOK_URL",
      "Also posts a text summary to SLACK_WEBHOOK_URL when that is set",
      "Failures are logged and never fail the run",
    ],
    inputs: ["run_id", "report stats"],
    outputs: ["HTTP POST to N8N_WEBHOOK_URL / SLACK_WEBHOOK_URL"],
    files: ["backend/integrations/notify.py"],
    integration: "N8N_WEBHOOK_URL, SLACK_WEBHOOK_URL (backend .env)",
  },
];

export const EDGES: WorkflowEdge[] = [
  { id: "schedule-http", from: "n8n_schedule", to: "n8n_http" },
  { id: "http-if", from: "n8n_http", to: "n8n_if", label: "RunDetail" },
  { id: "webhook-if", from: "n8n_webhook", to: "n8n_if", toSide: "bottom", label: "body" },
  { id: "if-slack", from: "n8n_if", to: "n8n_slack", label: "true", style: "conditional" },
  {
    id: "http-api", from: "n8n_http", to: "run_api", fromSide: "bottom", toSide: "top", style: "remote",
    label: "/api/demo/run", labelAt: [420, 214],
  },
  { id: "dashboard-api", from: "dashboard_analyze", to: "run_api", label: "/api/runs", labelAt: [290, 383] },
  { id: "api-scout", from: "run_api", to: "regulatory_scout", label: "START", labelAt: [550, 383] },
  { id: "scout-extractor", from: "regulatory_scout", to: "obligation_extractor", style: "conditional", label: "documents", labelAt: [810, 383] },
  {
    id: "scout-output", from: "regulatory_scout", to: "output_agent", fromSide: "bottom", toSide: "top",
    style: "conditional", label: "no documents", labelAt: [560, 470],
  },
  { id: "extractor-mapper", from: "obligation_extractor", to: "control_mapper" },
  { id: "mapper-synth", from: "control_mapper", to: "gap_synthesiser", fromSide: "bottom", toSide: "top" },
  { id: "synth-validator", from: "gap_synthesiser", to: "novelty_validator", offset: -11 },
  { id: "validator-synth", from: "novelty_validator", to: "gap_synthesiser", offset: 11, style: "loop", label: "revise", labelAt: [1070, 592] },
  { id: "validator-output", from: "novelty_validator", to: "output_agent", style: "conditional", label: "finalise", labelAt: [680, 545] },
  {
    id: "validator-escalation", from: "novelty_validator", to: "escalation", fromSide: "bottom", toSide: "right",
    style: "conditional", label: "escalate", labelAt: [905, 668],
  },
  { id: "escalation-output", from: "escalation", to: "output_agent", fromSide: "left", toSide: "bottom" },
  { id: "output-notify", from: "output_agent", to: "notify", label: "notify", style: "conditional", labelAt: [290, 545] },
  {
    id: "notify-webhook", from: "notify", to: "n8n_webhook", fromSide: "left", toSide: "bottom", style: "remote",
    via: [[30, 555], [30, 285], [940, 285]], label: "POST N8N_WEBHOOK_URL · run.completed", labelAt: [680, 285],
  },
];

export interface WalkStep { node: string; edge?: string; caption: string }
export interface Walkthrough { id: string; title: string; steps: WalkStep[] }

const PIPELINE: WalkStep[] = [
  { node: "regulatory_scout", edge: "api-scout", caption: "The graph starts at the Regulatory Scout, which gathers and ranks regulatory documents." },
  { node: "obligation_extractor", edge: "scout-extractor", caption: "Documents were found, so the Obligation Extractor splits clauses into atomic obligations." },
  { node: "control_mapper", edge: "extractor-mapper", caption: "The Control Mapper matches each obligation to the control library and builds the coverage matrix." },
  { node: "gap_synthesiser", edge: "mapper-synth", caption: "The Gap Synthesiser drafts gap proposals for uncovered and partial obligations." },
  { node: "novelty_validator", edge: "synth-validator", caption: "The Novelty Validator accepts or rejects each gap and writes structured feedback." },
  { node: "gap_synthesiser", edge: "validator-synth", caption: "Example branch, revise: a gap was rejected and revisions are below MAX_REVISIONS, so feedback goes back." },
  { node: "novelty_validator", edge: "synth-validator", caption: "The validator re-checks the revised gaps." },
  { node: "output_agent", edge: "validator-output", caption: "Example branch, finalise: nothing is rejected any more, so the Output Agent scores risk and writes the report." },
];

export const WALKTHROUGHS: Walkthrough[] = [
  {
    id: "scheduled",
    title: "Scheduled scan (n8n → RegRadar → Slack)",
    steps: [
      { node: "n8n_schedule", caption: "At 09:00 on a weekday, n8n's Schedule Trigger fires." },
      { node: "n8n_http", edge: "schedule-http", caption: "The HTTP Request node calls the RegRadar API and waits for the run to finish." },
      { node: "run_api", edge: "http-api", caption: "POST /api/demo/run validates the request and runs the LangGraph pipeline synchronously." },
      ...PIPELINE,
      { node: "n8n_http", caption: "The run is stored and the RunDetail JSON is returned as the HTTP node's response." },
      { node: "n8n_if", edge: "http-if", caption: "The IF node checks stats.accepted_gaps + stats.escalated_gaps > 0." },
      { node: "n8n_slack", edge: "if-slack", caption: "If true, n8n posts the summary to the compliance Slack channel. If false, the workflow ends." },
    ],
  },
  {
    id: "webhook",
    title: "Dashboard run with notify (RegRadar → n8n webhook)",
    steps: [
      { node: "dashboard_analyze", caption: "A user starts an analysis on New Analysis with the notification checkbox ticked." },
      { node: "run_api", edge: "dashboard-api", caption: "POST /api/runs runs the LangGraph pipeline with notify = true." },
      ...PIPELINE,
      { node: "notify", edge: "output-notify", caption: "The run completed and notify is true, so notify_run_completed() runs." },
      { node: "n8n_webhook", edge: "notify-webhook", caption: "If N8N_WEBHOOK_URL is set, the backend POSTs the run.completed event to n8n's webhook." },
      { node: "n8n_if", edge: "webhook-if", caption: "The IF node reads body.stats and checks for accepted or escalated gaps." },
      { node: "n8n_slack", edge: "if-slack", caption: "If true, n8n posts the Slack alert." },
    ],
  },
];

export function nodeById(id: string): WorkflowNode | undefined {
  return NODES.find((n) => n.id === id);
}

export function upstreamOf(id: string): WorkflowEdge[] {
  return EDGES.filter((e) => e.to === id);
}

export function downstreamOf(id: string): WorkflowEdge[] {
  return EDGES.filter((e) => e.from === id);
}

/** Edges whose two ends are both n8n nodes, as "source name>target name" (comparable with the export). */
export function modelN8nConnections(): string[] {
  return EDGES.flatMap((e) => {
    const a = nodeById(e.from)?.n8nName;
    const b = nodeById(e.to)?.n8nName;
    return a && b ? [`${a}>${b}`] : [];
  });
}
