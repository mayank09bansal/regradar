import RunScope from "../components/RunScope";
import { Card, EmptyState, SeverityBadge, Stat } from "../components/ui";

/** The ranked plan, with the reasoning behind each risk score. */
export default function RemediationPage() {
  return (
    <RunScope title="Remediation Plan" subtitle="Output Agent prioritisation: risk score = severity weight x urgency x exposure x classification factor.">
      {(run) => {
        const plan = run.remediation_plan;
        if (!plan.length) return <EmptyState title="No accepted gaps, so no remediation items" />;
        const by = (p: string) => plan.filter((i) => i.priority === p).length;
        return (
          <>
            <div className="stats-grid three">
              <Stat label="P1 - act within 30 days" value={by("P1")} tone="bad" />
              <Stat label="P2 - within 60 days" value={by("P2")} tone="warn" />
              <Stat label="P3 - within 90 days" value={by("P3")} tone="info" />
            </div>
            <Card title="Prioritised actions">
              <ol className="remediation">
                {plan.map((item) => (
                  <li key={item.gap_id} className={`rem-item prio-${item.priority}`}>
                    <div className="rem-rank">{item.rank}</div>
                    <div className="rem-body">
                      <div className="row gap-s wrap">
                        <span className={`prio prio-${item.priority}`}>{item.priority}</span>
                        <strong>{item.title}</strong>
                        <SeverityBadge severity={item.severity} />
                      </div>
                      <div className="small muted">
                        <span className="mono">{item.gap_id}</span> - {item.citation} - owner <strong>{item.owner}</strong> - target <strong>{item.target_date}</strong>
                      </div>
                      <ul className="tight">{item.actions.map((a) => <li key={a}>{a}</li>)}</ul>
                      <div className="breakdown small">
                        Score <strong>{item.risk_score}</strong> = {Object.entries(item.score_breakdown).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" x ")}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          </>
        );
      }}
    </RunScope>
  );
}
