import { api } from "../api";
import { Card, ErrorBox, Loading, PageHeader } from "../components/ui";
import { useAsync } from "../hooks";
import type { GraphSpec } from "../types";

// Fixed layout positions for the LangGraph nodes (viewBox 760 x 500).
const POS: Record<string, [number, number]> = {
  START: [380, 24],
  regulatory_scout: [380, 84],
  obligation_extractor: [380, 150],
  control_mapper: [380, 216],
  gap_synthesiser: [230, 300],
  novelty_validator: [530, 300],
  escalation: [650, 400],
  output_agent: [380, 400],
  END: [380, 470],
};

function edgePath(from: string, to: string): string {
  const [x1, y1] = POS[from] ?? [0, 0];
  const [x2, y2] = POS[to] ?? [0, 0];
  if (from === "gap_synthesiser" && to === "novelty_validator") return `M${x1 + 75},${y1 - 7} L${x2 - 77},${y2 - 7}`;
  if (from === "novelty_validator" && to === "gap_synthesiser") return `M${x1 - 75},${y1 + 7} L${x2 + 77},${y2 + 7}`;
  if (from === "regulatory_scout" && to === "output_agent")
    return `M${x1 - 75},${y1} C${90},${y1 + 20} ${90},${y2 - 10} ${x2 - 77},${y2}`;
  if (from === "novelty_validator" && to === "output_agent") return `M${x1 - 20},${y1 + 16} L${x2 + 40},${y2 - 18}`;
  if (from === "novelty_validator" && to === "escalation") return `M${x1 + 40},${y1 + 16} L${x2 - 10},${y2 - 18}`;
  if (from === "escalation") return `M${x1 - 62},${y1} L${x2 + 77},${y2}`;
  if (from === "control_mapper" && to === "gap_synthesiser") return `M${x1 - 30},${y1 + 16} L${x2 + 20},${y2 - 18}`;
  return `M${x1},${y1 + 16} L${x2},${y2 - 18}`;
}

const EDGE_LABELS: Record<string, [number, number, string]> = {
  "novelty_validator>gap_synthesiser": [380, 330, "revise"],
  "regulatory_scout>output_agent": [100, 250, "no documents"],
  "novelty_validator>output_agent": [436, 362, "finalise"],
  "novelty_validator>escalation": [630, 350, "escalate"],
};

function GraphDiagram({ spec }: { spec: GraphSpec }) {
  const label = (id: string) => spec.nodes.find((n) => n.id === id)?.label ?? id;
  const kind = (id: string) => spec.nodes.find((n) => n.id === id)?.kind ?? "terminal";
  return (
    <svg viewBox="0 0 760 500" className="graph-svg" role="img" aria-label="LangGraph state graph of the six RegRadar agents">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="edge-head" />
        </marker>
      </defs>
      {spec.edges.map((e) => {
        const key = `${e.from}>${e.to}`;
        const loopBack = key === "novelty_validator>gap_synthesiser";
        const lbl = EDGE_LABELS[key];
        return (
          <g key={key} className={loopBack ? "edge loop" : e.condition ? "edge cond" : "edge"}>
            <path d={edgePath(e.from, e.to)} markerEnd="url(#arr)" fill="none" />
            {lbl && <text x={lbl[0]} y={lbl[1]} textAnchor="middle" className={`edge-label ${loopBack ? "loop" : ""}`}>{lbl[2]}</text>}
          </g>
        );
      })}
      {Object.entries(POS).map(([id, [x, y]]) => {
        const k = kind(id);
        const w = k === "terminal" ? 70 : 150;
        return (
          <g key={id} className={`gnode ${k} ${id === "gap_synthesiser" || id === "novelty_validator" ? "loopnode" : ""}`}>
            <rect x={x - w / 2} y={y - 16} width={w} height={32} rx={k === "terminal" ? 16 : 8} />
            <text x={x} y={y + 5} textAnchor="middle">{label(id)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function ArchitecturePage() {
  const graph = useAsync(() => api.graph(), "graph");
  const agents = useAsync(() => api.agents(), "agents");
  return (
    <>
      <PageHeader title="Architecture" subtitle="LangGraph StateGraph served live by the backend (/api/graph), plus the agent registry (/api/agents)." />
      <Card title="Orchestration graph">
        {graph.loading ? <Loading /> : graph.error ? <ErrorBox error={graph.error} /> : graph.data && <GraphDiagram spec={graph.data} />}
        <ul className="small tight">
          <li><strong>Shared state</strong>: a typed <code>RegRadarState</code>; agents communicate only by reading and writing it. <code>trace</code> uses an additive reducer.</li>
          <li><strong>Conditional edge after the validator</strong>: <em>finalise</em> when nothing is rejected, <em>revise</em> while revisions are below the limit, otherwise <em>escalate</em>.</li>
          <li><strong>Structured feedback</strong>: the validator writes <code>pending_feedback</code> (issue codes, fields, expected values); the synthesiser consumes it on its next turn.</li>
        </ul>
      </Card>
      <Card title="The six agents">
        {agents.loading ? <Loading /> : agents.error ? <ErrorBox error={agents.error} /> : (
          <div className="agent-grid">
            {agents.data?.map((a) => (
              <div key={a.name} className="agent-card">
                <div className="agent-num">{a.order}</div>
                <h3>{a.display_name}</h3>
                <p>{a.role}</p>
                <dl className="kv small">
                  <dt>Reads</dt><dd>{a.inputs.join(", ")}</dd>
                  <dt>Writes</dt><dd>{a.outputs.join(", ")}</dd>
                  <dt>Reasoning</dt><dd>{a.reasoning}</dd>
                  <dt>LLM (live)</dt><dd>{a.uses_llm_in_live_mode ? "yes" : "no - deterministic"}</dd>
                </dl>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
