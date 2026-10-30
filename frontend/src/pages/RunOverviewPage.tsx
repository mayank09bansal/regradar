import RunScope from "../components/RunScope";
import { Card, Stat } from "../components/ui";
import { agentLabel, formatDateTime } from "../lib";

/** Summary of one run: figures, executed route and documents. */
export default function RunOverviewPage() {
  return (
    <RunScope title="Run Overview" subtitle="What happened in this run, step by step.">
      {(run) => {
        const s = run.stats;
        return (
          <>
            <div className="stats-grid">
              <Stat label="Documents" value={s.documents ?? 0} />
              <Stat label="Obligations" value={s.obligations ?? 0} />
              <Stat label="Fully covered" value={`${s.coverage_pct ?? 0}%`} tone="info" />
              <Stat label="Accepted gaps" value={s.accepted_gaps ?? 0} tone="good" />
              <Stat label="Withdrawn" value={s.withdrawn_gaps ?? 0} />
              <Stat label="Escalated" value={s.escalated_gaps ?? 0} tone="bad" />
            </div>
            <Card title="Executed route (LangGraph node order)">
              <ol className="route">
                {run.route_history.map((node, i) => (
                  <li key={i} className={node === "gap_synthesiser" || node === "novelty_validator" ? "loop-node" : node === "escalation" ? "esc-node" : ""}>
                    {agentLabel(node)}
                  </li>
                ))}
              </ol>
              <p className="muted small">
                The Gap Synthesiser and Novelty Validator appear {run.route_history.filter((n) => n === "novelty_validator").length} time(s):
                each repeat is one feedback-loop cycle decided by the graph's conditional edge.
              </p>
            </Card>
            <div className="two-col">
              <Card title="Run details">
                <dl className="kv">
                  <dt>Mode</dt><dd>{run.mode}</dd>
                  <dt>Reasoning</dt><dd>{run.llm_provider} / {run.llm_model}</dd>
                  <dt>Started</dt><dd>{formatDateTime(run.created_at)}</dd>
                  <dt>Completed</dt><dd>{formatDateTime(run.completed_at)}</dd>
                  <dt>Trace messages</dt><dd>{run.trace_length}</dd>
                  <dt>Max revisions</dt><dd>{String(run.request.max_revisions ?? "default")}</dd>
                </dl>
              </Card>
              <Card title="Documents analysed">
                <ul className="plain-list">
                  {run.documents.map((d) => (
                    <li key={d.id}>
                      <span className="mono small">{d.id}</span> {d.title}
                      {d.synthetic && <span className="pill tone-warn">synthetic</span>}
                    </li>
                  ))}
                  {!run.documents.length && <li className="muted">No documents were retrieved.</li>}
                </ul>
                {run.source_errors.length > 0 && (
                  <div className="error-box"><strong>Source errors</strong><ul>{run.source_errors.map((e) => <li key={e}>{e}</li>)}</ul></div>
                )}
              </Card>
            </div>
          </>
        );
      }}
    </RunScope>
  );
}
