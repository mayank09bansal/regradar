import type { ReactNode } from "react";
import RunScope from "../components/RunScope";
import { Card, EmptyState, SeverityBadge, StatusPill } from "../components/ui";
import { reasoningLabel } from "../lib";
import type { Gap, RunDetail, ValidationDecision } from "../types";

function display(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "string") return v.length > 140 ? `${v.slice(0, 140)}...` : v;
  return JSON.stringify(v);
}

function GapLoop({ gap, decisions }: { gap: Gap; decisions: ValidationDecision[] }) {
  // interleave: proposal/revision records with the validation decision that followed each
  const steps: { kind: "synth" | "val"; key: string; node: ReactNode }[] = [];
  gap.history.forEach((h) => {
    steps.push({
      kind: "synth", key: `h${h.revision}${h.action}`,
      node: (
        <>
          <div className="step-title">Gap Synthesiser - {h.action} (revision {h.revision})</div>
          {h.response_to_feedback && <p className="small">{h.response_to_feedback}</p>}
          {Object.keys(h.changes).length > 0 && (
            <table className="diff">
              <tbody>
                {Object.entries(h.changes).map(([field, c]) => (
                  <tr key={field}><th>{field}</th><td className="from">{display(c.from)}</td><td className="to">{display(c.to)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {h.reasoning_source && <span className="pill tone-demo small">{reasoningLabel(h.reasoning_source)}</span>}
        </>
      ),
    });
    const d = decisions.find((x) => x.gap_revision === h.revision);
    if (d && h.action !== "withdrawn") {
      steps.push({
        kind: "val", key: `d${d.round}`,
        node: (
          <>
            <div className="step-title">Novelty Validator - round {d.round}: <StatusPill status={d.decision} /></div>
            {d.issues.length ? (
              <ul className="issues">
                {d.issues.map((i) => (
                  <li key={i.code}>
                    <code>{i.code}</code> {i.message}
                    {i.expected !== null && i.expected !== undefined && <span className="muted"> (expected: {display(i.expected)})</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="small good-text">All {d.checks_run.length} checks passed.</p>}
          </>
        ),
      });
    }
  });
  return (
    <div className={`loop-card status-${gap.status}`}>
      <div className="loop-head">
        <span className="mono">{gap.id}</span>
        <strong>{gap.title}</strong>
        <SeverityBadge severity={gap.severity} />
        <StatusPill status={gap.status} />
      </div>
      <div className="small muted">{gap.citation}{gap.known_issue_id ? ` - linked to ${gap.known_issue_id}` : ""}</div>
      <ol className="loop-steps">
        {steps.map((s) => <li key={s.key} className={`loop-step ${s.kind}`}>{s.node}</li>)}
      </ol>
      {gap.status === "escalated" && <div className="esc-note">Escalated to a human reviewer: the validator and synthesiser still disagree at the revision limit.</div>}
    </div>
  );
}

function Rounds({ run }: { run: RunDetail }) {
  const rounds = Array.from(new Set(run.validation_decisions.map((d) => d.round))).sort((a, b) => a - b);
  return (
    <div className="round-strip">
      {rounds.map((r) => {
        const ds = run.validation_decisions.filter((d) => d.round === r);
        const rej = ds.filter((d) => d.decision === "reject").length;
        return (
          <div key={r} className="round-box">
            <div className="round-num">Round {r}</div>
            <div><span className="good-text">{ds.length - rej} accepted</span> / <span className="bad-text">{rej} rejected</span></div>
          </div>
        );
      })}
      {run.stats.escalated_gaps ? <div className="round-box esc">Escalation: {run.stats.escalated_gaps}</div> : null}
    </div>
  );
}

export default function FeedbackLoopPage() {
  return (
    <RunScope
      title="Feedback Loop"
      subtitle="Gap Synthesiser -> Novelty Validator -> Gap Synthesiser: proposals, structured rejections, revisions and re-validation from this run."
    >
      {(run) => {
        const looped = run.gaps.filter((g) => g.history.length > 1 || g.status === "escalated");
        const firstPass = run.gaps.filter((g) => g.history.length === 1 && g.status === "accepted");
        if (!run.gaps.length) return <EmptyState title="No gaps were proposed in this run" />;
        return (
          <>
            {run.mode === "demo" && (
              <div className="notice">
                Demo mode: the synthesiser's first draft comes from the deterministic demo responder, which contains documented
                drafting mistakes. The validator's rejections below come from its real rule checks; revisions are computed
                from the feedback codes. The graph routing is real LangGraph execution.
              </div>
            )}
            <Rounds run={run} />
            <Card title={`Gaps that went through the loop (${looped.length})`}>
              {looped.length ? looped.map((g) => (
                <GapLoop key={g.id} gap={g} decisions={run.validation_decisions.filter((d) => d.gap_id === g.id)} />
              )) : <p className="muted">Every proposal was accepted first time - the loop was not triggered.</p>}
            </Card>
            <Card title={`Accepted on first validation (${firstPass.length})`}>
              <ul className="plain-list">
                {firstPass.map((g) => (
                  <li key={g.id}><span className="mono">{g.id}</span> {g.title} <SeverityBadge severity={g.severity} /></li>
                ))}
              </ul>
            </Card>
          </>
        );
      }}
    </RunScope>
  );
}
