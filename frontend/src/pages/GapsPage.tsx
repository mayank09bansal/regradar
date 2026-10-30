import { useState } from "react";
import RunScope from "../components/RunScope";
import { Card, EmptyState, SeverityBadge, StatusPill } from "../components/ui";
import { reasoningLabel } from "../lib";
import type { Gap, RunDetail } from "../types";

/** Final gap states a user can filter by. */
const FILTERS = ["all", "accepted", "escalated", "withdrawn"] as const;

/** One gap with its evidence and full validator decision history. */
function GapCard({ gap, run }: { gap: Gap; run: RunDetail }) {
  const decisions = run.validation_decisions.filter((d) => d.gap_id === gap.id);
  return (
    <article className={`gap-card status-${gap.status}`}>
      <header>
        <span className="mono">{gap.id}</span>
        <h3>{gap.title}</h3>
        <div className="row gap-s">
          <SeverityBadge severity={gap.severity} />
          <StatusPill status={gap.status} />
          <span className="pill tone-muted">{gap.classification}</span>
          <span className="pill tone-muted">{gap.gap_type.replace("_", " ")}</span>
        </div>
      </header>
      <dl className="kv">
        <dt>Citation</dt><dd className="mono small">{gap.citation}</dd>
        <dt>Evidence</dt><dd><q>{gap.evidence_quote}</q></dd>
        <dt>Related controls</dt><dd>{gap.related_control_ids.join(", ") || "none"}</dd>
        <dt>Action</dt><dd>{gap.recommended_action}</dd>
        <dt>Origin</dt><dd className="small">{reasoningLabel(gap.reasoning_source)} - revision {gap.revision}</dd>
        {gap.known_issue_id && <><dt>Known issue</dt><dd>{gap.known_issue_id}</dd></>}
      </dl>
      <p className="small">{gap.description}</p>
      <div className="decisions">
        <strong className="small">Validator decisions</strong>
        <table>
          <thead><tr><th>Round</th><th>Rev</th><th>Decision</th><th>Issues</th></tr></thead>
          <tbody>
            {decisions.map((d) => (
              <tr key={d.round}>
                <td>{d.round}</td>
                <td>{d.gap_revision}</td>
                <td><StatusPill status={d.decision} /></td>
                <td className="small">{d.issues.map((i) => i.code).join(", ") || "all checks passed"}{d.llm_notes && <div className="muted">LLM note: {d.llm_notes}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

/** Every gap proposal, filterable by final status. */
export default function GapsPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  return (
    <RunScope title="Gaps & Validation" subtitle="Every gap proposal with its final status, evidence and the Novelty Validator's decision history.">
      {(run) => {
        const gaps = run.gaps.filter((g) => filter === "all" || g.status === filter);
        return (
          <Card
            title={`${gaps.length} gap(s)`}
            actions={
              <div className="seg-control" role="tablist">
                {FILTERS.map((f) => (
                  <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
                    {f} ({f === "all" ? run.gaps.length : run.gaps.filter((g) => g.status === f).length})
                  </button>
                ))}
              </div>
            }
          >
            {gaps.length ? <div className="gap-grid">{gaps.map((g) => <GapCard key={g.id} gap={g} run={run} />)}</div>
              : <EmptyState title="No gaps match this filter" />}
          </Card>
        );
      }}
    </RunScope>
  );
}
