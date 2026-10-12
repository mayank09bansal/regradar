import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAsync } from "../hooks";
import type { AnalysisRequestBody } from "../types";
import { Card, ErrorBox, PageHeader } from "../components/ui";

/** Example circular with mandatory and recommended clauses, showing the expected format. */
const SAMPLE = `7.1 Payment aggregators shall report every unauthorised transaction complaint to the regulator within 24 hours.

7.2 Payment aggregators shall retain transaction logs for a minimum period of 5 years within India.

7.3 Payment aggregators should review merchant onboarding controls quarterly.`;

/** Form that configures and starts a demo or live analysis. */
export default function AnalyzePage() {
  const config = useAsync(() => api.config(), "config");
  const navigate = useNavigate();
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [regulators, setRegulators] = useState<string[]>([]);
  const [liveFeeds, setLiveFeeds] = useState(false);
  const [maxRevisions, setMaxRevisions] = useState(2);
  const [notify, setNotify] = useState(false);
  const [doc, setDoc] = useState({ title: "", regulator: "RBI", text: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const liveReady = config.data?.live_llm_configured ?? false;

  function toggleRegulator(r: string) {
    setRegulators((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body: AnalysisRequestBody = {
      mode,
      regulators,
      include_live_feeds: mode === "live" && liveFeeds,
      documents: mode === "live" && doc.text.trim() ? [{ title: doc.title || "Pasted circular", regulator: doc.regulator, text: doc.text }] : [],
      max_revisions: maxRevisions,
      notify,
    };
    setSubmitting(true);
    try {
      const run = await api.createRun(body);
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader title="New Analysis" subtitle="Configure a run. Every run executes the full six-agent LangGraph pipeline." />
      <form onSubmit={submit} className="form-grid">
        <Card title="1. Mode">
          <div className="choice-row" role="radiogroup" aria-label="Mode">
            <label className={`choice ${mode === "demo" ? "selected" : ""}`}>
              <input type="radio" name="mode" checked={mode === "demo"} onChange={() => setMode("demo")} />
              <strong>Demo (deterministic)</strong>
              <span>Synthetic RBI/MEITY-style dataset and a deterministic demo responder. No API key. Reproducible feedback loop.</span>
            </label>
            <label className={`choice ${mode === "live" ? "selected" : ""}`}>
              <input type="radio" name="mode" checked={mode === "live"} onChange={() => setMode("live")} />
              <strong>Live (LLM)</strong>
              <span>
                Paste a circular and/or pull RBI & SEBI RSS feeds. Uses {config.data ? `${config.data.llm_provider}/${config.data.llm_model || "?"}` : "the configured LLM"}.
                {!liveReady && <em className="warn-text"> Live LLM not configured - see Settings.</em>}
              </span>
            </label>
          </div>
        </Card>

        <Card title="2. Scope">
          <fieldset className="checks">
            <legend>Regulators (empty = all)</legend>
            {["RBI", "MEITY", "SEBI"].map((r) => (
              <label key={r}><input type="checkbox" checked={regulators.includes(r)} onChange={() => toggleRegulator(r)} /> {r}</label>
            ))}
          </fieldset>
          <label className="field">
            <span>Maximum revision cycles (Gap Synthesiser to Validator): <strong>{maxRevisions}</strong></span>
            <input type="range" min={0} max={5} value={maxRevisions} onChange={(e) => setMaxRevisions(Number(e.target.value))} />
          </label>
          <label className="inline-check">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            Send Slack / n8n notification when finished (if configured)
          </label>
        </Card>

        {mode === "live" && (
          <Card title="3. Live sources">
            <label className="inline-check">
              <input type="checkbox" checked={liveFeeds} onChange={(e) => setLiveFeeds(e.target.checked)} />
              Fetch RBI and SEBI RSS feeds (needs internet access to rbi.org.in / sebi.gov.in)
            </label>
            <div className="row gap-s wrap">
              <label className="field grow"><span>Document title</span>
                <input value={doc.title} onChange={(e) => setDoc({ ...doc, title: e.target.value })} placeholder="e.g. Circular on payment aggregator controls" />
              </label>
              <label className="field"><span>Regulator</span>
                <input value={doc.regulator} onChange={(e) => setDoc({ ...doc, regulator: e.target.value })} maxLength={40} />
              </label>
            </div>
            <label className="field"><span>Regulation text (numbered clauses work best)</span>
              <textarea rows={9} value={doc.text} onChange={(e) => setDoc({ ...doc, text: e.target.value })} placeholder={SAMPLE} />
            </label>
            <button type="button" className="link-btn" onClick={() => setDoc({ title: "Sample payment aggregator circular", regulator: "RBI", text: SAMPLE })}>
              Insert sample text
            </button>
          </Card>
        )}

        {error && <ErrorBox error={error} />}
        <div className="row gap-s">
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? "Running agents..." : "Start analysis"}
          </button>
          <span className="muted small">Live runs can take up to a minute while the LLM responds.</span>
        </div>
      </form>
    </>
  );
}
