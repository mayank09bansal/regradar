import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card, ErrorBox, Loading } from "../components/ui";
import { agentLabel, formatDateTime, reasoningLabel } from "../lib";
import type { AgentMessage, Health, MessageType, PublicConfig, RunDetail } from "../types";
import { ChartCard, Legend, RankedBars, SegmentedBar, StackedRows, type BarPart } from "./charts";
import {
  agentStats, formatMs, gapOutcomes, rejectionReasons, roundSummaries, runDurationMs, type AgentStat, type GapOutcomes,
} from "./metrics";
import { DECISION_LEGEND } from "./parts";

/** Newest messages shown before the feed points on to the full trace. */
const FEED_LIMIT = 12;

/** Activity filters: each groups the message types a reader looks for together. */
const FEED_FILTERS: { id: string; label: string; types: MessageType[] | null }[] = [
  { id: "all", label: "All", types: null },
  { id: "decisions", label: "Decisions", types: ["decision", "feedback", "escalation"] },
  { id: "revisions", label: "Revisions", types: ["proposal", "revision"] },
  { id: "errors", label: "Errors", types: ["error"] },
];

function PipelineStep({ stat, index, slowest }: { stat: AgentStat; index: number; slowest: number }) {
  const share = stat.durationMs === null ? 0 : (100 * stat.durationMs) / slowest;
  return (
    <div className={`pipe-step ${stat.loop ? "loop" : ""}`}>
      <span className="pipe-num">{index + 1}</span>
      <span className="pipe-name">{agentLabel(stat.id)}</span>
      <span className="pipe-verb">{stat.verb}</span>
      <span className="dash-pipe-time">{formatMs(stat.durationMs)}</span>
      <span className="dash-pipe-track" aria-hidden><span style={{ width: `${share}%` }} /></span>
      <span className="dash-pipe-meta">
        {stat.visits} visit{stat.visits === 1 ? "" : "s"}, {stat.messages} msg{stat.messages === 1 ? "" : "s"}
      </span>
      {stat.fallbacks > 0 && <span className="bad-text small">{stat.fallbacks} LLM fallback(s)</span>}
    </div>
  );
}

/** The six agents with what each actually did in this run, measured from the trace. */
function PipelineCard({ run, messages, error }: { run: RunDetail; messages: AgentMessage[] | null; error: string | null }) {
  const stats = useMemo(() => (messages ? agentStats(messages, run.route_history) : null), [messages, run.route_history]);
  if (error) return <Card title="Agent pipeline"><ErrorBox error={error} /></Card>;
  if (!stats) return <Card title="Agent pipeline"><Loading label="Loading trace..." /></Card>;
  const slowest = Math.max(0, ...stats.map((s) => s.durationMs ?? 0)) || 1;
  const loops = stats.find((s) => s.id === "novelty_validator")?.visits ?? 0;
  return (
    <Card title="Agent pipeline" actions={<Link to={`/runs/${run.id}/trace`}>Full trace</Link>}>
      <div className="pipeline dash-pipeline" aria-label="Agent pipeline">
        {stats.map((stat, i) => <PipelineStep key={stat.id} stat={stat} index={i} slowest={slowest} />)}
        <div className="pipe-loop-note">
          Synthesiser and Validator ran {loops} time{loops === 1 ? "" : "s"} in this run, looping until gaps passed validation or the revision limit escalated them.
        </div>
      </div>
    </Card>
  );
}

function outcomeParts(o: GapOutcomes): BarPart[] {
  return [
    { key: "first", label: "Accepted first pass", value: o.firstPass, color: "var(--viz-1)" },
    { key: "revised", label: "Accepted after revision", value: o.afterRevision, color: "var(--viz-3)" },
    { key: "withdrawn", label: "Withdrawn", value: o.withdrawn, color: "var(--viz-neutral)" },
    { key: "escalated", label: "Escalated", value: o.escalated, color: "var(--viz-2)" },
    { key: "unresolved", label: "Unresolved", value: o.unresolved, color: "var(--viz-track)" },
  ];
}

/** Where every proposed gap ended up. */
function OutcomesCard({ run }: { run: RunDetail }) {
  const outcomes = useMemo(() => gapOutcomes(run.gaps, run.validation_decisions), [run]);
  const parts = outcomeParts(outcomes);
  const shown = parts.filter((p) => p.value > 0);
  return (
    <ChartCard
      title={`Gap outcomes (${outcomes.proposed} proposed)`}
      table={{ headers: ["Outcome", "Gaps"], rows: parts.map((p) => [p.label, p.value]) }}
    >
      {outcomes.proposed ? (
        <>
          <SegmentedBar tall parts={parts} label={`Outcome of ${outcomes.proposed} proposed gaps`} />
          <Legend items={shown} />
        </>
      ) : <p className="muted">No gaps were proposed in this run.</p>}
    </ChartCard>
  );
}

/** Validator pressure by round: rejections should fall as revisions land. */
function RoundsCard({ run }: { run: RunDetail }) {
  const rounds = useMemo(() => roundSummaries(run.validation_decisions), [run]);
  return (
    <ChartCard
      title="Validation rounds"
      table={{ headers: ["Round", "Accepted", "Rejected"], rows: rounds.map((r) => [r.round, r.accepted, r.rejected]) }}
    >
      {rounds.length ? (
        <>
          <StackedRows
            unit="decisions"
            rows={rounds.map((r) => ({
              key: String(r.round),
              label: `Round ${r.round}`,
              parts: [
                { key: "accepted", label: "Accepted", value: r.accepted, color: "var(--viz-good)" },
                { key: "rejected", label: "Rejected", value: r.rejected, color: "var(--viz-bad)" },
              ],
            }))}
          />
          <Legend items={DECISION_LEGEND} />
        </>
      ) : <p className="muted">The validator did not run.</p>}
    </ChartCard>
  );
}

function ReasonsCard({ run }: { run: RunDetail }) {
  const reasons = useMemo(() => rejectionReasons(run.validation_decisions), [run]);
  return (
    <ChartCard
      title="Why gaps were rejected"
      actions={<Link className="small" to={`/runs/${run.id}/feedback-loop`}>Feedback loop</Link>}
      table={{ headers: ["Reason", "Issues"], rows: reasons.map((r) => [r.label, r.value]) }}
    >
      {reasons.length ? <RankedBars items={reasons} unit="blocking issues" /> : <p className="muted">No gap was rejected in this run.</p>}
    </ChartCard>
  );
}

/** Recent agent messages, newest first, reusing the trace page's timeline styling. */
function ActivityCard({ run, messages, error }: { run: RunDetail; messages: AgentMessage[] | null; error: string | null }) {
  const [filter, setFilter] = useState("all");
  const types = FEED_FILTERS.find((f) => f.id === filter)?.types ?? null;
  const matching = useMemo(
    () => (messages ?? []).filter((m) => !types || types.includes(m.message_type)).sort((a, b) => b.seq - a.seq),
    [messages, types],
  );
  return (
    <Card
      title="Agent activity"
      actions={
        <div className="seg-control" role="tablist" aria-label="Activity filter">
          {FEED_FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? "active" : ""} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      }
    >
      {error ? <ErrorBox error={error} /> : !messages ? <Loading label="Loading trace..." /> : matching.length ? (
        <>
          <ol className="timeline">
            {matching.slice(0, FEED_LIMIT).map((m) => (
              <li key={m.id} className={`tl-item type-${m.message_type}`}>
                <span className="tl-seq">{m.seq}</span>
                <div className="tl-body">
                  <div className="tl-head">
                    <span className="agent-chip">{agentLabel(m.sender)}</span>
                    <span className="arrow" aria-label="to">to</span>
                    <span className="agent-chip ghost">{agentLabel(m.recipient)}</span>
                    <span className={`type-tag type-${m.message_type}`}>{m.message_type}</span>
                  </div>
                  <p className="tl-summary">{m.summary}</p>
                </div>
              </li>
            ))}
          </ol>
          {matching.length > FEED_LIMIT && (
            <p className="small"><Link to={`/runs/${run.id}/trace`}>{matching.length - FEED_LIMIT} earlier message(s) in the full trace</Link></p>
          )}
        </>
      ) : <p className="muted">No messages of this kind in the run.</p>}
    </Card>
  );
}

/** How this run was executed, and the state of the service now. */
function SystemCard({ run, messages, health, config }: {
  run: RunDetail; messages: AgentMessage[] | null; health: Health | null; config: PublicConfig | null;
}) {
  const source = messages?.find((m) => m.llm)?.llm?.reasoning_source ?? run.gaps[0]?.reasoning_source;
  return (
    <div className="two-col">
      <Card title="Run execution">
        <dl className="kv">
          <dt>Started</dt><dd>{formatDateTime(run.created_at)}</dd>
          <dt>Finished</dt><dd>{formatDateTime(run.completed_at)}</dd>
          <dt>Duration</dt><dd>{formatMs(runDurationMs(run))}</dd>
          <dt>LLM</dt><dd className="small">{run.llm_provider}/{run.llm_model}</dd>
          <dt>Reasoning</dt><dd className="small">{reasoningLabel(source) || "-"}</dd>
          <dt>Trace</dt><dd>{run.trace_length} messages</dd>
        </dl>
      </Card>
      <Card title="Service status" actions={<Link to="/settings">Settings</Link>}>
        {health ? (
          <dl className="kv">
            <dt>API</dt><dd>{health.status}, version {health.version}</dd>
            <dt>Database</dt><dd>{health.database}</dd>
            <dt>Storage</dt><dd className="small">{health.storage}{health.storage_persistent ? "" : " (temporary)"}</dd>
            <dt>Deployment</dt><dd>{health.deployment}</dd>
            <dt>Live LLM</dt><dd>{health.live_llm_configured ? "configured" : "not configured"}</dd>
            <dt>Revision limit</dt><dd>{config?.max_revisions ?? "-"}</dd>
          </dl>
        ) : <Loading label="Checking service..." />}
      </Card>
    </div>
  );
}

/** How the agents reached this run's result. Run-level, so the regulator filter does not apply. */
export default function AgentsView({ run, messages, traceError, health, config }: {
  run: RunDetail; messages: AgentMessage[] | null; traceError: string | null; health: Health | null; config: PublicConfig | null;
}) {
  return (
    <>
      <PipelineCard run={run} messages={messages} error={traceError} />
      <OutcomesCard run={run} />
      <div className="two-col">
        <RoundsCard run={run} />
        <ReasonsCard run={run} />
      </div>
      <ActivityCard run={run} messages={messages} error={traceError} />
      <SystemCard run={run} messages={messages} health={health} config={config} />
    </>
  );
}
