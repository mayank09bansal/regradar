import { Link } from "react-router-dom";
import { api } from "../api";
import { useAsync } from "../hooks";
import { formatDateTime } from "../lib";
import { Card, EmptyState, ErrorBox, Loading, PageHeader, StatusPill } from "../components/ui";

/** All persisted runs with their headline numbers. */
export default function RunsPage() {
  const runs = useAsync(() => api.runs(100), "runs-all");

  async function remove(id: string) {
    if (!window.confirm(`Delete run ${id} and its trace?`)) return;
    await api.deleteRun(id);
    runs.reload();
  }

  return (
    <>
      <PageHeader title="Run History" subtitle="Every analysis is persisted in SQLite with its full execution trace." />
      <Card>
        {runs.loading ? <Loading /> : runs.error ? <ErrorBox error={runs.error} onRetry={runs.reload} /> :
          !runs.data?.length ? <EmptyState title="No runs yet"><p>Start one from the <Link to="/">Dashboard</Link>.</p></EmptyState> : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Run ID</th><th>Started</th><th>Mode</th><th>LLM</th><th>Status</th>
                    <th>Obligations</th><th>Accepted</th><th>Rounds</th><th>Escalated</th><th /></tr>
                </thead>
                <tbody>
                  {runs.data.map((r) => (
                    <tr key={r.id}>
                      <td><Link className="mono" to={`/runs/${r.id}`}>{r.id}</Link></td>
                      <td>{formatDateTime(r.created_at)}</td>
                      <td>{r.mode}</td>
                      <td className="small">{r.llm_provider}/{r.llm_model}</td>
                      <td><StatusPill status={r.status} />{r.error && <div className="small bad-text">{r.error}</div>}</td>
                      <td>{r.stats.obligations ?? "-"}</td>
                      <td>{r.stats.accepted_gaps ?? "-"}</td>
                      <td>{r.stats.validation_rounds ?? "-"}</td>
                      <td>{r.stats.escalated_gaps ?? "-"}</td>
                      <td><button className="link-btn danger" onClick={() => remove(r.id)}>Delete</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>
    </>
  );
}
