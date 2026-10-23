import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import {
  CANVAS_H, CANVAS_W, NODE_H, NODE_W,
  type IconName, type LaneBox, type Side, type WorkflowEdge, type WorkflowNode,
} from "../workflow/model";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;

const ICONS: Record<IconName, ReactNode> = {
  clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>,
  globe: <><circle cx="8" cy="8" r="6" /><path d="M2 8h12" /><ellipse cx="8" cy="8" rx="2.6" ry="6" /></>,
  bolt: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />,
  branch: <path d="M8 1.5 14.5 8 8 14.5 1.5 8z M5.5 8h5" />,
  chat: <path d="M2.5 3h11v7.5h-6l-3 3v-3h-2z" />,
  monitor: <path d="M1.5 2.5h13V11h-13z M5.5 14h5 M8 11v3" />,
  server: <path d="M2 2.5h12V7H2z M2 9h12v4.5H2z M4.5 4.75h1 M4.5 11.25h1" />,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></>,
  doc: <path d="M3.5 1.5H9.5L12.5 4.5v10h-9z M9.5 1.5v3h3 M5.5 8h5 M5.5 11h5" />,
  link: <path d="M2 2h5v5H2z M9 9h5v5H9z M7 4.5h2.5a2 2 0 0 1 2 2V9" />,
  pen: <path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z" />,
  shield: <path d="M8 1.5 13.5 3.5v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4z M5.5 8l2 2 3-3.5" />,
  person: <><circle cx="8" cy="5" r="2.6" /><path d="M3 14c0-3 2.2-5 5-5s5 2 5 5" /></>,
  chart: <path d="M2.5 13.5h11 M4.5 11V7 M8 11V4 M11.5 11V8.5" />,
  send: <path d="M14.5 1.5 1.5 7l5 2 2 5z M6.5 9l8-7.5" />,
};

export interface Emphasis {
  nodes: Set<string>;
  edges: Set<string>;
  /** Node drawn with the strongest emphasis (e.g. the current walkthrough step). */
  current?: string;
}

interface View { x: number; y: number; k: number }

function anchor(n: WorkflowNode, side: Side): [number, number] {
  if (side === "left") return [n.x - NODE_W / 2, n.y];
  if (side === "right") return [n.x + NODE_W / 2, n.y];
  if (side === "top") return [n.x, n.y - NODE_H / 2];
  return [n.x, n.y + NODE_H / 2];
}

function autoSides(a: WorkflowNode, b: WorkflowNode): [Side, Side] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

const isHorizontal = (s: Side) => s === "left" || s === "right";
const outward: Record<Side, [number, number]> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

function edgeGeometry(e: WorkflowEdge, a: WorkflowNode, b: WorkflowNode): { d: string; mid: [number, number] } {
  const [autoFrom, autoTo] = autoSides(a, b);
  const fs = e.fromSide ?? autoFrom;
  const ts = e.toSide ?? autoTo;
  let [x1, y1] = anchor(a, fs);
  let [x2, y2] = anchor(b, ts);
  if (e.offset) {
    if (isHorizontal(fs)) { y1 += e.offset; y2 += e.offset; } else { x1 += e.offset; x2 += e.offset; }
  }
  if (e.via?.length) {
    const pts = [[x1, y1], ...e.via, [x2, y2]];
    return { d: `M${pts.map((p) => p.join(",")).join(" L")}`, mid: e.via[Math.floor(e.via.length / 2)] };
  }
  const straight = (isHorizontal(fs) && y1 === y2) || (!isHorizontal(fs) && x1 === x2);
  if (straight) return { d: `M${x1},${y1} L${x2},${y2}`, mid: [(x1 + x2) / 2, (y1 + y2) / 2] };
  const pull = Math.max(40, Math.min(160, Math.hypot(x2 - x1, y2 - y1) / 2.5));
  const [ox1, oy1] = outward[fs];
  const [ox2, oy2] = outward[ts];
  const c1 = `${x1 + ox1 * pull},${y1 + oy1 * pull}`;
  const c2 = `${x2 + ox2 * pull},${y2 + oy2 * pull}`;
  return { d: `M${x1},${y1} C${c1} ${c2} ${x2},${y2}`, mid: [(x1 + x2) / 2, (y1 + y2) / 2] };
}

function nodeShape(n: WorkflowNode): ReactNode {
  const l = n.x - NODE_W / 2;
  const t = n.y - NODE_H / 2;
  const r = l + NODE_W;
  const b = t + NODE_H;
  if (n.kind === "trigger") {
    // n8n-style trigger: rounded "start" side on the left
    const R = NODE_H / 2;
    return <path className="box" d={`M${l + R},${t} H${r - 10} Q${r},${t} ${r},${t + 10} V${b - 10} Q${r},${b} ${r - 10},${b} H${l + R} A${R},${R} 0 0 1 ${l + R},${t} Z`} />;
  }
  if (n.kind === "decision") {
    const c = 14;
    return <path className="box" d={`M${l + c},${t} H${r - c} L${r},${n.y} L${r - c},${b} H${l + c} L${l},${n.y} Z`} />;
  }
  if (n.kind === "output") {
    return <>
      <rect className="box" x={l} y={t} width={NODE_W} height={NODE_H} rx={10} />
      <rect className="box-inner" x={l + 4} y={t + 4} width={NODE_W - 8} height={NODE_H - 8} rx={7} />
    </>;
  }
  return <rect className="box" x={l} y={t} width={NODE_W} height={NODE_H} rx={10} />;
}

export default function WorkflowCanvas({
  nodes, edges, lanes, selected, onSelect, emphasis, badges = {}, ariaLabel, rightInset = 0,
}: {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  lanes: LaneBox[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  emphasis: Emphasis | null;
  badges?: Record<string, string>;
  ariaLabel: string;
  /** Width in px covered by an overlay (e.g. a details panel) on the right edge. */
  rightInset?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 0.6 });
  const userMoved = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchDist = useRef<number | null>(null);
  const dragged = useRef(false);
  const downAt = useRef({ x: 0, y: 0 });

  const fit = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(width / CANVAS_W, height / CANVAS_H) * 0.97));
    setView({ k, x: (width - CANVAS_W * k) / 2, y: (height - CANVAS_H * k) / 2 });
  }, []);

  const resetView = useCallback(() => { userMoved.current = false; fit(); }, [fit]);

  // Fit on mount and whenever the canvas resizes, until the user pans or zooms.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    fit();
    const ro = new ResizeObserver(() => { if (!userMoved.current) fit(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // Keep the selected node visible beside any right-hand overlay.
  useEffect(() => {
    const el = wrapRef.current;
    const n = selected ? nodes.find((x) => x.id === selected) : undefined;
    if (!el || !n) return;
    const visibleW = el.clientWidth - rightInset;
    setView((v) => {
      const left = v.x + (n.x - NODE_W / 2) * v.k;
      const right = v.x + (n.x + NODE_W / 2) * v.k;
      const top = v.y + (n.y - NODE_H / 2) * v.k;
      const bottom = v.y + (n.y + NODE_H / 2) * v.k;
      const inside = left >= 8 && right <= visibleW - 8 && top >= 8 && bottom <= el.clientHeight - 8;
      return inside ? v : { ...v, x: visibleW / 2 - n.x * v.k, y: el.clientHeight / 2 - n.y * v.k };
    });
  }, [selected, rightInset, nodes]);

  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    userMoved.current = true;
    setView((v) => {
      const el = wrapRef.current;
      const cx = px ?? (el ? el.clientWidth / 2 : 0);
      const cy = py ?? (el ? el.clientHeight / 2 : 0);
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
      const ratio = k / v.k;
      return { k, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
    });
  }, []);

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms; a plain wheel keeps scrolling the page.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0025), e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if ((e.target as Element).closest("[data-node], button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pinchDist.current = null;
    dragged.current = false;
    downAt.current = { x: e.clientX, y: e.clientY };
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const pts = pointers.current;
    if (pts.size === 1) {
      if (Math.hypot(e.clientX - downAt.current.x, e.clientY - downAt.current.y) > 4) dragged.current = true;
      userMoved.current = true;
      setView((v) => ({ ...v, x: v.x + e.clientX - prev.x, y: v.y + e.clientY - prev.y }));
    } else if (pts.size === 2) {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [p1, p2] = [...pts.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (pinchDist.current) {
        const rect = e.currentTarget.getBoundingClientRect();
        zoomAt(dist / pinchDist.current, (p1.x + p2.x) / 2 - rect.left, (p1.y + p2.y) / 2 - rect.top);
      }
      pinchDist.current = dist;
      return;
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    pinchDist.current = null;
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const pan = (dx: number, dy: number) => { userMoved.current = true; setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy })); };
    const keys: Record<string, () => void> = {
      ArrowLeft: () => pan(60, 0), ArrowRight: () => pan(-60, 0), ArrowUp: () => pan(0, 60), ArrowDown: () => pan(0, -60),
      "+": () => zoomAt(1.2), "=": () => zoomAt(1.2), "-": () => zoomAt(1 / 1.2), "0": resetView,
      Escape: () => onSelect(null),
    };
    const action = keys[e.key];
    if (action) { e.preventDefault(); action(); }
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const labels: ReactNode[] = [];
  const dimNode = (id: string) => emphasis !== null && !emphasis.nodes.has(id);
  const dimEdge = (id: string) => emphasis !== null && !emphasis.edges.has(id);

  return (
    <div className="wf-canvas" ref={wrapRef} tabIndex={0} role="group"
      aria-label={`${ariaLabel}. Arrow keys pan, plus and minus zoom, 0 fits the view, Tab moves between nodes.`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        const bg = e.target === e.currentTarget || (e.target as Element).classList.contains("wf-bg");
        if (bg && !dragged.current) onSelect(null);
      }}>
      <svg width="100%" height="100%">
        <defs>
          {(["base", "active", "loop", "remote"] as const).map((m) => (
            <marker key={m} id={`wf-arr-${m}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className={`wf-head ${m}`} />
            </marker>
          ))}
        </defs>
        <rect className="wf-bg" width="100%" height="100%" />
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {lanes.map((l) => (
            <g key={l.id} className={`wf-lane lane-${l.id}`}>
              <rect x={l.x} y={l.y} width={l.w} height={l.h} rx={14} />
              <text x={l.x + 16} y={l.y + 24} className="wf-lane-title">{l.title}</text>
              <text x={l.x + 16 + l.title.length * 8.6 + 10} y={l.y + 24} className="wf-lane-sub">{l.subtitle}</text>
            </g>
          ))}
          {edges.map((e) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const { d, mid } = edgeGeometry(e, a, b);
            const active = emphasis?.edges.has(e.id) ?? false;
            const style = e.style ?? "flow";
            const marker = active ? "active" : style === "loop" ? "loop" : style === "remote" ? "remote" : "base";
            const [lx, ly] = e.labelAt ?? mid;
            const cls = `wf-edge ${style} ${active ? "active" : ""} ${dimEdge(e.id) ? "dim" : ""}`;
            if (e.label) labels.push(<g key={e.id} className={cls}><text x={lx} y={ly} textAnchor="middle" className="wf-edge-label">{e.label}</text></g>);
            return (
              <g key={e.id} className={cls}>
                <path d={d} markerEnd={`url(#wf-arr-${marker})`} />
              </g>
            );
          })}
          {nodes.map((n) => {
            const isSel = selected === n.id;
            const isCur = emphasis?.current === n.id;
            const l = n.x - NODE_W / 2;
            const badge = badges[n.id];
            return (
              <g key={n.id} data-node={n.id} role="button" tabIndex={0} aria-pressed={isSel}
                aria-label={`${n.label} (${n.tech}): ${n.purpose}`}
                className={`wf-node kind-${n.kind} ${isSel ? "selected" : ""} ${isCur ? "current" : ""} ${dimNode(n.id) ? "dim" : ""}`}
                onClick={() => onSelect(isSel ? null : n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onSelect(isSel ? null : n.id); }
                }}>
                <title>{`${n.label}: ${n.purpose}`}</title>
                {nodeShape(n)}
                <circle className="icon-bg" cx={l + 26} cy={n.y} r={15} />
                <g className="icon" transform={`translate(${l + 18},${n.y - 8})`}>{ICONS[n.icon]}</g>
                <text x={l + 50} y={n.y - 3} className="wf-node-label">{n.label}</text>
                <text x={l + 50} y={n.y + 14} className="wf-node-tech">{n.tech}</text>
                {badge && (
                  <g className="wf-badge">
                    <rect x={l + NODE_W - 30} y={n.y - NODE_H / 2 - 10} width={34} height={20} rx={10} />
                    <text x={l + NODE_W - 13} y={n.y - NODE_H / 2 + 4} textAnchor="middle">{badge}</text>
                  </g>
                )}
              </g>
            );
          })}
          {labels}
        </g>
      </svg>
      <div className="wf-controls" role="toolbar" aria-label="Canvas view">
        <button type="button" onClick={() => zoomAt(1.2)} aria-label="Zoom in" title="Zoom in (+)">+</button>
        <button type="button" onClick={() => zoomAt(1 / 1.2)} aria-label="Zoom out" title="Zoom out (-)">−</button>
        <button type="button" onClick={resetView} aria-label="Fit workflow to screen" title="Fit to screen (0)" className="wide">Fit</button>
        <span className="wf-zoom" aria-live="polite">{Math.round(view.k * 100)}%</span>
      </div>
      <div className="wf-hint" aria-hidden>Drag to pan · Ctrl + scroll or pinch to zoom · click a node for details</div>
    </div>
  );
}
