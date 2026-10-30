// Chart primitives for the dashboard, drawn with plain SVG and HTML so the app stays
// free of a chart dependency. Colours come from the --viz-* tokens in dashboard.css.
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject,
} from "react";
import { Link } from "react-router-dom";
import { Card } from "../components/ui";
import { niceTicks } from "./metrics";
import { TipContext, tipAtElement, useMarkTip, useTipApi, type TipApi, type TipContent } from "./tipContext";

const TIP_MARGIN = 8;
const TIP_OFFSET = 12;

/** Provides the single shared tooltip; wrap anything containing chart marks. */
export function TipLayer({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<{ content: TipContent; x: number; y: number } | null>(null);
  const [offset, setOffset] = useState({ left: 0, top: 0 });
  const box = useRef<HTMLDivElement>(null);
  const api = useMemo<TipApi>(() => ({
    show: (content, x, y) => setTip({ content, x, y }),
    hide: () => setTip(null),
  }), []);

  // measured after render so the tooltip can flip and clamp inside the viewport
  useLayoutEffect(() => {
    if (!tip || !box.current) return;
    const { width, height } = box.current.getBoundingClientRect();
    const fitsAbove = tip.y - height - TIP_OFFSET >= TIP_MARGIN;
    setOffset({
      left: Math.min(Math.max(TIP_MARGIN, tip.x - width / 2), window.innerWidth - width - TIP_MARGIN),
      top: fitsAbove ? tip.y - height - TIP_OFFSET : tip.y + TIP_OFFSET,
    });
  }, [tip]);

  return (
    <TipContext.Provider value={api}>
      {children}
      {tip && (
        <div ref={box} className="viz-tip" style={{ left: offset.left, top: offset.top }} aria-hidden>
          <div className="viz-tip-title">{tip.content.title}</div>
          {tip.content.rows.map((row) => (
            <div className="viz-tip-row" key={row.label}>
              {row.color && <span className="viz-tip-key" style={{ background: row.color }} />}
              <strong>{row.value}</strong>
              <span>{row.label}</span>
            </div>
          ))}
        </div>
      )}
    </TipContext.Provider>
  );
}

/** Colour key entry; bars use a block and lines use a stroke, mirroring the mark. */
export interface LegendEntry { label: string; color: string }

export function Legend({ items, kind = "bar" }: { items: LegendEntry[]; kind?: "bar" | "line" }) {
  return (
    <ul className="viz-legend">
      {items.map((item) => (
        <li key={item.label}>
          <span className={`viz-swatch ${kind}`} style={{ background: item.color }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** Table twin of a chart: every plotted value, readable without hovering. */
export interface ChartTable { headers: string[]; rows: (string | number)[][] }

/** Card holding a chart, with a toggle to its table view. */
export function ChartCard({ title, subtitle, actions, table, className, children }: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  table: ChartTable;
  className?: string;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card
      className={className}
      title={title}
      actions={
        <div className="row gap-s">
          {actions}
          <button type="button" className="link-btn" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
            {asTable ? "Show chart" : "Show table"}
          </button>
        </div>
      }
    >
      {subtitle && <p className="muted small viz-subtitle">{subtitle}</p>}
      {asTable ? (
        <div className="table-wrap">
          <table className="viz-table">
            <thead><tr>{table.headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : children}
    </Card>
  );
}

/** One part of a whole. `darkInk` is for fills too light to carry white text. */
export interface BarPart { key: string; label: string; value: number; color: string; darkInk?: boolean }

function percent(value: number, total: number): string {
  return `${total ? Math.round((100 * value) / total) : 0}%`;
}

function Segment({ part, total, tall }: { part: BarPart; total: number; tall: boolean }) {
  const handlers = useMarkTip({
    title: part.label,
    rows: [{ label: `of ${total}`, value: `${part.value} (${percent(part.value, total)})`, color: part.color }],
  });
  const share = part.value / total;
  return (
    <span
      className={`viz-seg ${part.darkInk ? "dark-ink" : ""}`}
      style={{ flexGrow: part.value, background: part.color }}
      tabIndex={0}
      aria-label={`${part.label}: ${part.value} of ${total}, ${percent(part.value, total)}`}
      {...handlers}
    >
      {/* a block too narrow for its figure prints none; the tooltip and table keep the value */}
      {tall && share >= 0.1 && percent(part.value, total)}
    </span>
  );
}

/** One whole split into proportional parts; a part at zero draws nothing. */
export function SegmentedBar({ parts, tall = false, label }: { parts: BarPart[]; tall?: boolean; label: string }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  if (!total) return <div className="viz-bar empty" aria-label={`${label}: nothing to show`} role="img" />;
  return (
    <div className={`viz-bar ${tall ? "tall" : ""}`} role="group" aria-label={label}>
      {parts.filter((p) => p.value > 0).map((part) => <Segment key={part.key} part={part} total={total} tall={tall} />)}
    </div>
  );
}

/** One category in a StackedRows chart. */
export interface StackedRow { key: string; label: string; hint?: string; to?: string; parts: BarPart[] }

/**
 * Horizontal stacks on a shared scale, so row length compares totals and the split
 * compares composition.
 */
export function StackedRows({ rows, unit }: { rows: StackedRow[]; unit: string }) {
  const totals = rows.map((row) => row.parts.reduce((sum, p) => sum + p.value, 0));
  const max = Math.max(1, ...totals);
  return (
    <ul className="viz-rows">
      {rows.map((row, i) => (
        <li key={row.key}>
          <div className="viz-row-label">
            {row.to ? <Link to={row.to}>{row.label}</Link> : <span>{row.label}</span>}
            {row.hint && <span className="muted small">{row.hint}</span>}
          </div>
          <div className="viz-row-track">
            <div className="viz-row-fill" style={{ width: `${(100 * totals[i]) / max}%` }}>
              <SegmentedBar parts={row.parts} label={`${row.label}: ${totals[i]} ${unit}`} />
            </div>
            <span className="viz-row-total">{totals[i]}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function RankedBar({ label, value, max, unit }: { label: string; value: number; max: number; unit: string }) {
  const handlers = useMarkTip({ title: label, rows: [{ label: unit, value: String(value), color: "var(--viz-1)" }] });
  return (
    <li>
      <span className="viz-rank-label">{label}</span>
      <div className="viz-rank-track" tabIndex={0} aria-label={`${label}: ${value} ${unit}`} {...handlers}>
        <span className="viz-rank-fill" style={{ width: `${(100 * value) / max}%` }} />
        <span className="viz-rank-value">{value}</span>
      </div>
    </li>
  );
}

/** Ranked bars for nominal categories: one colour, as length already carries the value. */
export function RankedBars({ items, unit }: { items: { key: string; label: string; value: number }[]; unit: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="viz-ranks">
      {items.map((item) => <RankedBar key={item.key} label={item.label} value={item.value} max={max} unit={unit} />)}
    </ul>
  );
}

const SPARK_WIDTH = 96;
const SPARK_HEIGHT = 28;
const SPARK_PAD = 4;

/** Small trend with the current run marked. Fewer than two points means no trend to draw. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return <span className="viz-spark-empty" />;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values.map((value, i) => [
    SPARK_PAD + (i * (SPARK_WIDTH - SPARK_PAD * 2)) / (values.length - 1),
    SPARK_HEIGHT - SPARK_PAD - ((value - min) / span) * (SPARK_HEIGHT - SPARK_PAD * 2),
  ]);
  const [lastX, lastY] = points[points.length - 1];
  return (
    <svg className="viz-spark" width={SPARK_WIDTH} height={SPARK_HEIGHT} role="img"
      aria-label={`${label}, last ${values.length} runs: ${values.join(", ")}`}>
      <polyline points={points.map((p) => p.join(",")).join(" ")} />
      <circle cx={lastX} cy={lastY} r={3} />
    </svg>
  );
}

/** Tracks an element's width, so SVG text stays readable instead of scaling with the box. */
function useWidth<T extends HTMLElement>(initial: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth || initial);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [initial]);
  return [ref, width];
}

/** One plotted line; a null value leaves a break rather than inventing a point. */
export interface LineSeries { key: string; label: string; color: string; values: (number | null)[] }

const MARGIN = { top: 14, right: 40, bottom: 24, left: 34 };
const MIN_END_LABEL_GAP = 14;

/** SVG path for a series, starting a new sub-path after each null. */
function linePath(values: (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let path = "";
  let pen = false;
  values.forEach((value, i) => {
    if (value === null) {
      pen = false;
      return;
    }
    path += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(value).toFixed(1)}`;
    pen = true;
  });
  return path;
}

/** Evenly spread indexes for x labels, always keeping the first and last. */
function labelIndexes(count: number, slots: number): number[] {
  if (count <= slots) return Array.from({ length: count }, (_, i) => i);
  return Array.from({ length: slots }, (_, i) => Math.round((i * (count - 1)) / (slots - 1)));
}

/**
 * Line chart on a single axis with a crosshair that snaps to the nearest run. Arrow keys
 * step through runs, and clicking or pressing Enter selects one.
 */
export function LineChart({ labels, tipTitles, series, height = 190, format = String, yMax, selected, onPick, label }: {
  labels: string[];
  /** Tooltip heading per point, when the axis label alone is ambiguous. */
  tipTitles?: string[];
  series: LineSeries[];
  height?: number;
  format?: (value: number) => string;
  yMax?: number;
  /** Index of the run currently being viewed, ringed on the chart. */
  selected?: number;
  onPick?: (index: number) => void;
  label: string;
}) {
  const [frame, width] = useWidth<HTMLDivElement>(520);
  const [active, setActive] = useState<number | null>(null);
  const tip = useTipApi();

  const count = labels.length;
  const plotWidth = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const observed = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const ticks = niceTicks(yMax ?? Math.max(1, ...observed));
  const top = ticks[ticks.length - 1];
  const x = useCallback((i: number) => MARGIN.left + (count > 1 ? (i * plotWidth) / (count - 1) : plotWidth / 2), [count, plotWidth]);
  const y = useCallback((v: number) => MARGIN.top + plotHeight - (v / top) * plotHeight, [plotHeight, top]);

  const tipFor = useCallback((i: number): TipContent => ({
    title: tipTitles?.[i] ?? labels[i],
    rows: series.map((s) => {
      const value = s.values[i];
      return { label: s.label, value: value === null ? "-" : format(value), color: s.color };
    }),
  }), [labels, tipTitles, series, format]);

  function nearest(e: MouseEvent<SVGRectElement>): number {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = count > 1 ? (e.clientX - box.left) / box.width : 0;
    return Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1))));
  }

  function hover(e: PointerEvent<SVGRectElement>) {
    const i = nearest(e);
    setActive(i);
    tip.show(tipFor(i), e.clientX, e.clientY);
  }

  function leave() {
    setActive(null);
    tip.hide();
  }

  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === "Enter" && active !== null) {
      onPick?.(active);
      return;
    }
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = Math.min(count - 1, Math.max(0, (active ?? count) + step));
    setActive(next);
    tipAtElement(tip, tipFor(next), e.currentTarget);
  }

  // an end label is only useful beside its own line, so converging lines defer to the legend
  const endValues = series.map((s) => s.values[count - 1] ?? null);
  const endLabels = series.map((s, i) => {
    const value = endValues[i];
    if (value === null) return null;
    const clashes = endValues.some((other, j) => j !== i && other !== null && Math.abs(y(other) - y(value)) < MIN_END_LABEL_GAP);
    return clashes ? null : { key: s.key, value };
  });

  return (
    <div ref={frame} className="viz-line">
      <svg width={width} height={height} tabIndex={0} role="img" aria-label={`${label}. Use the arrow keys to step through runs.`}
        onKeyDown={onKey} onBlur={leave}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line className={tick === 0 ? "viz-baseline" : "viz-grid"} x1={MARGIN.left} x2={MARGIN.left + plotWidth} y1={y(tick)} y2={y(tick)} />
            <text className="viz-axis" x={MARGIN.left - 6} y={y(tick) + 4} textAnchor="end">{format(tick)}</text>
          </g>
        ))}
        {labelIndexes(count, Math.max(2, Math.floor(plotWidth / 110))).map((i) => (
          <text key={i} className="viz-axis" x={x(i)} y={height - 6}
            textAnchor={count === 1 ? "middle" : i === 0 ? "start" : i === count - 1 ? "end" : "middle"}>
            {labels[i]}
          </text>
        ))}
        {active !== null && <line className="viz-crosshair" x1={x(active)} x2={x(active)} y1={MARGIN.top} y2={MARGIN.top + plotHeight} />}
        {series.map((s) => <path key={s.key} className="viz-path" d={linePath(s.values, x, y)} style={{ stroke: s.color }} />)}
        {series.flatMap((s) => {
          const shown = [active, selected, count - 1].filter((i): i is number => i !== null && i !== undefined);
          return [...new Set(shown)].map((i) => {
            const value = s.values[i];
            return value === null ? null : <circle key={`${s.key}-${i}`} className="viz-dot" cx={x(i)} cy={y(value)} r={4} style={{ fill: s.color }} />;
          });
        })}
        {endLabels.map((end) => end && (
          <text key={end.key} className="viz-end" x={x(count - 1) + 8} y={y(end.value) + 4}>{format(end.value)}</text>
        ))}
        <rect className={`viz-hit ${onPick ? "pickable" : ""}`} x={MARGIN.left - 12} y={MARGIN.top} width={plotWidth + 24} height={plotHeight}
          onPointerMove={hover} onPointerLeave={leave} onClick={(e) => onPick?.(nearest(e))} />
      </svg>
    </div>
  );
}

const HEAT_STEPS = 4;

/** Sequential step for a count: 0 stays empty and the largest count takes the top step. */
function heatStep(value: number, max: number): number {
  return value ? Math.max(1, Math.ceil((value / Math.max(1, max)) * HEAT_STEPS)) : 0;
}

function HeatCell({ value, max, rowLabel, columnLabel, selected, onPick }: {
  value: number; max: number; rowLabel: string; columnLabel: string; selected: boolean; onPick: () => void;
}) {
  const content = `${value} action${value === 1 ? "" : "s"}`;
  const handlers = useMarkTip({ title: `${rowLabel}, ${columnLabel}`, rows: [{ label: "remediation", value: content }] });
  return (
    <td>
      <button type="button" className={`viz-heat step-${heatStep(value, max)} ${selected ? "selected" : ""}`}
        aria-pressed={selected} aria-label={`${rowLabel}, ${columnLabel}: ${content}`} disabled={!value} onClick={onPick} {...handlers}>
        {value || ""}
      </button>
    </td>
  );
}

/** Count grid on one sequential hue. It is a real table, so it needs no separate twin. */
export function HeatGrid<R extends string, C extends string>({ rows, columns, corner, value, selected, onPick }: {
  rows: { id: R; label: string }[];
  columns: { id: C; label: string }[];
  corner: string;
  value: (row: R, column: C) => number;
  selected: { row: R; column: C } | null;
  onPick: (row: R, column: C) => void;
}) {
  const max = Math.max(0, ...rows.flatMap((r) => columns.map((c) => value(r.id, c.id))));
  return (
    <>
      <div className="table-wrap">
        <table className="viz-heatgrid">
          <thead>
            <tr><th scope="col">{corner}</th>{columns.map((c) => <th key={c.id} scope="col">{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.label}</th>
                {columns.map((column) => (
                  <HeatCell key={column.id} value={value(row.id, column.id)} max={max} rowLabel={row.label} columnLabel={column.label}
                    selected={selected?.row === row.id && selected.column === column.id}
                    onPick={() => onPick(row.id, column.id)} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="viz-heat-scale" aria-hidden>
        <span>Fewer</span>
        {Array.from({ length: HEAT_STEPS }, (_, i) => <span key={i} className={`viz-heat-chip step-${i + 1}`} />)}
        <span>More</span>
      </div>
    </>
  );
}
