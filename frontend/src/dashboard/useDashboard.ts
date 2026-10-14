import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAsync, useSelectedRun, type AsyncState } from "../hooks";
import type { AgentMessage, Health, PublicConfig, RunDetail, RunSummary } from "../types";
import { ALL_REGULATORS, buildRunView, defaultBaselineId, regulatorsOf, type RunView } from "./metrics";

/** Runs loaded for history, sparklines and pickers; the most the API serves. */
const HISTORY_LIMIT = 200;

/** How often an in-progress run is re-read. */
const RUNNING_POLL_MS = 5000;

/** `?vs=` value that turns comparison off. */
export const NO_BASELINE = "none";

export const DASHBOARD_VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "risk", label: "Risk & actions" },
  { id: "agents", label: "Agents" },
  { id: "history", label: "History" },
] as const;
export type DashboardViewId = (typeof DASHBOARD_VIEWS)[number]["id"];

function isView(value: string | null): value is DashboardViewId {
  return DASHBOARD_VIEWS.some((v) => v.id === value);
}

/** Everything the dashboard shows, plus the controls that change it. */
export interface DashboardState {
  view: DashboardViewId;
  regulator: string;
  regulators: string[];
  /** Selected run, narrowed by the regulator filter; null until a run loads. */
  current: RunView | null;
  /** Comparison run, narrowed the same way; null when off or still loading. */
  baseline: RunView | null;
  baselineId: string | null;
  /** True when the user asked for no comparison. */
  baselineOff: boolean;
  baselineError: string | null;
  run: RunDetail | null;
  runId: string | null;
  noRuns: boolean;
  runLoading: boolean;
  runError: string | null;
  runs: AsyncState<RunSummary[]>;
  health: AsyncState<Health>;
  config: AsyncState<PublicConfig>;
  /** Trace of the selected run; null until it matches that run. */
  messages: AgentMessage[] | null;
  traceError: string | null;
  /** Reference time for every "days left" figure. */
  now: Date;
  refresh: () => void;
  setView: (view: DashboardViewId) => void;
  setRegulator: (regulator: string) => void;
  selectRun: (id: string) => void;
  setBaseline: (id: string) => void;
  clearRun: () => void;
}

/**
 * Load and hold dashboard data. Selection lives in the URL (?run, ?vs, ?reg, ?view), so a
 * view can be linked and the sidebar keeps the same run on the run-scoped pages.
 */
export function useDashboard(): DashboardState {
  const selected = useSelectedRun();
  const [search, setSearch] = useSearchParams();
  const runs = useAsync(() => api.runs(HISTORY_LIMIT), "dash-runs");
  const health = useAsync(() => api.health(), "dash-health");
  const config = useAsync(() => api.config(), "dash-config");
  const [now, setNow] = useState(() => new Date());
  const { run, reload: reloadRun } = selected;

  const viewParam = search.get("view");
  const view: DashboardViewId = isView(viewParam) ? viewParam : "overview";
  const regulators = useMemo(() => (run ? regulatorsOf(run) : []), [run]);
  const regulatorParam = search.get("reg") ?? ALL_REGULATORS;
  // a regulator from a previous run's URL must not leave the new run looking empty
  const regulator = regulators.includes(regulatorParam) ? regulatorParam : ALL_REGULATORS;

  const vsParam = search.get("vs");
  const baselineOff = vsParam === NO_BASELINE;
  const autoBaseline = run && runs.data ? defaultBaselineId(runs.data, run) : null;
  const baselineId = baselineOff ? null : vsParam ?? autoBaseline;

  const baselineRun = useAsync<RunDetail | null>(
    () => (baselineId ? api.run(baselineId) : Promise.resolve(null)),
    `dash-baseline-${baselineId ?? "none"}`,
  );
  const trace = useAsync(
    () => (run ? api.trace(run.id) : Promise.resolve(null)),
    `dash-trace-${run?.id ?? "none"}`,
  );

  const current = useMemo(() => (run ? buildRunView(run, regulator) : null), [run, regulator]);
  const baseline = useMemo(() => {
    // useAsync keeps the previous value during a reload, so check it is the run asked for
    const loaded = baselineRun.data;
    return loaded && loaded.id === baselineId ? buildRunView(loaded, regulator) : null;
  }, [baselineRun.data, baselineId, regulator]);

  const reloadRuns = runs.reload;
  const reloadTrace = trace.reload;
  const reloadBaseline = baselineRun.reload;
  const reloadHealth = health.reload;
  const refresh = useCallback(() => {
    setNow(new Date());
    reloadRun();
    reloadRuns();
    reloadTrace();
    reloadBaseline();
    reloadHealth();
  }, [reloadRun, reloadRuns, reloadTrace, reloadBaseline, reloadHealth]);

  const isRunning = run?.status === "running";
  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(refresh, RUNNING_POLL_MS);
    return () => window.clearInterval(id);
  }, [isRunning, refresh]);

  const updateParams = useCallback(
    (changes: Record<string, string | null>) => {
      setSearch((previous) => {
        const next = new URLSearchParams(previous);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        return next;
      }, { replace: true });
    },
    [setSearch],
  );

  return {
    view,
    regulator,
    regulators,
    current,
    baseline,
    baselineId,
    baselineOff,
    baselineError: baselineRun.error,
    run,
    runId: selected.runId,
    noRuns: selected.noRuns,
    runLoading: selected.loading,
    runError: selected.error,
    runs,
    health,
    config,
    messages: run && trace.data?.run_id === run.id ? trace.data.messages : null,
    traceError: trace.error,
    now,
    refresh,
    setView: useCallback((next) => updateParams({ view: next === "overview" ? null : next }), [updateParams]),
    setRegulator: useCallback((next) => updateParams({ reg: next === ALL_REGULATORS ? null : next }), [updateParams]),
    // the old comparison belongs to the old run, so choosing a run resets it
    selectRun: useCallback((id) => updateParams({ run: id, vs: null }), [updateParams]),
    setBaseline: useCallback((id) => updateParams({ vs: id }), [updateParams]),
    clearRun: useCallback(() => updateParams({ run: null, vs: null }), [updateParams]),
  };
}
