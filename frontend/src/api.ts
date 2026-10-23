import type {
  AgentInfo, AgentMessage, AnalysisRequestBody, ControlLibrary, DemoDataset, GraphSpec, Health,
  N8nWorkflowExport, PublicConfig, RunDetail, RunSummary,
} from "./types";

// Dev (npm run dev): the API runs separately on :8000.
// Production build (Vercel or single-server mode): the API is on the same origin, so use relative URLs.
// VITE_API_BASE_URL overrides both (e.g. a backend hosted elsewhere).
export const API_BASE_URL: string = (
  import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? "http://127.0.0.1:8000" : "")
).replace(/\/$/, "");

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function formatDetail(detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    // FastAPI validation errors: [{loc, msg}]
    return detail
      .map((d: { loc?: unknown[]; msg?: string }) => `${(d.loc ?? []).slice(1).join(".") || "request"}: ${d.msg ?? ""}`)
      .join("; ");
  }
  return JSON.stringify(detail);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(
      0,
      `Cannot reach the RegRadar API at ${API_BASE_URL || window.location.origin}. Is the backend running ` +
        `(locally: python -m uvicorn backend.main:app --port 8000) and is this origin listed in CORS_ORIGINS?`,
    );
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) message = formatDetail(body.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  return (type.includes("application/json") ? res.json() : res.text()) as Promise<T>;
}

export const api = {
  health: () => request<Health>("/api/health"),
  config: () => request<PublicConfig>("/api/config"),
  agents: () => request<AgentInfo[]>("/api/agents"),
  graph: () => request<GraphSpec>("/api/graph"),
  demoDataset: () => request<DemoDataset>("/api/sources/demo-dataset"),
  controls: () => request<ControlLibrary>("/api/controls"),
  runs: (limit = 50) => request<RunSummary[]>(`/api/runs?limit=${limit}`),
  latestRun: () => request<RunDetail>("/api/runs/latest"),
  run: (id: string) => request<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  trace: (id: string) =>
    request<{ run_id: string; count: number; messages: AgentMessage[] }>(`/api/runs/${encodeURIComponent(id)}/trace`),
  reportMarkdownUrl: (id: string) => `${API_BASE_URL}/api/runs/${encodeURIComponent(id)}/report?format=md`,
  runDemo: (maxRevisions?: number) =>
    request<RunDetail>(`/api/demo/run${maxRevisions === undefined ? "" : `?max_revisions=${maxRevisions}`}`, { method: "POST" }),
  createRun: (body: AnalysisRequestBody) =>
    request<RunDetail>("/api/runs", { method: "POST", body: JSON.stringify(body) }),
  deleteRun: (id: string) => request<void>(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testIntegrations: () => request<{ results: Record<string, string> }>("/api/integrations/test", { method: "POST" }),
  n8nWorkflow: () => request<N8nWorkflowExport>("/api/integrations/n8n/workflow"),
};
