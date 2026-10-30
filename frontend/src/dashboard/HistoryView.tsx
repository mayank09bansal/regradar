import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, EmptyState, ModeBadge, Stat, StatusPill } from "../components/ui";
import { formatDateTime, shortId } from "../lib";
import type { RunSummary } from "../types";
import { ChartCard, Legend, LineChart, type LineSeries } from "./charts";
import {
  completedChronological, downloadText, exportName, filterHistory, formatMs, formatRunTime, historySummary, runDurationMs, runsCsv,
  type HistoryMode, type HistoryRange,
} from "./metrics";

const MODES: HistoryMode[] = ["all", "demo", "live"];
const RANGES: { id: HistoryRange; label: string }[] = [
  { id: "10", label: "Last 10" },
  { id: "30", label: "Last 30" },
  { id: "all", label: "All" },
];

/** Three distinct measures, so they get three charts rather than a shared scale. */
function TrendCharts({ runs, currentId, onPick }: { runs: RunSummary[]; currentId: string | null; onPick: (id: string) => void }) {
  const ordered = useMemo(() => completedChronological(runs), [runs]);
  if (!ordered.length) return <EmptyState title="No completed runs in this range" />;

  const labels = ordered.map((r) => formatRunTime(r.created_at));
  const read = (key: "coverage_pct" | "accepted_gaps" | "escalated_gaps" | "withdrawn_gaps" | "rejection_events") =>
    ordered.map((r) => r.stats[key] ?? null);
  const outcomes: LineSeries[] = [
    { key: "accepted", label: "Accepted", color: "var(--viz-1)", values: read("accepted_gaps") },
    { key: "escalated", label: "Escalated", color: "var(--viz-2)", values: read("escalated_gaps") },
    { key: "withdrawn", label: "Withdrawn", color: "var(--viz-3)", values: read("withdrawn_gaps") },
  ];
  const selected = ordered.findIndex((r) => r.id === currentId);
  const shared = {
    labels,
    // the time alone can't separate runs started in the same minute
    tipTitles: ordered.map((r) => `${shortId(r.id)}, ${r.mode}`),
    selected: selected >= 0 ? selected : undefined,
    onPick: (i: number) => onPick(ordered[i].id),
  };
  const row = (r: RunSummary) => [shortId(r.id), formatRunTime(r.created_at)];

  return (
    <>
      <ChartCard
        title="Gap outcomes per run"
        subtitle="Select a point to open that run."
        table={{
          headers: ["Run", "Started", "Accepted", "Escalated", "Withdrawn"],
          rows: ordered.map((r) => [...row(r), r.stats.accepted_gaps ?? "-", r.stats.escalated_gaps ?? "-", r.stats.withdrawn_gaps ?? "-"]),
        }}
      >
        <LineChart {...shared} label="Gap outcomes per run" series={outcomes} />
        <Legend kind="line" items={outcomes} />
      </ChartCard>
      <div className="two-col">
        <ChartCard
          title="Fully covered obligations"
          table={{ headers: ["Run", "Started", "Fully covered"], rows: ordered.map((r) => [...row(r), r.stats.coverage_pct === undefined ? "-" : `${r.stats.coverage_pct}%`]) }}
        >
          <LineChart {...shared} height={160} yMax={100} format={(v) => `${v}%`} label="Fully covered obligations per run"
            series={[{ key: "coverage", label: "Fully covered", color: "var(--viz-1)", values: read("coverage_pct") }]} />
        </ChartCard>
        <ChartCard
          title="Validator rejections"
          table={{ headers: ["Run", "Started", "Rejections"], rows: ordered.map((r) => [...row(r), r.stats.rejection_events ?? "-"]) }}
        >
          <LineChart {...shared} height={160} label="Validator rejections per run"
            series={[{ key: "rejections", label: "Rejections", color: "var(--viz-1)", values: read("rejection_events") }]} />
        </ChartCard>
      </div>
    </>
  );
}

/** Run table: open a run, or set it as the comparison for the selected run. */
function RunTable({ runs, currentId, baselineId, onPick, onCompare }: {
  runs: RunSummary[];
  currentId: string | null;
  baselineId: string | null;
  onPick: (id: string) => void;
  onCompare: (id: string) => void;
}) {
  return (
    <Card
      title={`Runs (${runs.length})`}
      actions={
        <div className="row gap-s">
          <button type="button" className="btn btn-secondary dash-btn-s" disabled={!runs.length}
            onClick={() => downloadText(exportName("runs", "history"), runsCsv(runs))}>
            Export CSV
          </button>
          <Link to="/runs">Manage runs</Link>
        </div>
      }
    >
      {runs.length ? (
        <div className="table-wrap">
          <table className="dash-runs">
            <thead>
              <tr>
                <th>Run</th><th>Started</th><th>Mode</th><th>Status</th><th>Covered</th><th>Accepted</th><th>Escalated</th><th>Duration</th><th />
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className={r.id === currentId ? "dash-run-current" : ""}>
                  <td>
                    <button type="button" className="link-btn mono" aria-current={r.id === currentId} onClick={() => onPick(r.id)}>{shortId(r.id)}</button>
                    {r.id === baselineId && <span className="pill tone-muted dash-pill-gap">comparing</span>}
                  </td>
                  <td className="nowrap">{formatDateTime(r.created_at)}</td>
                  <td><ModeBadge mode={r.mode} /></td>
                  <td><StatusPill status={r.status} />{r.error && <div className="small bad-text">{r.error}</div>}</td>
                  <td className="num">{r.stats.coverage_pct === undefined ? "-" : `${r.stats.coverage_pct}%`}</td>
                  <td className="num">{r.stats.accepted_gaps ?? "-"}</td>
                  <td className="num">{r.stats.escalated_gaps ?? "-"}</td>
                  <td className="num">{formatMs(runDurationMs(r))}</td>
                  <td>
                    {r.id !== currentId && r.id !== baselineId && r.status === "completed" && (
                      <button type="button" className="link-btn" onClick={() => onCompare(r.id)}>Compare</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">No runs match these filters.</p>}
    </Card>
  );
}

/** Trends across runs. It covers the whole history, so it has its own mode and range filters. */
export default function HistoryView({ runs, currentId, baselineId, onPick, onCompare }: {
  runs: RunSummary[];
  currentId: string | null;
  baselineId: string | null;
  onPick: (id: string) => void;
  onCompare: (id: string) => void;
}) {
  const [mode, setMode] = useState<HistoryMode>("all");
  const [range, setRange] = useState<HistoryRange>("30");
  const shown = useMemo(() => filterHistory(runs, mode, range), [runs, mode, range]);
  const summary = useMemo(() => historySummary(shown), [shown]);

  return (
    <>
      <div className="dash-filters">
        <div className="seg-control" role="tablist" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.id} type="button" role="tab" aria-selected={range === r.id} className={range === r.id ? "active" : ""} onClick={() => setRange(r.id)}>{r.label}</button>
          ))}
        </div>
        <div className="seg-control" role="tablist" aria-label="Mode">
          {MODES.map((m) => (
            <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>{m}</button>
          ))}
        </div>
      </div>
      <div className="stats-grid">
        <Stat label="Runs" value={summary.total} hint={`${summary.completed} completed, ${summary.failed} failed`} />
        <Stat label="Success rate" value={summary.successPct === null ? "-" : `${summary.successPct}%`} tone="good" hint="of finished runs" />
        <Stat label="Median duration" value={formatMs(summary.medianMs)} tone="info" hint="completed runs" />
        <Stat label="Latest coverage" value={summary.latestCoverage === null ? "-" : `${summary.latestCoverage}%`} tone="info" hint="fully covered" />
      </div>
      <TrendCharts runs={shown} currentId={currentId} onPick={onPick} />
      <RunTable runs={shown} currentId={currentId} baselineId={baselineId} onPick={onPick} onCompare={onCompare} />
    </>
  );
}
