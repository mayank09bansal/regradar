import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Card, EmptyState, SeverityBadge, StatusPill } from "../components/ui";
import { shortId } from "../lib";
import type { Gap, RunSummary } from "../types";
import { ChartCard, Legend, SegmentedBar, Sparkline, StackedRows } from "./charts";
import {
  ALL_REGULATORS, attentionItems, compareRuns, deadlineDays, deltaInfo, dueLabel, formatDay, sparkValues, viewFigures,
  type AttentionItem, type GoodDirection, type RunView, type ViewFigures,
} from "./metrics";
import { COVERAGE_LEGEND, coverageParts } from "./parts";

/** Most dates listed before the deadlines card points on to the full plan. */
const DEADLINE_LIMIT = 6;
/** Most gaps listed per change group. */
const CHANGE_LIMIT = 4;

/** Signed change against the baseline run; the sign keeps it readable without colour. */
function Delta({ current, previous, good, unit = "" }: { current: number; previous?: number | null; good: GoodDirection; unit?: string }) {
  const delta = deltaInfo(current, previous, good);
  if (!delta) return null;
  if (delta.value === 0) return <span className="dash-delta flat">no change</span>;
  const sign = delta.value > 0 ? "+" : "-";
  return <span className={`dash-delta ${delta.tone}`}>{sign}{Math.abs(delta.value)}{unit}</span>;
}

/** The dashboard's one hero figure: how much of the regulation is fully met. */
function PostureCard({ view, baseline }: { view: RunView; baseline: RunView | null }) {
  const { counts } = view;
  const scope = view.regulator === ALL_REGULATORS ? "all regulators" : view.regulator;
  if (!counts.total) {
    return <Card title="Compliance posture" className="dash-posture"><EmptyState title="No obligations in this run" /></Card>;
  }
  return (
    <Card title="Compliance posture" className="dash-posture" actions={<span className="muted small">{scope}</span>}>
      <div className="dash-hero">
        <span className="dash-hero-value">{counts.pct}%</span>
        <div>
          <div className="dash-hero-label">of obligations fully covered</div>
          <div className="small muted">
            {counts.covered} of {counts.total}, partial coverage not counted{" "}
            {baseline && <><Delta current={counts.pct} previous={baseline.counts.pct} good="up" unit=" pts" /></>}
          </div>
        </div>
      </div>
      <SegmentedBar tall parts={coverageParts(counts)} label={`Coverage of ${counts.total} obligations`} />
      <div className="dash-posture-foot">
        <Legend items={COVERAGE_LEGEND} />
        <Link className="small" to={`/runs/${view.run.id}/coverage`}>Coverage matrix</Link>
      </div>
    </Card>
  );
}

const TONE_MARK: Record<AttentionItem["tone"], string> = { bad: "!", esc: "?", warn: "!", info: "i" };

/** Ranked to-do list; a quiet state here is itself useful information. */
function AttentionCard({ view, now }: { view: RunView; now: Date }) {
  const items = useMemo(() => attentionItems(view, now), [view, now]);
  return (
    <Card title="Needs attention" className="dash-attention" actions={items.length > 0 && <span className="pill tone-bad">{items.length}</span>}>
      {items.length ? (
        <ul className="dash-attn-list">
          {items.map((item) => (
            <li key={item.id}>
              <Link to={item.to} className={`dash-attn tone-line-${item.tone}`}>
                <span className={`dash-attn-mark pill tone-${item.tone}`} aria-hidden>{TONE_MARK[item.tone]}</span>
                <span className="dash-attn-text">
                  <strong>{item.title}</strong>
                  <span className="muted small">{item.detail}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : <p className="muted">Nothing is overdue, escalated or failing in this view.</p>}
    </Card>
  );
}

/** Stat tile with a change against the baseline run and a recent trend. */
function KpiTile({ label, value, hint, trend, delta }: {
  label: string; value: ReactNode; hint?: ReactNode; trend?: number[]; delta?: ReactNode;
}) {
  return (
    <div className="dash-kpi">
      <div className="dash-kpi-label">{label}</div>
      <div className="dash-kpi-main">
        <span className="dash-kpi-value">{value}</span>
        {trend && <Sparkline values={trend} label={label} />}
      </div>
      <div className="dash-kpi-foot">{delta}{hint && <span className="muted">{hint}</span>}</div>
    </div>
  );
}

/** Run-level trends can't be narrowed by regulator, so sparklines hide while a filter is on. */
function KpiStrip({ view, baseline, runs, now }: { view: RunView; baseline: RunView | null; runs: RunSummary[]; now: Date }) {
  const figures = viewFigures(view);
  const before = baseline ? viewFigures(baseline) : null;
  const filtered = view.regulator !== ALL_REGULATORS;
  const trend = (read: (r: RunSummary) => number | undefined) => (filtered ? undefined : sparkValues(runs, view.run, read));
  const next = deadlineDays(view, now).find((d) => d.days >= 0);
  const pair = (key: keyof ViewFigures, good: GoodDirection) => <Delta current={figures[key]} previous={before?.[key]} good={good} />;
  return (
    <div className="dash-kpis">
      <KpiTile label="Open gaps" value={figures.openGaps} hint="accepted or escalated" delta={pair("openGaps", "down")}
        trend={trend((r) => (r.stats.accepted_gaps === undefined ? undefined : r.stats.accepted_gaps + (r.stats.escalated_gaps ?? 0)))} />
      <KpiTile label="Escalated" value={figures.escalated} hint="human decision" delta={pair("escalated", "down")}
        trend={trend((r) => r.stats.escalated_gaps)} />
      <KpiTile label="P1 actions" value={figures.p1Actions} hint={`of ${view.plan.length} planned`} delta={pair("p1Actions", "down")} />
      <KpiTile label="Rejections" value={figures.rejections} hint="by the validator" delta={pair("rejections", "neutral")}
        trend={trend((r) => r.stats.rejection_events)} />
      <KpiTile label="Obligations" value={figures.obligations} hint={`${view.documents.length} document${view.documents.length === 1 ? "" : "s"}`}
        delta={pair("obligations", "neutral")} trend={trend((r) => r.stats.obligations)} />
      <KpiTile label="Next deadline" value={next ? (next.days === 0 ? "Today" : `${next.days}d`) : "-"} hint={next ? formatDay(next.date) : "none upcoming"} />
    </div>
  );
}

function GapLine({ gap, runId, note }: { gap: Gap; runId: string; note?: string }) {
  return (
    <li>
      <SeverityBadge severity={gap.severity} />
      <Link to={`/runs/${runId}/gaps`} className="dash-gap-title">{gap.title}</Link>
      {note && <span className="muted small">{note}</span>}
    </li>
  );
}

function ChangeGroup({ title, count, children }: { title: string; count: number; children: ReactNode[] }) {
  if (!count) return null;
  return (
    <div className="dash-change-group">
      <h3>{title} <span className="muted">{count}</span></h3>
      <ul className="dash-gap-lines">{children.slice(0, CHANGE_LIMIT)}</ul>
      {count > CHANGE_LIMIT && <p className="muted small">and {count - CHANGE_LIMIT} more</p>}
    </div>
  );
}

/** What moved between two runs, matched on obligation rather than on per-run gap ids. */
function ChangesCard({ view, baseline, baselineOff, loading, error }: {
  view: RunView; baseline: RunView | null; baselineOff: boolean; loading: boolean; error: string | null;
}) {
  const comparison = useMemo(() => (baseline ? compareRuns(view, baseline) : null), [view, baseline]);
  const runId = view.run.id;
  let body: ReactNode;
  if (error) body = <p className="bad-text small">The comparison run could not be loaded: {error}</p>;
  else if (!comparison || !baseline) {
    body = <p className="muted">{baselineOff ? "Comparison is off." : loading ? "Loading comparison..." : "No earlier completed run of this mode to compare with."}</p>;
  } else {
    const { added, resolved, changed, unchanged } = comparison;
    const moved = added.length + resolved.length + changed.length;
    body = (
      <>
        {baseline.run.mode !== view.run.mode && (
          <p className="warn-text small">This compares a {view.run.mode} run with a {baseline.run.mode} run, so differences may come from the mode.</p>
        )}
        <div className="dash-change-totals">
          <span><strong>{added.length}</strong> new</span>
          <span><strong>{resolved.length}</strong> closed</span>
          <span><strong>{changed.length}</strong> changed</span>
          <span><strong>{unchanged}</strong> unchanged</span>
        </div>
        {moved === 0 && <p className="muted">Every open gap matches the comparison run.</p>}
        <ChangeGroup title="New gaps" count={added.length}>
          {added.map((g) => <GapLine key={g.id} gap={g} runId={runId} />)}
        </ChangeGroup>
        <ChangeGroup title="No longer open" count={resolved.length}>
          {resolved.map((g) => <GapLine key={g.id} gap={g} runId={baseline.run.id} />)}
        </ChangeGroup>
        <ChangeGroup title="Changed" count={changed.length}>
          {changed.map((c) => <GapLine key={c.gap.id} gap={c.gap} runId={runId} note={c.fields.join(", ")} />)}
        </ChangeGroup>
      </>
    );
  }
  return (
    <Card title="Changes since comparison run" actions={baseline && <span className="mono small">{shortId(baseline.run.id)}</span>}>
      {body}
    </Card>
  );
}

/** Coverage per regulation, taken from the coverage items so the regulator filter applies. */
function DocumentCoverageCard({ view }: { view: RunView }) {
  const rows = view.documents.map((doc) => {
    const items = view.coverage.filter((c) => c.obligation_id.startsWith(`${doc.id}:`));
    const count = (status: string) => items.filter((c) => c.status === status).length;
    return { doc, covered: count("covered"), partial: count("partial"), gap: count("gap") };
  });
  return (
    <ChartCard
      title="Coverage by regulation"
      subtitle="Bar length is the obligation count, so bigger regulations read as longer."
      table={{
        headers: ["Regulation", "Regulator", "Covered", "Partial", "Gap"],
        rows: rows.map((r) => [r.doc.id, r.doc.regulator, r.covered, r.partial, r.gap]),
      }}
    >
      {rows.length ? (
        <>
          <StackedRows
            unit="obligations"
            rows={rows.map((r) => ({ key: r.doc.id, label: r.doc.id, hint: r.doc.regulator, parts: coverageParts(r) }))}
          />
          <Legend items={COVERAGE_LEGEND} />
        </>
      ) : <p className="muted">No regulations in this view.</p>}
    </ChartCard>
  );
}

/** Regulation dates and action targets on one list, as both set the real timetable. */
function DeadlinesCard({ view, now }: { view: RunView; now: Date }) {
  const days = useMemo(() => deadlineDays(view, now), [view, now]);
  return (
    <Card title="Upcoming deadlines" actions={<Link to={`/runs/${view.run.id}/remediation`}>Remediation plan</Link>}>
      {days.length ? (
        <ol className="dash-deadlines">
          {days.slice(0, DEADLINE_LIMIT).map((day) => (
            <li key={day.date} className={day.days < 0 ? "overdue" : ""}>
              <div className="dash-date">
                <strong>{formatDay(day.date)}</strong>
                <span className="small muted">{dueLabel(day.days)}</span>
              </div>
              <div className="dash-date-items">
                {day.documents.map((doc) => (
                  <div key={doc.id} className="small"><span className="pill tone-info">takes effect</span> {doc.id}</div>
                ))}
                {day.actions.length > 0 && (
                  <div className="small">
                    <span className="pill tone-muted">{day.actions.length} action{day.actions.length === 1 ? "" : "s"}</span>{" "}
                    {[...new Set(day.actions.map((a) => a.owner))].join(", ")}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="muted">No dated actions or regulations in this view.</p>}
      {days.length > DEADLINE_LIMIT && <p className="muted small">{days.length - DEADLINE_LIMIT} later date(s) in the plan.</p>}
    </Card>
  );
}

/** Written conclusion of the run; filtered figures can't change it, so it says so. */
function SummaryCard({ view }: { view: RunView }) {
  const { report } = view.run;
  if (!report) return null;
  return (
    <Card title="Executive summary" actions={<Link to={`/runs/${view.run.id}/report`}>Final report</Link>}>
      {view.regulator !== ALL_REGULATORS && <p className="muted small">This summary covers the whole run, not only {view.regulator}.</p>}
      <p className="dash-summary">{report.executive_summary}</p>
      <p className="muted small">{report.reasoning_note}</p>
      {report.disclaimers.length > 0 && (
        <ul className="tight small muted">
          {report.disclaimers.map((text) => <li key={text}>{text}</li>)}
        </ul>
      )}
    </Card>
  );
}

/** Landing view: posture first, then what to do about it. */
export default function OverviewView({ view, baseline, baselineOff, baselineLoading, baselineError, runs, now }: {
  view: RunView;
  baseline: RunView | null;
  baselineOff: boolean;
  baselineLoading: boolean;
  baselineError: string | null;
  runs: RunSummary[];
  now: Date;
}) {
  // an unfinished run's empty results are missing data, not zero gaps, so comparing them
  // with a finished run would show every open gap as fixed
  const finished = view.run.status === "completed";
  return (
    <>
      <div className="dash-top">
        <PostureCard view={view} baseline={finished ? baseline : null} />
        <AttentionCard view={view} now={now} />
      </div>
      {finished ? <KpiStrip view={view} baseline={baseline} runs={runs} now={now} /> : (
        <p className="muted small dash-unfinished">
          Status <StatusPill status={view.run.status} />: this run has no final results, so figures and comparisons are not shown.
        </p>
      )}
      <div className="two-col">
        {finished && <ChangesCard view={view} baseline={baseline} baselineOff={baselineOff} loading={baselineLoading} error={baselineError} />}
        <DeadlinesCard view={view} now={now} />
      </div>
      <DocumentCoverageCard view={view} />
      <SummaryCard view={view} />
    </>
  );
}
