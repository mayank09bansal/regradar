/** Display names for graph nodes and trace participants. */
export const AGENT_LABELS: Record<string, string> = {
  orchestrator: "Orchestrator",
  regulatory_scout: "Regulatory Scout",
  obligation_extractor: "Obligation Extractor",
  control_mapper: "Control Mapper",
  gap_synthesiser: "Gap Synthesiser",
  novelty_validator: "Novelty Validator",
  output_agent: "Output Agent",
  human_reviewer: "Human Reviewer",
  escalation: "Escalation",
};

/** Pipeline order, used for the agent filter on the trace page. */
export const AGENT_ORDER = [
  "orchestrator", "regulatory_scout", "obligation_extractor", "control_mapper",
  "gap_synthesiser", "novelty_validator", "output_agent", "human_reviewer",
];

/** Display name for an agent, falling back to its raw id. */
export function agentLabel(name: string): string {
  return AGENT_LABELS[name] ?? name;
}

/** Local date and time for an ISO string; "-" when empty, the input when unparseable. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Run id without its "run-" prefix, for tight table cells. */
export function shortId(id: string): string {
  return id.replace(/^run-/, "");
}

/** Whole-number percentage, or "-" when there is no value. */
export function pct(n: number | undefined): string {
  return n === undefined ? "-" : `${n.toFixed(0)}%`;
}

/**
 * Readable label for a reasoning source, so demo and fallback output is never
 * mistaken for live model output.
 */
export function reasoningLabel(source: string | undefined | null): string {
  if (!source) return "";
  if (source === "deterministic-demo") return "Deterministic demo responder";
  if (source === "rule-based-fallback") return "Rule-based fallback (LLM failed)";
  if (source.startsWith("llm:")) return `Live LLM ${source.slice(4)}`;
  return source;
}
