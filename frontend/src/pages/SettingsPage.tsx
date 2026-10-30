import { useState, type FormEvent } from "react";
import { api, API_BASE_URL, getApiToken, setApiToken } from "../api";
import { Card, ErrorBox, Loading, PageHeader, Pill } from "../components/ui";
import { useAsync } from "../hooks";

/** Yes/no pill for configuration flags. */
function Bool({ value }: { value: boolean }) {
  return <Pill value={value ? "yes" : "no"} tone={value ? "good" : "muted"} />;
}

/** Enter the API token for write actions. It is saved for this tab and never displayed again. */
function WriteAccessCard({ required }: { required: boolean | undefined }) {
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(() => Boolean(getApiToken()));

  function save(e: FormEvent) {
    e.preventDefault();
    setApiToken(token.trim());
    setSaved(Boolean(token.trim()));
    setToken("");
  }

  function clear() {
    setApiToken("");
    setSaved(false);
  }

  return (
    <Card title="Write access">
      <dl className="kv">
        <dt>Token required</dt><dd>{required === undefined ? "-" : <Bool value={required} />}</dd>
        <dt>Saved in this tab</dt><dd><Bool value={saved} /></dd>
      </dl>
      {required === false && (
        <p className="small muted">
          Anyone who can reach this API can start runs and change data. Set <code>REGRADAR_API_TOKEN</code> on any shared deployment.
        </p>
      )}
      <form onSubmit={save} className="row gap-s wrap mt">
        <label className="field grow"><span>API token</span>
          <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <button className="btn btn-secondary" type="submit" disabled={!token.trim()}>Save token</button>
        <button className="btn btn-secondary" type="button" onClick={clear} disabled={!saved}>Clear</button>
      </form>
      <p className="small muted" role="status">
        {saved ? "Token saved for this browser tab." : "No token saved. It is kept for this tab only."}
      </p>
    </Card>
  );
}

/** Read-only backend configuration and health, plus token entry. */
export default function SettingsPage() {
  const health = useAsync(() => api.health(), "health");
  const config = useAsync(() => api.config(), "config-settings");
  const [testResult, setTestResult] = useState<string | null>(null);

  async function testIntegrations() {
    setTestResult("Sending...");
    try {
      const r = await api.testIntegrations();
      setTestResult(Object.entries(r.results).map(([k, v]) => `${k}: ${v}`).join(" | "));
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <PageHeader title="Settings & Health" subtitle="Read-only view of the backend configuration. Secrets are never sent to the browser - only whether they are set." />
      <div className="two-col">
        <Card title="API health" actions={<button className="btn btn-secondary" onClick={health.reload}>Re-check</button>}>
          {health.loading ? <Loading /> : health.error ? <ErrorBox error={health.error} /> : health.data && (
            <dl className="kv">
              <dt>API base URL</dt><dd className="mono small">{API_BASE_URL || `${window.location.origin} (same origin)`}</dd>
              <dt>Deployment</dt><dd>{health.data.deployment}</dd>
              <dt>Run storage</dt><dd>{health.data.storage} <Bool value={health.data.storage_persistent} /></dd>
              <dt>Status</dt><dd><Pill value={health.data.status} tone="good" /></dd>
              <dt>Version</dt><dd>{health.data.version}</dd>
              <dt>Database</dt><dd>{health.data.database}</dd>
              <dt>Server time</dt><dd>{health.data.time}</dd>
              <dt>API docs</dt><dd><a href={`${API_BASE_URL}/docs`} target="_blank" rel="noreferrer">{API_BASE_URL}/docs</a></dd>
            </dl>
          )}
        </Card>
        <Card title="LLM configuration">
          {config.loading ? <Loading /> : config.error ? <ErrorBox error={config.error} /> : config.data && (
            <dl className="kv">
              <dt>LLM_PROVIDER</dt><dd>{config.data.llm_provider}</dd>
              <dt>LLM_MODEL</dt><dd>{config.data.llm_model || "(not set)"}</dd>
              <dt>Live LLM ready</dt><dd><Bool value={config.data.live_llm_configured} /></dd>
              <dt>ANTHROPIC_API_KEY set</dt><dd><Bool value={config.data.anthropic_api_key_set} /></dd>
              <dt>OPENAI_API_KEY set</dt><dd><Bool value={config.data.openai_api_key_set} /></dd>
              <dt>OPENAI_BASE_URL</dt><dd className="mono small">{config.data.openai_base_url}</dd>
              <dt>MAX_REVISIONS</dt><dd>{config.data.max_revisions}</dd>
            </dl>
          )}
          <p className="small muted">Demo runs always use the deterministic responder. Change these values in the project's <code>.env</code> file and restart the backend.</p>
        </Card>
        <Card title="Sources & integrations">
          {config.data && (
            <dl className="kv">
              <dt>Live sources enabled</dt><dd><Bool value={config.data.live_sources_enabled} /></dd>
              <dt>RBI RSS</dt><dd className="mono small">{config.data.rbi_rss_url}</dd>
              <dt>SEBI RSS</dt><dd className="mono small">{config.data.sebi_rss_url}</dd>
              <dt>Slack webhook</dt><dd><Bool value={config.data.slack_configured} /></dd>
              <dt>n8n webhook</dt><dd><Bool value={config.data.n8n_configured} /></dd>
              <dt>CORS origins</dt><dd className="small">{config.data.cors_origins.join(", ")}</dd>
              <dt>Run storage</dt><dd className="mono small">{config.data.database}</dd>
            </dl>
          )}
          <button className="btn btn-secondary" onClick={testIntegrations}>Send test notification</button>
          {testResult && <p className="small">{testResult}</p>}
        </Card>
        <WriteAccessCard required={config.data?.write_auth_required} />
      </div>
    </>
  );
}
