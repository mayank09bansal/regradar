import type { ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api";
import { useAsync, useSelectedRun } from "../hooks";
import { formatDateTime, shortId } from "../lib";
import type { RunDetail } from "../types";
import { EmptyState, ErrorBox, Loading, ModeBadge, PageHeader, StatusPill } from "./ui";

/** Tabs shown for a run; an empty path is the overview. */
const SUBPAGES = [
  { path: "", label: "Overview" },
  { path: "trace", label: "Trace" },
  { path: "feedback-loop", label: "Feedback loop" },
  { path: "coverage", label: "Coverage" },
  { path: "gaps", label: "Gaps" },
  { path: "remediation", label: "Remediation" },
  { path: "report", label: "Report" },
];

/** Switch run while staying on the same page, for /runs/:id and ?run= URLs alike. */
function RunPicker({ current }: { current: string }) {
  const runs = useAsync(() => api.runs(30), "runs-picker");
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();

  function choose(id: string) {
    if (params.runId) {
      navigate(location.pathname.replace(`/runs/${params.runId}`, `/runs/${id}`));
    } else {
      navigate(`${location.pathname}?run=${encodeURIComponent(id)}`);
    }
  }

  return (
    <label className="run-picker">
      <span>Run</span>
      <select value={current} onChange={(e) => choose(e.target.value)} disabled={!runs.data}>
        {!runs.data?.some((r) => r.id === current) && <option value={current}>{shortId(current)}</option>}
        {runs.data?.map((r) => (
          <option key={r.id} value={r.id}>
            {shortId(r.id)} - {r.mode} - {r.status}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Shared wrapper for pages that display one run: resolves the run and renders a header. */
export default function RunScope({ title, subtitle, children }: {
  title: string;
  subtitle?: ReactNode;
  children: (run: RunDetail) => ReactNode;
}) {
  const sel = useSelectedRun();
  if (sel.loading) return <><PageHeader title={title} /><Loading label="Loading run..." /></>;
  if (sel.error) return <><PageHeader title={title} /><ErrorBox error={sel.error} onRetry={sel.reload} /></>;
  if (!sel.run) {
    return (
      <>
        <PageHeader title={title} subtitle={subtitle} />
        <EmptyState title="No analysis runs yet">
          <p>Run the deterministic demo from the <Link to="/">Dashboard</Link> or start a <Link to="/analyze">new analysis</Link>.</p>
        </EmptyState>
      </>
    );
  }
  const run = sel.run;
  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={<RunPicker current={run.id} />}
      />
      <div className="run-strip">
        <ModeBadge mode={run.mode} />
        <StatusPill status={run.status} />
        <span className="mono">{run.id}</span>
        <span className="muted">{formatDateTime(run.created_at)}</span>
        <nav className="subnav" aria-label="Run pages">
          {SUBPAGES.map((p) => (
            <NavLink key={p.path} end to={`/runs/${run.id}${p.path ? `/${p.path}` : ""}`}
              className={({ isActive }) => (isActive ? "active" : "")}>
              {p.label}
            </NavLink>
          ))}
        </nav>
      </div>
      {run.error && <ErrorBox error={`Run failed: ${run.error}`} />}
      {children(run)}
    </>
  );
}
