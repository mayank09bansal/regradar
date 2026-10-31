import { api } from "../api";
import { Card, ErrorBox, Loading, PageHeader } from "../components/ui";
import { useAsync } from "../hooks";

const MODAL = /\b(shall not|must not|shall|must|should|may|required to)\b/gi;

function highlight(text: string) {
  const parts = text.split(MODAL);
  // split() with a capture group puts the matched modal verbs at odd indices
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>));
}

export default function RegulationsPage() {
  const ds = useAsync(() => api.demoDataset(), "dataset");
  return (
    <>
      <PageHeader title="Regulations" subtitle="Documents available to the Regulatory Scout in demo mode. Live mode adds pasted circulars and RBI/SEBI RSS items." />
      {ds.loading ? <Loading /> : ds.error ? <ErrorBox error={ds.error} onRetry={ds.reload} /> : ds.data && (
        <>
          <div className="notice warn"><strong>Synthetic dataset.</strong> {ds.data.disclaimer}</div>
          <Card title="Organisation profile (fictional)">
            <p><strong>{ds.data.organisation_profile.name}</strong> - {ds.data.organisation_profile.type}, {ds.data.organisation_profile.jurisdiction}.</p>
            <p className="small muted">Themes of interest: {ds.data.organisation_profile.themes_of_interest.join(", ")}</p>
          </Card>
          {ds.data.documents.map((d) => (
            <Card key={d.id} title={<><span className="mono small">{d.id}</span> {d.title}</>}
              actions={<span className="pill tone-warn">synthetic - {d.regulator}</span>}>
              <p className="small muted">Issued {d.issued} - effective {d.effective} - themes: {d.themes.join(", ")}</p>
              <ol className="clauses">
                {d.clauses.map((c) => (
                  <li key={c.ref}><span className="mono clause-ref">{c.ref}</span><span>{highlight(c.text)}</span></li>
                ))}
              </ol>
            </Card>
          ))}
          <p className="muted small">Highlighted words are the modal verbs the Obligation Extractor uses to classify obligations as mandatory (shall/must), recommended (should) or permissive (may).</p>
        </>
      )}
    </>
  );
}
