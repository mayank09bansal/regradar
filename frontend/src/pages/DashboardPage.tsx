import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { Card, EmptyState, ErrorBox, Loading, ModeBadge, PageHeader, StatusPill } from "../components/ui";
import AgentsView from "../dashboard/AgentsView";
import { TipLayer } from "../dashboard/charts";
import "../dashboard/dashboard.css";
import HistoryView from "../dashboard/HistoryView";
import { ALL_REGULATORS, PIPELINE_AGENTS } from "../dashboard/metrics";
import OverviewView from "../dashboard/OverviewView";
import RiskView from "../dashboard/RiskView";
import { DASHBOARD_VIEWS, NO_BASELINE, useDashboard, type DashboardState } from "../dashboard/useDashboard";
import { agentLabel, formatDateTime, shortId } from "../lib";

/** Scope controls: one row above everything they narrow. */
function FilterBar({ dash }: { dash: DashboardState }) {
  const { run, runs, runId, baselineId, baselineOff, regulator, regulators } = dash;
  const options = runs.data ?? [];
  const scoped = dash.view === "overview" || dash.view === "risk";
  const comparable = options.filter((r) => r.id !== runId && r.status === "completed");
  return (
    <div className="dash-filters">
      <label className="run-picker">
        <span>Run</span>
        <select value={runId ?? ""} onChange={(e) => dash.selectRun(e.target.value)} disabled={!options.length}>
          {!options.some((r) => r.id === runId) && runId && <option value={runId}>{shortId(runId)}</option>}
          {options.map((r) => <option key={r.id} value={r.id}>{shortId(r.id)} - {r.mode} - {r.status}</option>)}
        </select>
      </label>
      <label className="run-picker">
        <span>Compare with</span>
        <select value={baselineOff ? NO_BASELINE : baselineId ?? NO_BASELINE} onChange={(e) => dash.setBaseline(e.target.value)} disabled={!options.length}>
          <option value={NO_BASELINE}>No comparison</option>
          {baselineId && !comparable.some((r) => r.id === baselineId) && <option value={baselineId}>{shortId(baselineId)}</option>}
          {comparable.map((r) => <option key={r.id} value={r.id}>{shortId(r.id)} - {r.mode}</option>)}
        </select>
      </label>
      {scoped && regulators.length > 1 && (
        <div className="seg-control" role="tablist" aria-label="Regulator">
          {[ALL_REGULATORS, ...regulators].map((r) => (
            <button key={r} type="button" role="tab" aria-selected={regulator === r} className={`dash-seg-plain ${regulator === r ? "active" : ""}`} onClick={() => dash.setRegulator(r)}>
              {r === ALL_REGULATORS ? "All regulators" : r}
            </button>
          ))}
        </div>
      )}
      {run && (
        <div className="row gap-s push">
          <ModeBadge mode={run.mode} />
          <StatusPill status={run.status} />
          <span className="small muted">{formatDateTime(run.created_at)}</span>
        </div>
      )}
    </div>
  );
}

function ViewTabs({ dash }: { dash: DashboardState }) {
  return (
    <div className="dash-tabs" role="tablist" aria-label="Dashboard views">
      {DASHBOARD_VIEWS.map((v) => (
        <button key={v.id} type="button" role="tab" aria-selected={dash.view === v.id} className={dash.view === v.id ? "active" : ""} onClick={() => dash.setView(v.id)}>
          {v.label}
        </button>
      ))}
    </div>
  );
}

/** First-run state: what will happen, using the same pipeline strip the Agents view measures. */
function FirstRun() {
  return (
    <>
      <div className="pipeline" aria-label="Agent pipeline">
        {PIPELINE_AGENTS.map((agent, i) => (
          <div key={agent.id} className={`pipe-step ${agent.loop ? "loop" : ""}`}>
            <span className="pipe-num">{i + 1}</span>
            <span className="pipe-name">{agentLabel(agent.id)}</span>
            <span className="pipe-verb">{agent.verb}</span>
          </div>
        ))}
        <div className="pipe-loop-note">Synthesiser and Validator loop until gaps pass validation or the revision limit escalates them.</div>
      </div>
      <EmptyState title="No runs yet">
        <p>Click <strong>Run deterministic demo</strong> to execute the full graph on the synthetic dataset. No API key is required.</p>
      </EmptyState>
    </>
  );
}

/** The selected dashboard view; earlier data stays up, dimmed, during a refresh. */
function ActiveView({ dash }: { dash: DashboardState }) {
  const { current, run, view } = dash;
  if (!current || !run) return null;
  const refreshing = dash.runLoading || dash.runs.loading;
  return (
    <div className={`dash-body ${refreshing ? "refreshing" : ""}`} role="tabpanel" aria-busy={refreshing}>
      {view === "overview" && (
        <OverviewView
          view={current}
          baseline={dash.baseline}
          baselineOff={dash.baselineOff}
          baselineLoading={dash.baselineId !== null && dash.baseline === null && !dash.baselineError}
          baselineError={dash.baselineError}
          runs={dash.runs.data ?? []}
          now={dash.now}
        />
      )}
      {/* keyed so queue filters don't outlive the run and regulator they were set for */}
      {view === "risk" && <RiskView key={`${run.id}-${dash.regulator}`} view={current} now={dash.now} />}
      {view === "agents" && (
        <AgentsView run={run} messages={dash.messages} traceError={dash.traceError} health={dash.health.data} config={dash.config.data} />
      )}
      {view === "history" && (
        <HistoryView
          runs={dash.runs.data ?? []}
          currentId={run.id}
          baselineId={dash.baselineId}
          onPick={dash.selectRun}
          onCompare={dash.setBaseline}
        />
      )}
    </div>
  );
}

/** Landing page: run the demo, then read posture, risk, agent behaviour and history for any run. */
export default function DashboardPage() {
  const dash = useDashboard();
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const navigate = useNavigate();
  const health = dash.health.data;

  async function runDemo() {
    setRunning(true);
    setRunError(null);
    try {
      const run = await api.runDemo();
      navigate(`/runs/${run.id}/feedback-loop`);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <TipLayer>
      <PageHeader
        title="Dashboard"
        subtitle="Six LangGraph agents turn regulatory change into validated, prioritised compliance gaps."
        actions={
          <>
            <button className="btn btn-secondary" onClick={dash.refresh} disabled={dash.runLoading}>Refresh</button>
            <button className="btn btn-primary" onClick={runDemo} disabled={running}>
              {running ? "Running demo graph..." : "Run deterministic demo"}
            </button>
          </>
        }
      />
      {runError && <ErrorBox error={runError} />}
      {health && !health.storage_persistent && (
        <div className="notice warn">
          <strong>Temporary run storage.</strong> Runs are kept in {health.storage} and may disappear when the
          {health.deployment === "vercel" ? " serverless instance restarts" : " server stops"}. Connect a PostgreSQL
          database (DATABASE_URL) to keep run history and traces.
        </div>
      )}

      {dash.runError ? (
        <>
          <ErrorBox error={dash.runError} onRetry={dash.refresh} />
          {dash.runId && <p><button type="button" className="link-btn" onClick={dash.clearRun}>Show the latest run instead</button></p>}
        </>
      ) : dash.noRuns ? <FirstRun /> : !dash.run ? <Loading /> : (
        <>
          <FilterBar dash={dash} />
          <ViewTabs dash={dash} />
          {dash.runs.error && (
            <Card><p className="bad-text small">Run history could not be loaded, so trends and comparison are unavailable: {dash.runs.error}</p></Card>
          )}
          <ActiveView dash={dash} />
          <p className="small muted dash-foot">
            Figures are recomputed from this run's stored results. <Link to={`/runs/${dash.run.id}`}>Open run overview</Link>
          </p>
        </>
      )}
    </TipLayer>
  );
}
