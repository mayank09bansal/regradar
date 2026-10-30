import { useMemo, useState } from "react";
import RunScope from "../components/RunScope";
import { Card, Stat, StatusPill } from "../components/ui";
import type { CoverageItem, RunDetail } from "../types";

/** Coverage summary and the filterable obligation-to-control table. */
function Matrix({ run }: { run: RunDetail }) {
  const [status, setStatus] = useState<string>("");
  const [regulator, setRegulator] = useState<string>("");
  const regulators = Array.from(new Set(run.coverage.map((c) => c.regulator)));
  const items = useMemo(
    () => run.coverage.filter((c: CoverageItem) => (!status || c.status === status) && (!regulator || c.regulator === regulator)),
    [run.coverage, status, regulator],
  );
  const count = (k: string) => run.coverage.filter((c) => c.status === k).length;
  const total = run.coverage.length || 1;

  return (
    <>
      <div className="stats-grid three">
        <Stat label="Covered" value={count("covered")} tone="good" hint={`${Math.round((100 * count("covered")) / total)}% of obligations`} />
        <Stat label="Partially covered" value={count("partial")} tone="warn" hint="related control with a shortfall or weak match" />
        <Stat label="Not covered" value={count("gap")} tone="bad" hint="no control above the partial threshold" />
      </div>
      <div className="coverage-bar" aria-label="Coverage distribution">
        <span className="seg good" style={{ flex: count("covered") }} />
        <span className="seg warn" style={{ flex: count("partial") }} />
        <span className="seg bad" style={{ flex: count("gap") }} />
      </div>
      <Card
        title={`Obligation-to-control matrix (${items.length})`}
        actions={
          <div className="filters">
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
              <option value="">All statuses</option>
              <option value="covered">Covered</option>
              <option value="partial">Partial</option>
              <option value="gap">Gap</option>
            </select>
            <select value={regulator} onChange={(e) => setRegulator(e.target.value)} aria-label="Filter by regulator">
              <option value="">All regulators</option>
              {regulators.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        }
      >
        <div className="table-wrap">
          <table className="matrix">
            <thead>
              <tr><th>Citation</th><th>Obligation</th><th>Strength</th><th>Status</th><th>Best control</th><th>Score</th><th>Shortfalls / rationale</th></tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.obligation_id} className={`row-${c.status}`}>
                  <td className="mono small nowrap">{c.citation}</td>
                  <td className="obl-text">{c.obligation_text}</td>
                  <td>{c.strength}</td>
                  <td><StatusPill status={c.status} /></td>
                  <td>{c.best_control_id ? <><span className="mono small">{c.best_control_id}</span><div className="small muted">{c.best_control_title}</div></> : <span className="muted">none</span>}</td>
                  <td>
                    <div className="score"><span style={{ width: `${Math.min(100, c.similarity * 100)}%` }} /></div>
                    <span className="small">{c.similarity.toFixed(2)}</span>
                  </td>
                  <td className="small">
                    {c.shortfalls.length ? <ul className="tight">{c.shortfalls.map((s) => <li key={s}>{s}</li>)}</ul> : c.rationale}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Score = 0.65 x TF-IDF cosine similarity + 0.35 x keyword overlap. Covered at 0.42 and above with no parameter shortfall; partial from 0.20.</p>
      </Card>
    </>
  );
}

/** Control Mapper output for the selected run. */
export default function CoveragePage() {
  return (
    <RunScope title="Coverage Matrix" subtitle="Control Mapper output: how well each extracted obligation is covered by Acme Pay's control library.">
      {(run) => <Matrix run={run} />}
    </RunScope>
  );
}
