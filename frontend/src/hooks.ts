import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "./api";
import type { RunDetail } from "./types";

/** State exposed by useAsync. `data` keeps its last value during a reload. */
export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Run an async loader when `key` changes; exposes data/error/loading and a reload(). */
export function useAsync<T>(loader: () => Promise<T>, key: string): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((value) => { if (!cancelled) setData(value); })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` encodes the loader's inputs
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** The run a page should display, with its load state and controls. */
export interface SelectedRun {
  run: RunDetail | null;
  runId: string | null;
  error: string | null;
  loading: boolean;
  noRuns: boolean;
  selectRun: (id: string) => void;
  reload: () => void;
}

/**
 * Resolve which run a page shows: /runs/:runId, then ?run=, then the latest run.
 */
export function useSelectedRun(): SelectedRun {
  const params = useParams();
  const [search, setSearch] = useSearchParams();
  const requested = params.runId ?? search.get("run");
  const state = useAsync<RunDetail | null>(
    async () => {
      try {
        return requested ? await api.run(requested) : await api.latestRun();
      } catch (err) {
        if (!requested && err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    requested ?? "latest",
  );
  const selectRun = useCallback(
    (id: string) => {
      const next = new URLSearchParams(search);
      next.set("run", id);
      setSearch(next);
    },
    [search, setSearch],
  );
  return {
    run: state.data,
    runId: state.data?.id ?? requested,
    error: state.error,
    loading: state.loading,
    noRuns: !state.loading && !state.error && state.data === null,
    selectRun,
    reload: state.reload,
  };
}
