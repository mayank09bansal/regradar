import type { BarPart, LegendEntry } from "./charts";
import { PRIORITIES, type CoverageCounts, type OwnerLoad } from "./metrics";

/** Fixed colour per coverage status, so a status looks the same in every chart. */
const COVERAGE_COLORS = { covered: "var(--viz-good)", partial: "var(--viz-warn)", gap: "var(--viz-bad)" };

export const COVERAGE_LEGEND: LegendEntry[] = [
  { label: "Covered", color: COVERAGE_COLORS.covered },
  { label: "Partial", color: COVERAGE_COLORS.partial },
  { label: "Gap", color: COVERAGE_COLORS.gap },
];

/** Pick the three coverage counts from anything carrying them, such as a report row. */
export function coverageParts(counts: Pick<CoverageCounts, "covered" | "partial" | "gap">): BarPart[] {
  return [
    { key: "covered", label: "Covered", value: counts.covered, color: COVERAGE_COLORS.covered },
    { key: "partial", label: "Partial", value: counts.partial, color: COVERAGE_COLORS.partial, darkInk: true },
    { key: "gap", label: "Gap", value: counts.gap, color: COVERAGE_COLORS.gap },
  ];
}

const PRIORITY_COLORS = { P1: "var(--viz-bad)", P2: "var(--viz-warn)", P3: "var(--viz-1)" };

export const PRIORITY_LEGEND: LegendEntry[] = PRIORITIES.map((p) => ({ label: p, color: PRIORITY_COLORS[p] }));

export function priorityParts(load: OwnerLoad): BarPart[] {
  return PRIORITIES.map((p) => ({ key: p, label: p, value: load.byPriority[p], color: PRIORITY_COLORS[p], darkInk: p === "P2" }));
}

/** Accept and reject share a chart, so they reuse the good and bad status colours. */
export const DECISION_LEGEND: LegendEntry[] = [
  { label: "Accepted", color: "var(--viz-good)" },
  { label: "Rejected", color: "var(--viz-bad)" },
];
