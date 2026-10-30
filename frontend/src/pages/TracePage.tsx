import { useMemo, useState } from "react";
import { api } from "../api";
import RunScope from "../components/RunScope";
import { Card, ErrorBox, JsonView, Loading } from "../components/ui";
import { useAsync } from "../hooks";
import { AGENT_ORDER, agentLabel, formatDateTime, reasoningLabel } from "../lib";
import type { AgentMessage, RunDetail } from "../types";

/** Trace filter options; matches MessageType in types.ts. */
const TYPES = ["task", "result", "proposal", "feedback", "revision", "decision", "escalation", "report", "error", "info"];

/** Loads the trace on demand and filters it client-side, as it can be large. */
function TraceView({ run }: { run: RunDetail }) {
  const trace = useAsync(() => api.trace(run.id), `trace-${run.id}`);
  const [agent, setAgent] = useState("");
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");

  const messages = useMemo(() => {
    const all: AgentMessage[] = trace.data?.messages ?? [];
    return all.filter((m) =>
      (!agent || m.sender === agent || m.recipient === agent) &&
      (!type || m.message_type === type) &&
      (!query || m.summary.toLowerCase().includes(query.toLowerCase())));
  }, [trace.data, agent, type, query]);

  if (trace.loading) return <Loading label="Loading trace..." />;
  if (trace.error) return <ErrorBox error={trace.error} onRetry={trace.reload} />;

  return (
    <Card
      title={`${messages.length} of ${trace.data?.count ?? 0} messages`}
      actions={
        <div className="filters">
          <select value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Filter by agent">
            <option value="">All agents</option>
            {AGENT_ORDER.map((a) => <option key={a} value={a}>{agentLabel(a)}</option>)}
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Filter by message type">
            <option value="">All types</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input type="search" placeholder="Search summaries" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      }
    >
      <ol className="timeline">
        {messages.map((m) => (
          <li key={m.id} className={`tl-item type-${m.message_type}`}>
            <div className="tl-seq">{m.seq}</div>
            <div className="tl-body">
              <div className="tl-head">
                <span className="agent-chip">{agentLabel(m.sender)}</span>
                <span className="arrow" aria-hidden>{"->"}</span>
                <span className="agent-chip ghost">{agentLabel(m.recipient)}</span>
                <span className={`type-tag type-${m.message_type}`}>{m.message_type}</span>
                {m.revision_round > 0 && <span className="pill tone-warn">revision {m.revision_round}</span>}
                {m.llm && (
                  <span className={`pill ${m.llm.fallback ? "tone-bad" : m.llm.reasoning_source === "deterministic-demo" ? "tone-demo" : "tone-info"}`}>
                    {reasoningLabel(m.llm.reasoning_source)}
                  </span>
                )}
                <span className="muted small push">{formatDateTime(m.timestamp)}{m.duration_ms !== null ? ` - ${m.duration_ms} ms` : ""}</span>
              </div>
              <p className="tl-summary">{m.summary}</p>
              {m.llm?.error && <p className="small bad-text">LLM error: {m.llm.error}</p>}
              <JsonView value={m.payload} />
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** The persisted message history of a run. */
export default function TracePage() {
  return (
    <RunScope
      title="Agent Execution Trace"
      subtitle="Every message passed between agents during the run, as persisted by the backend (not a static illustration)."
    >
      {(run) => <TraceView run={run} />}
    </RunScope>
  );
}
