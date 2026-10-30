// Pure derivations behind the dashboard. Nothing here touches React or the network,
// so every number on the page can be traced back to one function over run data.
import { shortId } from "../lib";
import type {
  AgentMessage, CoverageItem, Gap, GapStatus, Obligation, RegulatoryDocument, RemediationItem,
  RunDetail, RunSummary, Severity, ValidationDecision,
} from "../types";

/** Regulator filter value meaning "no filter". */
export const ALL_REGULATORS = "all";

/** Severities from most to least serious; also the row order of the risk grid. */
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

export const PRIORITIES = ["P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Actions due this soon are treated as urgent on the attention list. */
export const URGENT_DAYS = 14;

/** Time-to-target columns of the risk grid, soonest first. `max` is inclusive. */
export const DEADLINE_BUCKETS = [
  { id: "overdue", label: "Overdue", max: -1 },
  { id: "d14", label: "0-14 days", max: 14 },
  { id: "d30", label: "15-30 days", max: 30 },
  { id: "d60", label: "31-60 days", max: 60 },
  { id: "later", label: "Over 60 days", max: Number.POSITIVE_INFINITY },
] as const;
export type DeadlineBucket = (typeof DEADLINE_BUCKETS)[number]["id"];

/** One cell of the risk grid, used to filter the action queue. */
export interface RiskCell { severity: Severity; bucket: DeadlineBucket }

/** Pipeline agents with the verb shown on the pipeline strip, in graph order. */
export const PIPELINE_AGENTS = [
  { id: "regulatory_scout", verb: "retrieve", loop: false },
  { id: "obligation_extractor", verb: "extract", loop: false },
  { id: "control_mapper", verb: "map", loop: false },
  { id: "gap_synthesiser", verb: "propose", loop: true },
  { id: "novelty_validator", verb: "validate", loop: true },
  { id: "output_agent", verb: "report", loop: false },
];

// ---------- formatting ----------

/** Readable sentence-case text for a snake_case machine code. */
export function humanize(code: string): string {
  const text = code.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Node or run duration: fractions under a millisecond stay visible in demo mode. */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** Calendar date for an ISO date, without the timezone shift `new Date("YYYY-MM-DD")` causes. */
export function formatDay(iso: string | null | undefined): string {
  const parts = parseDay(iso);
  if (!parts) return iso ?? "-";
  const [y, m, d] = parts;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** Short local time for chart axes. */
export function formatRunTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "in 12 days", "today" or "3 days overdue"; `null` means the date was unusable. */
export function dueLabel(days: number | null): string {
  if (days === null) return "no date";
  if (days < 0) return `${-days} day${days === -1 ? "" : "s"} overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

// ---------- dates ----------

function parseDay(iso: string | null | undefined): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whole calendar days from `now` to an ISO date; negative once it has passed. */
export function daysUntil(iso: string | null | undefined, now: Date): number | null {
  const parts = parseDay(iso);
  if (!parts) return null;
  const [y, m, d] = parts;
  const target = Date.UTC(y, m - 1, d);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

/** Risk grid column for a number of days left; `null` for an unusable date. */
export function deadlineBucket(days: number | null): DeadlineBucket | null {
  if (days === null) return null;
  return DEADLINE_BUCKETS.find((b) => days <= b.max)?.id ?? null;
}

// ---------- run view: one run, narrowed by the regulator filter ----------

/** Coverage totals, computed the same way as the Output Agent's statistics. */
export interface CoverageCounts {
  covered: number;
  partial: number;
  gap: number;
  total: number;
  /** Fully covered share only; partial coverage is excluded. */
  pct: number;
}

/** A run narrowed to one regulator. Every Overview and Risk number reads from this. */
export interface RunView {
  run: RunDetail;
  regulator: string;
  documents: RegulatoryDocument[];
  obligations: Obligation[];
  coverage: CoverageItem[];
  gaps: Gap[];
  plan: RemediationItem[];
  decisions: ValidationDecision[];
  counts: CoverageCounts;
}

/**
 * Percentage to one decimal, rounding ties to even like the backend's Python round().
 * Math.round would show 5 of 16 as 31.3% here and 31.2% on every other page.
 */
export function roundedPct(part: number, whole: number): number {
  if (!whole) return 0;
  const tenths = (1000 * part) / whole;
  const floor = Math.floor(tenths);
  const isTie = tenths - floor === 0.5;
  return (isTie ? floor + (floor % 2) : Math.round(tenths)) / 10;
}

export function coverageCounts(items: CoverageItem[]): CoverageCounts {
  const covered = items.filter((c) => c.status === "covered").length;
  const partial = items.filter((c) => c.status === "partial").length;
  const gap = items.filter((c) => c.status === "gap").length;
  const total = items.length;
  return { covered, partial, gap, total, pct: roundedPct(covered, total) };
}

/** Regulators present in a run, alphabetically. */
export function regulatorsOf(run: RunDetail): string[] {
  return [...new Set(run.documents.map((d) => d.regulator))].sort();
}

/** Narrow a run to one regulator. Gaps have no regulator, so it comes from their obligation. */
export function buildRunView(run: RunDetail, regulator: string): RunView {
  const all = regulator === ALL_REGULATORS;
  const regulatorOf = new Map(run.obligations.map((o) => [o.id, o.regulator]));
  const gaps = all ? run.gaps : run.gaps.filter((g) => regulatorOf.get(g.obligation_id) === regulator);
  const gapIds = new Set(gaps.map((g) => g.id));
  const coverage = all ? run.coverage : run.coverage.filter((c) => c.regulator === regulator);
  return {
    run,
    regulator,
    documents: all ? run.documents : run.documents.filter((d) => d.regulator === regulator),
    obligations: all ? run.obligations : run.obligations.filter((o) => o.regulator === regulator),
    coverage,
    gaps,
    plan: all ? run.remediation_plan : run.remediation_plan.filter((p) => gapIds.has(p.gap_id)),
    decisions: all ? run.validation_decisions : run.validation_decisions.filter((d) => gapIds.has(d.gap_id)),
    counts: coverageCounts(coverage),
  };
}

/** True for a gap that still stands: anything not withdrawn or rejected. */
export function isOpenGap(gap: Gap): boolean {
  return gap.status !== "withdrawn" && gap.status !== "rejected";
}

export function gapsWithStatus(view: RunView, status: GapStatus): number {
  return view.gaps.filter((g) => g.status === status).length;
}

/** Headline figures for KPI tiles, all honouring the regulator filter. */
export interface ViewFigures {
  openGaps: number;
  escalated: number;
  p1Actions: number;
  rejections: number;
  obligations: number;
  coveragePct: number;
}

export function viewFigures(view: RunView): ViewFigures {
  return {
    openGaps: view.gaps.filter(isOpenGap).length,
    escalated: gapsWithStatus(view, "escalated"),
    p1Actions: view.plan.filter((p) => p.priority === "P1").length,
    rejections: view.decisions.filter((d) => d.decision === "reject").length,
    obligations: view.obligations.length,
    coveragePct: view.counts.pct,
  };
}

// ---------- attention list ----------

export type AttentionTone = "bad" | "esc" | "warn" | "info";

/** One thing a reader should act on, with a link to where it can be resolved. */
export interface AttentionItem {
  id: string;
  tone: AttentionTone;
  title: string;
  detail: string;
  to: string;
}

const TONE_ORDER: AttentionTone[] = ["bad", "esc", "warn", "info"];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Open gaps per document, used to show which incoming regulation carries unresolved work. */
function openGapsByDocument(view: RunView): Map<string, number> {
  const documentOf = new Map(view.obligations.map((o) => [o.id, o.document_id]));
  const counts = new Map<string, number>();
  for (const gap of view.gaps.filter(isOpenGap)) {
    const doc = documentOf.get(gap.obligation_id);
    if (doc) counts.set(doc, (counts.get(doc) ?? 0) + 1);
  }
  return counts;
}

/** What needs a person, most serious first. Built only from recorded run facts. */
export function attentionItems(view: RunView, now: Date): AttentionItem[] {
  const { run } = view;
  const base = `/runs/${run.id}`;
  const items: AttentionItem[] = [];

  if (run.status === "failed") {
    items.push({ id: "failed", tone: "bad", title: "This run failed", detail: run.error ?? "No failure reason was recorded.", to: `${base}/trace` });
  }
  if (run.errors.length) {
    items.push({ id: "errors", tone: "bad", title: `${plural(run.errors.length, "agent error")} recorded`, detail: run.errors[0], to: `${base}/trace` });
  }

  const escalated = view.gaps.filter((g) => g.status === "escalated");
  if (escalated.length) {
    items.push({
      id: "escalated", tone: "esc",
      title: `${plural(escalated.length, "gap")} need${escalated.length === 1 ? "s" : ""} a human decision`,
      detail: escalated[0].title,
      to: `${base}/gaps`,
    });
  }

  const dated = view.plan.map((p) => ({ item: p, days: daysUntil(p.target_date, now) }));
  const overdue = dated.filter((d) => d.days !== null && d.days < 0);
  if (overdue.length) {
    items.push({
      id: "overdue", tone: "bad",
      title: `${plural(overdue.length, "remediation action")} overdue`,
      detail: `${overdue[0].item.owner}: ${overdue[0].item.title}`,
      to: `${base}/remediation`,
    });
  }
  const soon = dated.filter((d) => d.item.priority === "P1" && d.days !== null && d.days >= 0 && d.days <= URGENT_DAYS);
  if (soon.length) {
    items.push({
      id: "p1-soon", tone: "warn",
      title: `${plural(soon.length, "P1 action")} due within ${URGENT_DAYS} days`,
      detail: `${soon[0].item.owner}, ${dueLabel(soon[0].days)}`,
      to: `${base}/remediation`,
    });
  }

  const openByDoc = openGapsByDocument(view);
  for (const doc of view.documents) {
    const days = daysUntil(doc.effective, now);
    const open = openByDoc.get(doc.id) ?? 0;
    if (days === null || days < 0 || days > URGENT_DAYS || open === 0) continue;
    items.push({
      id: `effective-${doc.id}`, tone: "warn",
      title: `${doc.id} takes effect ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}`,
      detail: `${plural(open, "open gap")} against this regulation`,
      to: `${base}/gaps`,
    });
  }

  const noControl = view.coverage.filter((c) => c.status === "gap" && c.strength === "mandatory");
  if (noControl.length) {
    items.push({
      id: "no-control", tone: "warn",
      title: `${plural(noControl.length, "mandatory obligation")} with no control`,
      detail: noControl[0].citation,
      to: `${base}/coverage`,
    });
  }

  if (run.source_errors.length) {
    items.push({ id: "sources", tone: "warn", title: `${plural(run.source_errors.length, "source")} could not be retrieved`, detail: run.source_errors[0], to: `${base}` });
  }
  const fallback = view.gaps.filter((g) => g.reasoning_source === "rule-based-fallback");
  if (fallback.length) {
    items.push({
      id: "fallback", tone: "info",
      title: `${plural(fallback.length, "gap")} produced by rule-based fallback`,
      detail: "The LLM failed for these, so a rule produced the result.",
      to: `${base}/trace`,
    });
  }

  return items.sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone));
}

// ---------- deadlines ----------

/** Everything falling on one calendar date. */
export interface DeadlineDay {
  date: string;
  days: number;
  documents: RegulatoryDocument[];
  actions: RemediationItem[];
}

/**
 * Upcoming dates, soonest first. Overdue actions stay listed; a regulation already in
 * force is not a deadline any more, so it drops out.
 */
export function deadlineDays(view: RunView, now: Date): DeadlineDay[] {
  const byDate = new Map<string, DeadlineDay>();
  const slot = (date: string, days: number) => {
    const key = date.slice(0, 10);
    const day = byDate.get(key) ?? { date: key, days, documents: [], actions: [] };
    byDate.set(key, day);
    return day;
  };
  for (const doc of view.documents) {
    const days = daysUntil(doc.effective, now);
    if (doc.effective && days !== null && days >= 0) slot(doc.effective, days).documents.push(doc);
  }
  for (const action of view.plan) {
    const days = daysUntil(action.target_date, now);
    if (days !== null) slot(action.target_date, days).actions.push(action);
  }
  return [...byDate.values()].sort((a, b) => a.days - b.days);
}

// ---------- comparison with a baseline run ----------

/** A gap present in both runs whose status or severity moved. */
export interface ChangedGap { gap: Gap; previous: Gap; fields: string[] }

export interface RunComparison {
  added: Gap[];
  resolved: Gap[];
  changed: ChangedGap[];
  unchanged: number;
}

/** First gap per obligation among those still open. */
function openGapIndex(view: RunView): Map<string, Gap> {
  const index = new Map<string, Gap>();
  for (const gap of view.gaps.filter(isOpenGap)) {
    if (!index.has(gap.obligation_id)) index.set(gap.obligation_id, gap);
  }
  return index;
}

/** Compare open gaps by obligation id, the only identifier stable across runs. */
export function compareRuns(current: RunView, baseline: RunView): RunComparison {
  const now = openGapIndex(current);
  const before = openGapIndex(baseline);
  const added: Gap[] = [];
  const changed: ChangedGap[] = [];
  let unchanged = 0;
  for (const [obligation, gap] of now) {
    const previous = before.get(obligation);
    if (!previous) {
      added.push(gap);
      continue;
    }
    const fields: string[] = [];
    if (previous.status !== gap.status) fields.push(`status ${previous.status} to ${gap.status}`);
    if (previous.severity !== gap.severity) fields.push(`severity ${previous.severity} to ${gap.severity}`);
    if (fields.length) changed.push({ gap, previous, fields });
    else unchanged += 1;
  }
  const resolved = [...before].filter(([obligation]) => !now.has(obligation)).map(([, gap]) => gap);
  return { added, resolved, changed, unchanged };
}

/** Which way a change counts as an improvement. */
export type GoodDirection = "up" | "down" | "neutral";

/** Signed difference and how to read it; `null` without a baseline. */
export interface DeltaInfo { value: number; tone: "good" | "bad" | "flat" }

export function deltaInfo(current: number, previous: number | null | undefined, good: GoodDirection): DeltaInfo | null {
  if (previous === null || previous === undefined) return null;
  const value = Math.round((current - previous) * 10) / 10;
  if (value === 0 || good === "neutral") return { value, tone: "flat" };
  return { value, tone: (value > 0) === (good === "up") ? "good" : "bad" };
}

/**
 * The run to compare against by default: the closest earlier completed run of the same
 * mode, so a demo run is never silently measured against a live one.
 */
export function defaultBaselineId(runs: RunSummary[], run: RunDetail): string | null {
  const earlier = runs
    .filter((r) => r.id !== run.id && r.status === "completed" && r.mode === run.mode && r.created_at < run.created_at)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return earlier[0]?.id ?? null;
}

// ---------- risk and workload ----------

/** Remediation count per severity and deadline bucket, keyed "severity:bucket". */
export function riskGrid(plan: RemediationItem[], now: Date): Map<string, number> {
  const grid = new Map<string, number>();
  for (const item of plan) {
    const bucket = deadlineBucket(daysUntil(item.target_date, now));
    if (!bucket) continue;
    const key = `${item.severity}:${bucket}`;
    grid.set(key, (grid.get(key) ?? 0) + 1);
  }
  return grid;
}

/** One owner's remediation load, split by priority. */
export interface OwnerLoad {
  owner: string;
  total: number;
  risk: number;
  byPriority: Record<Priority, number>;
  /** Soonest target date among the owner's actions. */
  nextDue: string | null;
}

/** Owners by total risk carried, so the most exposed person is first. */
export function ownerLoads(plan: RemediationItem[]): OwnerLoad[] {
  const loads = new Map<string, OwnerLoad>();
  for (const item of plan) {
    const load = loads.get(item.owner) ?? { owner: item.owner, total: 0, risk: 0, byPriority: { P1: 0, P2: 0, P3: 0 }, nextDue: null };
    load.total += 1;
    load.risk += item.risk_score;
    load.byPriority[item.priority] += 1;
    if (!load.nextDue || item.target_date < load.nextDue) load.nextDue = item.target_date;
    loads.set(item.owner, load);
  }
  return [...loads.values()].sort((a, b) => b.risk - a.risk || a.owner.localeCompare(b.owner));
}

/** Label and count pairs, largest first with ties in alphabetical order. */
export interface Tally { key: string; label: string; value: number }

function tally(keys: string[], label: (key: string) => string = (k) => k): Tally[] {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts]
    .map(([key, value]) => ({ key, label: label(key), value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}

export function gapTypeTally(view: RunView): Tally[] {
  return tally(view.gaps.filter(isOpenGap).map((g) => g.gap_type), humanize);
}

/** Open gaps per obligation topic; one gap counts once for each of its topics. */
export function topicTally(view: RunView): Tally[] {
  const topicsOf = new Map(view.obligations.map((o) => [o.id, o.topics]));
  return tally(view.gaps.filter(isOpenGap).flatMap((g) => topicsOf.get(g.obligation_id) ?? []), (t) => humanize(t));
}

// ---------- action queue ----------

export type ActionSort = "rank" | "target_date" | "risk_score" | "owner";

export interface ActionFilters {
  query: string;
  priority: Priority | "all";
  owner: string;
  cell: RiskCell | null;
  sort: ActionSort;
}

export const EMPTY_ACTION_FILTERS: ActionFilters = { query: "", priority: "all", owner: "all", cell: null, sort: "rank" };

/** Actions matching the queue's filters, in the chosen order. */
export function filterActions(plan: RemediationItem[], filters: ActionFilters, now: Date): RemediationItem[] {
  const query = filters.query.trim().toLowerCase();
  const matches = plan.filter((item) => {
    if (filters.priority !== "all" && item.priority !== filters.priority) return false;
    if (filters.owner !== "all" && item.owner !== filters.owner) return false;
    if (filters.cell) {
      if (item.severity !== filters.cell.severity) return false;
      if (deadlineBucket(daysUntil(item.target_date, now)) !== filters.cell.bucket) return false;
    }
    return !query || [item.title, item.citation, item.owner, item.gap_id].some((text) => text.toLowerCase().includes(query));
  });
  const compare: Record<ActionSort, (a: RemediationItem, b: RemediationItem) => number> = {
    rank: (a, b) => a.rank - b.rank,
    target_date: (a, b) => a.target_date.localeCompare(b.target_date) || a.rank - b.rank,
    risk_score: (a, b) => b.risk_score - a.risk_score || a.rank - b.rank,
    owner: (a, b) => a.owner.localeCompare(b.owner) || a.rank - b.rank,
  };
  return matches.sort(compare[filters.sort]);
}

// ---------- validation ----------

/** How every proposed gap finished. The parts add up to the number proposed. */
export interface GapOutcomes {
  proposed: number;
  firstPass: number;
  afterRevision: number;
  withdrawn: number;
  escalated: number;
  unresolved: number;
}

export function gapOutcomes(gaps: Gap[], decisions: ValidationDecision[]): GapOutcomes {
  const rejected = new Set(decisions.filter((d) => d.decision === "reject").map((d) => d.gap_id));
  const accepted = gaps.filter((g) => g.status === "accepted");
  const afterRevision = accepted.filter((g) => rejected.has(g.id)).length;
  const withdrawn = gaps.filter((g) => g.status === "withdrawn").length;
  const escalated = gaps.filter((g) => g.status === "escalated").length;
  return {
    proposed: gaps.length,
    firstPass: accepted.length - afterRevision,
    afterRevision,
    withdrawn,
    escalated,
    unresolved: gaps.length - accepted.length - withdrawn - escalated,
  };
}

/** Accept and reject counts for one validation round. */
export interface RoundSummary { round: number; accepted: number; rejected: number }

export function roundSummaries(decisions: ValidationDecision[]): RoundSummary[] {
  const rounds = new Map<number, RoundSummary>();
  for (const d of decisions) {
    const round = rounds.get(d.round) ?? { round: d.round, accepted: 0, rejected: 0 };
    if (d.decision === "accept") round.accepted += 1;
    else round.rejected += 1;
    rounds.set(d.round, round);
  }
  return [...rounds.values()].sort((a, b) => a.round - b.round);
}

/** Why the validator pushed back: blocking issues only, since nothing else rejects a gap. */
export function rejectionReasons(decisions: ValidationDecision[]): Tally[] {
  return tally(decisions.flatMap((d) => d.issues.filter((i) => i.severity === "blocking").map((i) => i.code)), humanize);
}

// ---------- agent performance ----------

/** One pipeline agent's measured activity in a run. */
export interface AgentStat {
  id: string;
  verb: string;
  loop: boolean;
  /** Times the graph entered this node. */
  visits: number;
  messages: number;
  /** Null when the trace records no duration for the agent. */
  durationMs: number | null;
  llmCalls: number;
  fallbacks: number;
}

export function agentStats(messages: AgentMessage[], route: string[]): AgentStat[] {
  return PIPELINE_AGENTS.map((agent) => {
    const own = messages.filter((m) => m.sender === agent.id);
    const timed = own.filter((m) => m.duration_ms !== null);
    return {
      ...agent,
      visits: route.filter((node) => node === agent.id).length,
      messages: own.length,
      durationMs: timed.length ? timed.reduce((sum, m) => sum + (m.duration_ms ?? 0), 0) : null,
      llmCalls: own.filter((m) => m.llm !== null).length,
      fallbacks: own.filter((m) => m.llm?.fallback).length,
    };
  });
}

/** Clock time of a run, or null while it is unfinished. */
export function runDurationMs(run: Pick<RunSummary, "created_at" | "completed_at">): number | null {
  if (!run.completed_at) return null;
  const ms = new Date(run.completed_at).getTime() - new Date(run.created_at).getTime();
  return Number.isNaN(ms) || ms < 0 ? null : ms;
}

// ---------- run history ----------

export type HistoryMode = "all" | "demo" | "live";
export type HistoryRange = "10" | "30" | "all";

/** Runs of a mode, newest first, cut to the chosen range. */
export function filterHistory(runs: RunSummary[], mode: HistoryMode, range: HistoryRange): RunSummary[] {
  const matching = runs
    .filter((r) => mode === "all" || r.mode === mode)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return range === "all" ? matching : matching.slice(0, Number(range));
}

/** Completed runs oldest first, the order trend charts read in. */
export function completedChronological(runs: RunSummary[]): RunSummary[] {
  return runs.filter((r) => r.status === "completed").sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Middle value, or null for an empty list. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface HistorySummary {
  total: number;
  completed: number;
  failed: number;
  successPct: number | null;
  medianMs: number | null;
  latestCoverage: number | null;
}

export function historySummary(runs: RunSummary[]): HistorySummary {
  const finished = completedChronological(runs);
  const failed = runs.filter((r) => r.status === "failed").length;
  const settled = finished.length + failed;
  const durations = finished.map(runDurationMs).filter((ms): ms is number => ms !== null);
  return {
    total: runs.length,
    completed: finished.length,
    failed,
    successPct: settled ? Math.round((100 * finished.length) / settled) : null,
    medianMs: median(durations),
    latestCoverage: finished[finished.length - 1]?.stats.coverage_pct ?? null,
  };
}

/** Sparkline values for a statistic: the same-mode completed runs up to this one. */
export function sparkValues(runs: RunSummary[], run: RunDetail, read: (r: RunSummary) => number | undefined, points = 12): number[] {
  const history = completedChronological(runs).filter((r) => r.mode === run.mode && r.created_at <= run.created_at);
  return history.slice(-points).map(read).filter((v): v is number => v !== undefined);
}

// ---------- chart scales ----------

/** Evenly spaced round axis values from zero that reach at least `max`. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 5, 10].find((m) => m * magnitude >= rough) ?? 10) * magnitude;
  // counts cannot be fractional, so small integer scales stay on whole numbers
  const safeStep = Number.isInteger(max) ? Math.max(1, step) : step;
  const ticks: number[] = [];
  for (let v = 0; v < max + safeStep; v += safeStep) {
    ticks.push(Math.round(v * 1000) / 1000);
    if (v >= max) break;
  }
  return ticks;
}

// ---------- export ----------

/** Quote one CSV value. Text starting a formula is defused, as live feeds supply some of it. */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function actionsCsv(items: RemediationItem[]): string {
  return toCsv(
    ["Rank", "Priority", "Risk score", "Severity", "Title", "Citation", "Owner", "Target date", "Gap", "Actions"],
    items.map((i) => [i.rank, i.priority, i.risk_score, i.severity, i.title, i.citation, i.owner, i.target_date, i.gap_id, i.actions.join("; ")]),
  );
}

export function runsCsv(runs: RunSummary[]): string {
  return toCsv(
    ["Run", "Started", "Mode", "Status", "LLM", "Obligations", "Coverage %", "Accepted", "Escalated", "Withdrawn", "Rejections", "Duration ms"],
    runs.map((r) => [
      r.id, r.created_at, r.mode, r.status, `${r.llm_provider}/${r.llm_model}`, r.stats.obligations, r.stats.coverage_pct,
      r.stats.accepted_gaps, r.stats.escalated_gaps, r.stats.withdrawn_gaps, r.stats.rejection_events, runDurationMs(r),
    ]),
  );
}

/** File-name-safe name for an export scoped to a run. */
export function exportName(kind: string, runId: string): string {
  return `regradar-${kind}-${shortId(runId)}.csv`;
}

/** Offer text to the browser as a file download. */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
