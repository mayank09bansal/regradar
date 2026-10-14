import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, EmptyState, SeverityBadge } from "../components/ui";
import type { RemediationItem, Severity } from "../types";
import { ChartCard, HeatGrid, Legend, RankedBars, StackedRows } from "./charts";
import {
  actionsCsv, DEADLINE_BUCKETS, daysUntil, downloadText, dueLabel, EMPTY_ACTION_FILTERS, exportName, filterActions, formatDay,
  gapTypeTally, humanize, ownerLoads, PRIORITIES, riskGrid, SEVERITIES, topicTally,
  type ActionFilters, type ActionSort, type DeadlineBucket, type Priority, type RiskCell, type RunView, type Tally,
} from "./metrics";
import { priorityParts, PRIORITY_LEGEND } from "./parts";

const SEVERITY_ROWS = SEVERITIES.map((id) => ({ id, label: humanize(id) }));
const BUCKET_COLUMNS = DEADLINE_BUCKETS.map((b) => ({ id: b.id, label: b.label }));

const SORT_OPTIONS: { id: ActionSort; label: string }[] = [
  { id: "rank", label: "Rank" },
  { id: "target_date", label: "Target date" },
  { id: "risk_score", label: "Risk score" },
  { id: "owner", label: "Owner" },
];

/** Severity against time left. Picking a cell narrows the action queue below. */
function RiskGridCard({ view, now, cell, onCell }: { view: RunView; now: Date; cell: RiskCell | null; onCell: (cell: RiskCell | null) => void }) {
  const grid = useMemo(() => riskGrid(view.plan, now), [view.plan, now]);
  return (
    <Card title="Risk grid" className="dash-span" actions={<span className="muted small">{view.plan.length} action(s)</span>}>
      <p className="muted small viz-subtitle">Actions by severity and time to target. Select a cell to filter the queue.</p>
      <HeatGrid<Severity, DeadlineBucket>
        corner="Severity"
        rows={SEVERITY_ROWS}
        columns={BUCKET_COLUMNS}
        value={(severity, bucket) => grid.get(`${severity}:${bucket}`) ?? 0}
        selected={cell && { row: cell.severity, column: cell.bucket }}
        onPick={(severity, bucket) =>
          onCell(cell?.severity === severity && cell.bucket === bucket ? null : { severity, bucket })}
      />
    </Card>
  );
}

/** Who carries the risk, strongest exposure first. */
function OwnerCard({ view, onOwner }: { view: RunView; onOwner: (owner: string) => void }) {
  const loads = useMemo(() => ownerLoads(view.plan), [view.plan]);
  return (
    <ChartCard
      title="Owner workload"
      subtitle="Sorted by total risk score carried."
      table={{
        headers: ["Owner", "P1", "P2", "P3", "Total", "Risk score", "Next due"],
        rows: loads.map((l) => [l.owner, l.byPriority.P1, l.byPriority.P2, l.byPriority.P3, l.total, l.risk.toFixed(1), formatDay(l.nextDue)]),
      }}
    >
      {loads.length ? (
        <>
          <StackedRows
            unit="actions"
            rows={loads.map((l) => ({ key: l.owner, label: l.owner, hint: `risk ${l.risk.toFixed(1)}`, parts: priorityParts(l) }))}
          />
          <Legend items={PRIORITY_LEGEND} />
          <div className="dash-owner-links small">
            <span className="muted">Filter queue:</span>
            {loads.map((l) => <button key={l.owner} type="button" className="link-btn" onClick={() => onOwner(l.owner)}>{l.owner}</button>)}
          </div>
        </>
      ) : <p className="muted">No remediation actions in this view.</p>}
    </ChartCard>
  );
}

/** Counted breakdown as ranked bars, with its table twin. */
function TallyCard({ title, subtitle, items, unit }: { title: string; subtitle: string; items: Tally[]; unit: string }) {
  return (
    <ChartCard title={title} subtitle={subtitle} table={{ headers: [title, humanize(unit)], rows: items.map((i) => [i.label, i.value]) }}>
      {items.length ? <RankedBars items={items} unit={unit} /> : <p className="muted">No open gaps in this view.</p>}
    </ChartCard>
  );
}

/** Text showing how a risk score was reached, e.g. "10 x 1.4 x 1.25 x 1". */
function scoreFormula(item: RemediationItem): string {
  return Object.values(item.score_breakdown).join(" x ");
}

/** Queue row and its expandable detail; the detail row exists only while open. */
function ActionRow({ item, now, runId }: { item: RemediationItem; now: Date; runId: string }) {
  const [open, setOpen] = useState(false);
  const days = daysUntil(item.target_date, now);
  return (
    <Fragment>
      <tr className={days !== null && days < 0 ? "dash-row-overdue" : ""}>
        <td className="num">{item.rank}</td>
        <td><span className={`prio prio-${item.priority}`}>{item.priority}</span></td>
        <td className="dash-queue-title">
          <button type="button" className="link-btn dash-expand" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{item.title}</button>
          <div className="mono small muted">{item.citation}</div>
        </td>
        <td><SeverityBadge severity={item.severity} /></td>
        <td>{item.owner}</td>
        <td className="nowrap">{formatDay(item.target_date)}<div className="small muted">{dueLabel(days)}</div></td>
        <td className="num">{item.risk_score.toFixed(1)}</td>
      </tr>
      {open && (
        <tr className="dash-queue-detail">
          <td />
          <td colSpan={6}>
            <strong className="small">Steps</strong>
            <ul className="tight small">{item.actions.map((action) => <li key={action}>{action}</li>)}</ul>
            <div className="small muted">
              Risk score {item.risk_score.toFixed(1)} = {scoreFormula(item)} ({Object.keys(item.score_breakdown).map(humanize).join(", ").toLowerCase()})
            </div>
            <Link className="small" to={`/runs/${runId}/gaps`}>Evidence for {item.gap_id}</Link>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** Every remediation action: searchable, filterable, sortable and exportable. */
function ActionQueue({ view, now, filters, onFilters }: {
  view: RunView; now: Date; filters: ActionFilters; onFilters: (filters: ActionFilters) => void;
}) {
  const items = useMemo(() => filterActions(view.plan, filters, now), [view.plan, filters, now]);
  const owners = useMemo(() => [...new Set(view.plan.map((p) => p.owner))].sort(), [view.plan]);
  const update = (changes: Partial<ActionFilters>) => onFilters({ ...filters, ...changes });
  const narrowed = filters.query !== "" || filters.priority !== "all" || filters.owner !== "all" || filters.cell !== null;
  const cellLabel = filters.cell && `${humanize(filters.cell.severity)}, ${BUCKET_COLUMNS.find((c) => c.id === filters.cell?.bucket)?.label}`;

  return (
    <Card
      title={`Action queue (${items.length}${narrowed ? ` of ${view.plan.length}` : ""})`}
      actions={
        <button type="button" className="btn btn-secondary dash-btn-s" disabled={!items.length}
          onClick={() => downloadText(exportName("actions", view.run.id), actionsCsv(items))}>
          Export CSV
        </button>
      }
    >
      <div className="dash-queue-tools">
        <input type="search" aria-label="Search actions" placeholder="Search title, citation, owner" value={filters.query}
          onChange={(e) => update({ query: e.target.value })} />
        <select aria-label="Priority" value={filters.priority} onChange={(e) => update({ priority: e.target.value as Priority | "all" })}>
          <option value="all">All priorities</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select aria-label="Owner" value={filters.owner} onChange={(e) => update({ owner: e.target.value })}>
          <option value="all">All owners</option>
          {owners.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select aria-label="Sort by" value={filters.sort} onChange={(e) => update({ sort: e.target.value as ActionSort })}>
          {SORT_OPTIONS.map((s) => <option key={s.id} value={s.id}>Sort: {s.label}</option>)}
        </select>
        {cellLabel && <span className="pill tone-info">{cellLabel}</span>}
        {narrowed && <button type="button" className="link-btn" onClick={() => onFilters({ ...EMPTY_ACTION_FILTERS, sort: filters.sort })}>Clear filters</button>}
      </div>
      {items.length ? (
        <div className="table-wrap">
          <table className="dash-queue">
            <thead><tr><th>#</th><th>Priority</th><th>Action</th><th>Severity</th><th>Owner</th><th>Target</th><th>Risk</th></tr></thead>
            <tbody>{items.map((item) => <ActionRow key={item.gap_id} item={item} now={now} runId={view.run.id} />)}</tbody>
          </table>
        </div>
      ) : <EmptyState title={view.plan.length ? "No actions match these filters" : "No remediation actions in this view"} />}
    </Card>
  );
}

/** Where the risk sits, who owns it and what to do next. */
export default function RiskView({ view, now }: { view: RunView; now: Date }) {
  const [filters, setFilters] = useState<ActionFilters>(EMPTY_ACTION_FILTERS);
  const gapTypes = useMemo(() => gapTypeTally(view), [view]);
  const topics = useMemo(() => topicTally(view), [view]);
  return (
    <>
      <div className="dash-risk-top">
        <RiskGridCard view={view} now={now} cell={filters.cell} onCell={(cell) => setFilters({ ...filters, cell })} />
        <OwnerCard view={view} onOwner={(owner) => setFilters({ ...filters, owner })} />
      </div>
      <ActionQueue view={view} now={now} filters={filters} onFilters={setFilters} />
      <div className="two-col">
        <TallyCard title="Gap type" subtitle="Open gaps by the kind of failure." items={gapTypes} unit="open gaps" />
        <TallyCard title="Topic" subtitle="Open gaps by obligation topic. A gap counts once per topic." items={topics} unit="open gaps" />
      </div>
    </>
  );
}
