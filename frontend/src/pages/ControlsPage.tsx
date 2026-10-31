import { useState } from "react";
import { api } from "../api";
import { Card, ErrorBox, Loading, PageHeader, Pill } from "../components/ui";
import { useAsync } from "../hooks";

export default function ControlsPage() {
  const lib = useAsync(() => api.controls(), "controls");
  const [domain, setDomain] = useState("");
  return (
    <>
      <PageHeader title="Control Library" subtitle="Acme Pay's internal controls and known-issues register - the knowledge base used by the Control Mapper and Novelty Validator." />
      {lib.loading ? <Loading /> : lib.error ? <ErrorBox error={lib.error} onRetry={lib.reload} /> : lib.data && (
        <>
          <Card
            title={`${lib.data.controls.length} controls`}
            actions={
              <select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Filter by domain">
                <option value="">All domains</option>
                {Array.from(new Set(lib.data.controls.map((c) => c.domain))).map((d) => <option key={d}>{d}</option>)}
              </select>
            }
          >
            <div className="table-wrap">
              <table>
                <thead><tr><th>ID</th><th>Control</th><th>Domain</th><th>Owner</th><th>Parameters</th><th>Criticality</th></tr></thead>
                <tbody>
                  {lib.data.controls.filter((c) => !domain || c.domain === domain).map((c) => (
                    <tr key={c.id}>
                      <td className="mono small nowrap">{c.id}</td>
                      <td><strong>{c.title}</strong><div className="small muted">{c.description}</div></td>
                      <td>{c.domain}</td>
                      <td>{c.owner}</td>
                      <td className="small">{Object.entries(c.parameters).map(([k, v]) => `${k}: ${v}`).join(", ") || "-"}</td>
                      <td><Pill value={c.criticality} tone={c.criticality === "high" ? "bad" : c.criticality === "medium" ? "warn" : "muted"} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Known-issues register">
            <p className="small muted">The Novelty Validator rejects gap proposals that duplicate an issue already tracked here (code <code>already_tracked</code>).</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>ID</th><th>Issue</th><th>Citations</th><th>Status</th><th>Owner</th><th>Target</th></tr></thead>
                <tbody>
                  {lib.data.known_issues.map((k) => (
                    <tr key={k.id}>
                      <td className="mono small">{k.id}</td><td>{k.title}</td>
                      <td className="small">{k.related_citations.join(", ") || "-"}</td>
                      <td>{k.status}</td><td>{k.owner}</td><td>{k.target_date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
