import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { Card, ErrorBox, JsonView, Loading, PageHeader, Pill } from "../components/ui";
import WorkflowCanvas, { type Emphasis } from "../components/WorkflowCanvas";
import { useAsync } from "../hooks";
import type { N8nWorkflowExport, RunDetail } from "../types";
import {
  EDGES, KIND_LABEL, LANES, NODES, WALKTHROUGHS,
  downstreamOf, modelN8nConnections, nodeById, upstreamOf,
  type NodeKind, type WorkflowNode,
} from "../workflow/model";

const STEP_MS = 1800;
const PANEL_OVERLAY_QUERY = "(min-width: 1101px)";
const PANEL_INSET = 362; // .wf-panel overlay width + margins

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

function exportConnections(wf: N8nWorkflowExport): string[] {
  return Object.entries(wf.connections).flatMap(([from, c]) =>
    (c.main ?? []).flatMap((outputs) => outputs.map((t) => `${from}>${t.node}`)));
}

/** Compare the diagram's n8n lane with the served export; returns human-readable differences. */
function syncDiff(wf: N8nWorkflowExport): string[] {
  const diffs: string[] = [];
  const modelNames = new Set(NODES.flatMap((n) => (n.n8nName ? [n.n8nName] : [])));
  const exportNames = new Set(wf.nodes.map((n) => n.name));
  for (const n of exportNames) if (!modelNames.has(n)) diffs.push(`Node "${n}" is in the export but not on the canvas`);
  for (const n of modelNames) if (!exportNames.has(n)) diffs.push(`Node "${n}" is on the canvas but not in the export`);
  const modelConn = new Set(modelN8nConnections());
  const exportConn = new Set(exportConnections(wf));
  for (const c of exportConn) if (!modelConn.has(c)) diffs.push(`Connection ${c.replace(">", " → ")} is missing from the canvas`);
  for (const c of modelConn) if (!exportConn.has(c)) diffs.push(`Connection ${c.replace(">", " → ")} is not in the export`);
  return diffs;
}

function downloadJson(wf: N8nWorkflowExport) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(wf, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "regradar_workflow.json";
  a.click();
  URL.revokeObjectURL(url);
}

function NodeChips({ ids, onSelect }: { ids: { id: string; label?: string }[]; onSelect: (id: string) => void }) {
  if (!ids.length) return <span className="muted">none</span>;
  return (
    <span className="wf-chips">
      {ids.map(({ id, label }) => (
        <button key={id + (label ?? "")} type="button" className="wf-chip" onClick={() => onSelect(id)}>
          {nodeById(id)?.label ?? id}{label && <span className="muted"> · {label}</span>}
        </button>
      ))}
    </span>
  );
}

function DetailsPanel({ node, exportNode, onSelect, onClose }: {
  node: WorkflowNode;
  exportNode?: N8nWorkflowExport["nodes"][number];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const up = upstreamOf(node.id).map((e) => ({ id: e.from, label: e.label }));
  const down = downstreamOf(node.id).map((e) => ({ id: e.to, label: e.label }));
  return (
    <div className="wf-details">
      <div className="wf-details-head">
        <span className={`wf-kind-dot kind-${node.kind}`} aria-hidden />
        <div className="grow">
          <h3>{node.label}</h3>
          <div className="small muted">{node.lane === "n8n" ? "n8n workflow node" : "RegRadar backend"} · {KIND_LABEL[node.kind]}</div>
        </div>
        <button type="button" className="wf-close" onClick={onClose} aria-label="Close details">×</button>
      </div>
      <p className="wf-purpose">{node.purpose}</p>
      <h4>Responsibilities</h4>
      <ul className="small tight">{node.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
      <dl className="kv small wf-kv">
        <dt>Inputs</dt><dd>{node.inputs.join("; ")}</dd>
        <dt>Outputs</dt><dd>{node.outputs.join("; ")}</dd>
        <dt>Upstream</dt><dd><NodeChips ids={up} onSelect={onSelect} /></dd>
        <dt>Downstream</dt><dd><NodeChips ids={down} onSelect={onSelect} /></dd>
        <dt>Source</dt><dd>{node.files.map((f) => <code key={f} className="wf-file">{f}</code>)}</dd>
        {node.integration && <><dt>Integration</dt><dd>{node.integration}</dd></>}
        {node.usesLlm !== undefined && <><dt>LLM (live)</dt><dd>{node.usesLlm ? "yes" : "no - deterministic"}</dd></>}
        {node.n8nName && <><dt>n8n name</dt><dd>{node.n8nName}</dd></>}
        {exportNode && <><dt>n8n type</dt><dd className="mono">{exportNode.type} v{exportNode.typeVersion}</dd></>}
      </dl>
      {exportNode && <JsonView value={exportNode.parameters} label="Parameters from the export" />}
    </div>
  );
}

const LEGEND: { kind: NodeKind; hint: string }[] = [
  { kind: "trigger", hint: "starts a flow" },
  { kind: "integration", hint: "HTTP / API boundary" },
  { kind: "agent", hint: "LangGraph agent" },
  { kind: "decision", hint: "conditional branch" },
  { kind: "control", hint: "hand-off to a person" },
  { kind: "output", hint: "report or alert" },
];

function Legend() {
  return (
    <div className="wf-legend" aria-label="Legend">
      {LEGEND.map(({ kind, hint }) => (
        <span key={kind} className="wf-legend-item">
          <span className={`wf-kind-dot kind-${kind}`} aria-hidden />
          <strong>{KIND_LABEL[kind]}</strong> <span className="muted">{hint}</span>
        </span>
      ))}
      <span className="wf-legend-item"><span className="wf-line flow" aria-hidden /> data flow</span>
      <span className="wf-legend-item"><span className="wf-line conditional" aria-hidden /> conditional</span>
      <span className="wf-legend-item"><span className="wf-line loop" aria-hidden /> feedback loop</span>
      <span className="wf-legend-item"><span className="wf-line remote" aria-hidden /> HTTP between systems</span>
    </div>
  );
}

interface WalkState { pathId: string; index: number; playing: boolean }

export default function N8nWorkflowPage() {
  const workflow = useAsync(() => api.n8nWorkflow(), "n8n-workflow");
  const config = useAsync(() => api.config(), "config-n8n");
  const [selected, setSelected] = useState<string | null>(null);
  const [pathId, setPathId] = useState(WALKTHROUGHS[0].id);
  const [walk, setWalk] = useState<WalkState | null>(null);
  const [showRoute, setShowRoute] = useState(false);
  const overlayPanel = useMediaQuery(PANEL_OVERLAY_QUERY);
  const panelRef = useRef<HTMLElement>(null);
  const latest = useAsync<RunDetail | null>(async () => {
    if (!showRoute) return null;
    try {
      return await api.latestRun();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  }, showRoute ? "n8n-latest-route" : "n8n-route-off");

  const tour = WALKTHROUGHS.find((w) => w.id === (walk?.pathId ?? pathId)) ?? WALKTHROUGHS[0];
  const step = walk ? tour.steps[walk.index] : null;

  useEffect(() => {
    if (!walk?.playing) return;
    const id = window.setTimeout(() => {
      setWalk((w) => {
        if (!w) return w;
        const last = w.index >= tour.steps.length - 1;
        return last ? { ...w, playing: false } : { ...w, index: w.index + 1 };
      });
    }, STEP_MS);
    return () => window.clearTimeout(id);
  }, [walk, tour.steps.length]);

  const route = useMemo(() => (showRoute && latest.data ? latest.data.route_history : []), [showRoute, latest.data]);
  const routeBadges = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const id of route) counts[id] = (counts[id] ?? 0) + 1;
    return Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, `${n}×`]));
  }, [route]);

  const emphasis: Emphasis | null = useMemo(() => {
    if (walk) {
      const done = tour.steps.slice(0, walk.index + 1);
      return {
        nodes: new Set(done.map((s) => s.node)),
        edges: new Set(done.flatMap((s) => (s.edge ? [s.edge] : []))),
        current: done[done.length - 1]?.node,
      };
    }
    if (selected) {
      const incident = EDGES.filter((e) => e.from === selected || e.to === selected);
      return {
        nodes: new Set([selected, ...incident.flatMap((e) => [e.from, e.to])]),
        edges: new Set(incident.map((e) => e.id)),
      };
    }
    if (route.length) {
      const edges = new Set<string>(["api-scout"]);
      route.slice(1).forEach((to, i) => {
        const e = EDGES.find((x) => x.from === route[i] && x.to === to);
        if (e) edges.add(e.id);
      });
      return { nodes: new Set(["run_api", ...route]), edges };
    }
    return null;
  }, [walk, tour, selected, route]);

  const detailId = step?.node ?? selected;
  const detailNode = detailId ? nodeById(detailId) : undefined;
  const exportNode = detailNode?.n8nName ? workflow.data?.nodes.find((n) => n.name === detailNode.n8nName) : undefined;
  const diffs = workflow.data ? syncDiff(workflow.data) : [];

  // Escape closes the details panel wherever focus is.
  useEffect(() => {
    if (!detailId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setWalk(null); setSelected(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detailId]);

  const select = (id: string | null) => {
    setWalk(null);
    setSelected(id);
    // Below the overlay breakpoint the panel sits under the canvas: bring it into view.
    if (id && !overlayPanel) window.requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };
  const startWalk = () => { setSelected(null); setWalk({ pathId, index: 0, playing: true }); };
  const move = (delta: number) =>
    setWalk((w) => w && { ...w, playing: false, index: Math.min(tour.steps.length - 1, Math.max(0, w.index + delta)) });

  return (
    <>
      <PageHeader
        title="n8n Workflow"
        subtitle="How the n8n automation in n8n/regradar_workflow.json drives the RegRadar multi-agent pipeline, and how finished runs flow back to n8n for alerting."
        actions={
          <button type="button" className="btn btn-secondary" disabled={!workflow.data}
            onClick={() => workflow.data && downloadJson(workflow.data)}>
            Download workflow JSON
          </button>
        }
      />
      <div className="notice wf-notice">
        <strong>Workflow map, not a live n8n monitor.</strong> The canvas shows the structure of the n8n export and the
        LangGraph agents it triggers. RegRadar has no n8n execution API, so n8n run history and status stay in the n8n
        editor. The walkthrough is a visual replay and executes nothing.
      </div>

      <Card className="wf-card">
        <div className="wf-toolbar">
          <label className="run-picker">
            <span>Walkthrough</span>
            <select value={walk?.pathId ?? pathId} onChange={(e) => { setPathId(e.target.value); setWalk(null); }}
              aria-label="Walkthrough path">
              {WALKTHROUGHS.map((w) => <option key={w.id} value={w.id}>{w.title}</option>)}
            </select>
          </label>
          {!walk ? (
            <button type="button" className="btn btn-primary" onClick={startWalk}>▶ Play walkthrough</button>
          ) : (
            <div className="row gap-s wrap">
              <button type="button" className="btn btn-secondary" onClick={() => move(-1)} disabled={walk.index === 0} aria-label="Previous step">‹ Prev</button>
              <button type="button" className="btn btn-secondary"
                onClick={() => setWalk((w) => w && (w.index >= tour.steps.length - 1 ? { ...w, index: 0, playing: true } : { ...w, playing: !w.playing }))}>
                {walk.playing ? "❚❚ Pause" : walk.index >= tour.steps.length - 1 ? "↺ Replay" : "▶ Resume"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => move(1)} disabled={walk.index >= tour.steps.length - 1} aria-label="Next step">Next ›</button>
              <button type="button" className="btn btn-secondary" onClick={() => setWalk(null)}>Stop</button>
            </div>
          )}
          <label className="inline-check wf-route-toggle">
            <input type="checkbox" checked={showRoute} onChange={(e) => { setShowRoute(e.target.checked); setWalk(null); setSelected(null); }} />
            Overlay latest RegRadar run route
          </label>
        </div>

        {step && walk && (
          <div className="wf-caption" aria-live="polite">
            <span className="mode-badge mode-demo">WALKTHROUGH · {walk.index + 1}/{tour.steps.length}</span>
            <span>{step.caption}</span>
          </div>
        )}
        {showRoute && !walk && (
          <div className="wf-caption">
            {latest.loading ? <Loading label="Loading latest run..." /> : latest.error ? (
              <span className="bad-text small">Could not load the latest run: {latest.error}</span>
            ) : latest.data ? (
              <span className="small">
                Route of RegRadar run <Link to={`/runs/${encodeURIComponent(latest.data.id)}`} className="mono">{latest.data.id}</Link>{" "}
                ({latest.data.mode}, {latest.data.status}), from <code>route_history</code> in RegRadar's run store. Badges count
                visits per node. This is a RegRadar run, not an n8n execution.
              </span>
            ) : (
              <span className="small">No runs yet. <Link to="/analyze">Start an analysis</Link> to overlay its route.</span>
            )}
          </div>
        )}

        <div className="wf-layout">
          <WorkflowCanvas
            nodes={NODES} edges={EDGES} lanes={LANES}
            selected={detailId ?? null} onSelect={select} emphasis={emphasis}
            badges={route.length && !walk ? routeBadges : {}}
            ariaLabel="RegRadar n8n workflow canvas"
            rightInset={detailNode && overlayPanel ? PANEL_INSET : 0}
          />
          {detailNode ? (
            <aside ref={panelRef} className="wf-panel" aria-label={`${detailNode.label} details`}>
              <DetailsPanel node={detailNode} exportNode={exportNode} onSelect={select}
                onClose={() => select(null)} />
            </aside>
          ) : null}
        </div>
        <Legend />
      </Card>

      <div className="two-col">
        <Card title="Workflow export" actions={workflow.data && (diffs.length
          ? <Pill value="canvas out of sync" tone="warn" />
          : <Pill value="canvas matches export" tone="good" />)}>
          {workflow.loading ? <Loading /> : workflow.error ? <ErrorBox error={workflow.error} onRetry={workflow.reload} /> : workflow.data && (
            <>
              <dl className="kv small">
                <dt>Name</dt><dd>{workflow.data.name}</dd>
                <dt>Nodes</dt><dd>{workflow.data.nodes.length}</dd>
                <dt>Connections</dt><dd>{exportConnections(workflow.data).length}</dd>
                <dt>Served from</dt><dd><code>GET /api/integrations/n8n/workflow</code></dd>
              </dl>
              {diffs.length > 0 && <ul className="small tight warn-text">{diffs.map((d) => <li key={d}>{d}</li>)}</ul>}
              <p className="small muted">
                The export holds no credentials: the API and Slack URLs are read from n8n's environment
                (<code>$env.REGRADAR_API_URL</code>, <code>$env.SLACK_WEBHOOK_URL</code>) when it runs.
              </p>
              <JsonView value={workflow.data} label="Workflow JSON" />
            </>
          )}
        </Card>
        <Card title="Integration status">
          {config.loading ? <Loading /> : config.error ? <ErrorBox error={config.error} onRetry={config.reload} /> : config.data && (
            <>
              <dl className="kv small">
                <dt>Backend → n8n webhook</dt>
                <dd><Pill value={config.data.n8n_configured ? "N8N_WEBHOOK_URL set" : "not configured"} tone={config.data.n8n_configured ? "good" : "muted"} /></dd>
                <dt>Backend → Slack</dt>
                <dd><Pill value={config.data.slack_configured ? "SLACK_WEBHOOK_URL set" : "not configured"} tone={config.data.slack_configured ? "good" : "muted"} /></dd>
              </dl>
              <p className="small muted">
                This shows only whether the backend has the URLs, never their values. Whether n8n is running, and its
                own <code>REGRADAR_API_URL</code> and <code>SLACK_WEBHOOK_URL</code>, can only be checked in n8n.
                Use <Link to="/settings">Settings &amp; Health</Link> to send a test notification.
              </p>
            </>
          )}
        </Card>
      </div>

      <Card title="Connect a running n8n">
        <ol className="small wf-steps">
          <li>Start n8n with the stack: <code>docker compose --profile integrations up --build</code> (n8n on <code>:5678</code>).</li>
          <li>In n8n, import the workflow file (use <em>Download workflow JSON</em> above, or <code>n8n/regradar_workflow.json</code>).</li>
          <li>Set <code>REGRADAR_API_URL</code> (defaults to <code>http://backend:8000</code>) and <code>SLACK_WEBHOOK_URL</code> in n8n's environment.</li>
          <li>Activate the workflow so its production webhook is live. Then set <code>N8N_WEBHOOK_URL</code> in RegRadar's <code>.env</code> to that URL (for example <code>http://localhost:5678/webhook/regradar</code>, see <code>.env.example</code>).</li>
          <li>Tick <em>Send Slack / n8n notification</em> on <Link to="/analyze">New Analysis</Link> to push <code>run.completed</code> events to n8n.</li>
        </ol>
      </Card>
    </>
  );
}
