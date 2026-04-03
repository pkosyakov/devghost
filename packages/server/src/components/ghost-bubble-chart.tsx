'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
         Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import type { GhostMetric } from '@devghost/shared';
import { LARGE_SET_THRESHOLD, effortToRadius, applyJitter, ghostFill } from './ghost-chart-utils';

interface GhostBubbleChartProps {
  metrics: GhostMetric[];
  onBubbleClick?: (email: string) => void;
}

/* ---------- types ---------- */

type XAxisMode = 'workDays' | 'effort';

type LabelPos = 'above' | 'below' | 'right' | 'left';

interface ChartPoint {
  name: string; email: string;
  x: number; y: number; z: number; r: number; fill: string;
  realDays: number; realEffort: number; realGhost: number;
  labelHidden?: boolean;
  labelPos?: LabelPos;
}

const CHAR_WIDTH = 5.5; // approx width per char at fontSize 10
const LABEL_HEIGHT = 12;
const LABEL_GAP = 4;

/** Greedy label placement — tries above, below, right, left before hiding.
 *  Priority: larger bubbles keep their labels. */
function markLabelCollisions(
  points: ChartPoint[],
  plotLeft: number, plotWidth: number,
  plotTop: number, plotHeight: number,
  xDomain: [number, number], yDomain: [number, number],
): void {
  if (points.length === 0) return;

  const xScale = (v: number) => plotLeft + ((v - xDomain[0]) / (xDomain[1] - xDomain[0])) * plotWidth;
  const yScale = (v: number) => plotTop + ((yDomain[1] - v) / (yDomain[1] - yDomain[0])) * plotHeight;

  interface LabelBox { x1: number; y1: number; x2: number; y2: number }
  const placed: LabelBox[] = [];

  const collides = (box: LabelBox) =>
    placed.some(p => box.x1 < p.x2 && box.x2 > p.x1 && box.y1 < p.y2 && box.y2 > p.y1);

  // Sort by bubble size DESC (priority)
  const sorted = points.map((p, i) => ({ p, i })).sort((a, b) => b.p.r - a.p.r);

  for (const { p, i } of sorted) {
    const cx = xScale(p.x);
    const cy = yScale(p.y);
    const labelW = p.name.length * CHAR_WIDTH;

    // Candidate positions: above, below, right, left
    const candidates: { pos: LabelPos; box: LabelBox }[] = [
      { pos: 'above', box: { x1: cx - labelW / 2, y1: cy - p.r - LABEL_GAP - LABEL_HEIGHT, x2: cx + labelW / 2, y2: cy - p.r - LABEL_GAP } },
      { pos: 'below', box: { x1: cx - labelW / 2, y1: cy + p.r + LABEL_GAP, x2: cx + labelW / 2, y2: cy + p.r + LABEL_GAP + LABEL_HEIGHT } },
      { pos: 'right', box: { x1: cx + p.r + LABEL_GAP, y1: cy - LABEL_HEIGHT / 2, x2: cx + p.r + LABEL_GAP + labelW, y2: cy + LABEL_HEIGHT / 2 } },
      { pos: 'left',  box: { x1: cx - p.r - LABEL_GAP - labelW, y1: cy - LABEL_HEIGHT / 2, x2: cx - p.r - LABEL_GAP, y2: cy + LABEL_HEIGHT / 2 } },
    ];

    const fit = candidates.find(c => !collides(c.box));
    if (fit) {
      points[i].labelHidden = false;
      points[i].labelPos = fit.pos;
      placed.push(fit.box);
    } else {
      points[i].labelHidden = true;
      points[i].labelPos = 'above';
    }
  }
}

const BASE_MARGIN = { top: 20, right: 20, bottom: 30, left: 20 };

/** CSS to disable Recharts internal SVG clip-path so bubbles/labels can overflow
 *  the plot area into the chart margins. Scoped by a unique wrapper class. */
const OVERFLOW_STYLE = `
.ghost-bubble-no-clip .recharts-surface { overflow: visible; }
.ghost-bubble-no-clip [clip-path] { clip-path: none; }
`;

/* ---------- component ---------- */

export function GhostBubbleChart({ metrics, onBubbleClick }: GhostBubbleChartProps) {
  const [showLabels, setShowLabels] = useState(true);
  const [xAxisMode, setXAxisMode] = useState<XAxisMode>('workDays');
  const [hoveredEmail, setHoveredEmail] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(700);
  const [chartHeight, setChartHeight] = useState(500);

  // Set viewport-based height on mount (avoids SSR hydration mismatch)
  useEffect(() => {
    setChartHeight(Math.max(350, Math.min(900, window.innerHeight - 200)));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setContainerWidth(el.clientWidth || 700);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const heightRef = useRef(chartHeight);
  heightRef.current = chartHeight;
  const dragRef = useRef<{ startY: number; startH: number; pointerId: number; target: HTMLElement } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: heightRef.current, pointerId: e.pointerId, target };
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const newH = Math.max(250, Math.min(900, dragRef.current.startH + ev.clientY - dragRef.current.startY));
      setChartHeight(newH);
    };
    const onUp = () => {
      if (dragRef.current) {
        try { dragRef.current.target.releasePointerCapture(dragRef.current.pointerId); } catch {}
      }
      dragRef.current = null;
      dragCleanupRef.current = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    dragCleanupRef.current = onUp;
  }, []);
  useEffect(() => () => { dragCleanupRef.current?.(); }, []);

  // Memoize data derivation so it doesn't recompute on hover/resize
  const { data, dimmed, allPoints, isLargeSet } = useMemo(() => {
    if (metrics.length === 0) {
      return { data: [] as ChartPoint[], dimmed: [] as ChartPoint[], allPoints: [] as ChartPoint[], isLargeSet: false };
    }

    const large = metrics.length >= LARGE_SET_THRESHOLD;
    const maxEffort = Math.max(...metrics.map(m => m.totalEffortHours), 1);

    const clampY = <T extends { y: number }>(pts: T[]): T[] =>
      pts.map(p => (p.y < 0 ? { ...p, y: 0 } : p));

    const xValue = (m: (typeof metrics)[number]) =>
      xAxisMode === 'effort' ? m.totalEffortHours : m.actualWorkDays;

    const d = clampY(applyJitter(
      metrics
        .filter(m => m.hasEnoughData && m.ghostPercent != null)
        .map(m => ({
          name: m.developerName,
          email: m.developerEmail,
          x: xValue(m),
          y: Math.round(m.ghostPercent!),
          z: m.totalEffortHours,
          r: effortToRadius(m.totalEffortHours, maxEffort, large),
          fill: ghostFill(m.ghostPercent!),
          realDays: m.actualWorkDays,
          realEffort: m.totalEffortHours,
          realGhost: Math.round(m.ghostPercent!),
        })),
      metrics.length,
    ));

    const dim = clampY(applyJitter(
      metrics
        .filter(m => !m.hasEnoughData)
        .map(m => ({
          name: m.developerName,
          email: m.developerEmail,
          x: xValue(m),
          y: Math.round(m.ghostPercent ?? 0),
          z: m.totalEffortHours,
          r: effortToRadius(m.totalEffortHours, maxEffort, large),
          fill: '#d1d5db',
          realDays: m.actualWorkDays,
          realEffort: m.totalEffortHours,
          realGhost: Math.round(m.ghostPercent ?? 0),
        })),
      metrics.length,
    ));

    return { data: d, dimmed: dim, allPoints: [...d, ...dim], isLargeSet: large };
  }, [metrics, xAxisMode]);

  // Store hover state in ref so renderers don't need identity changes
  const hoveredEmailRef = useRef(hoveredEmail);
  hoveredEmailRef.current = hoveredEmail;
  const showLabelsRef = useRef(showLabels);
  showLabelsRef.current = showLabels;
  const containerWidthRef = useRef(containerWidth);
  containerWidthRef.current = containerWidth;
  const chartHeightRef = useRef(chartHeight);
  chartHeightRef.current = chartHeight;
  const onBubbleClickRef = useRef(onBubbleClick);
  onBubbleClickRef.current = onBubbleClick;

  const setHoveredEmailCb = useCallback((email: string | null) => setHoveredEmail(email), []);

  const makeBubbleRenderer = useCallback((opts: {
    baseOpacity: number;
    dimOpacity: number;
    strokeWidth: number;
    labelColor: string;
    clickable: boolean;
  }) => (props: any) => {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null) return <circle r={0} />;
    const hovered = hoveredEmailRef.current;
    const labels = showLabelsRef.current;
    const cWidth = containerWidthRef.current;
    const cHeight = chartHeightRef.current;
    const isHovered = hovered === payload.email;
    const isDimmed = hovered != null && !isHovered;
    const opacity = isDimmed ? opts.dimOpacity : opts.baseOpacity;
    const baseRadius = payload.r;
    const desiredHoverRadius = payload.r * 2;
    // Clamp to SVG viewport (not plot area — clip-path is disabled).
    const maxRadius = Math.max(0, Math.min(cx, cWidth - cx, cy, cHeight - cy) - 1);
    const radius = isHovered
      ? Math.max(baseRadius, Math.min(desiredHoverRadius, maxRadius))
      : baseRadius;
    const labelLeft = cx > cWidth * 0.6;
    return (
      <g>
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill={payload.fill}
          fillOpacity={opacity}
          stroke={payload.fill}
          strokeWidth={opts.strokeWidth}
          style={{ cursor: opts.clickable ? 'pointer' : undefined, transition: 'r 0.15s, fill-opacity 0.15s' }}
          onMouseEnter={() => setHoveredEmailCb(payload.email)}
          onMouseLeave={() => setHoveredEmailCb(null)}
          onClick={opts.clickable ? () => onBubbleClickRef.current?.(payload.email) : undefined}
        />
        {isHovered && (
          <text
            x={labelLeft ? cx - radius - 4 : cx + radius + 4}
            y={cy - 4}
            textAnchor={labelLeft ? 'end' : 'start'}
            fontSize={12}
            fill={opts.labelColor}
            pointerEvents="none"
          >
            {payload.name}
          </text>
        )}
        {labels && !isHovered && !payload.labelHidden && (() => {
          const pos: LabelPos = payload.labelPos ?? 'above';
          const lx = pos === 'above' || pos === 'below' ? cx
            : pos === 'right' ? cx + radius + 4 : cx - radius - 4;
          const ly = pos === 'above' ? cy - radius - 4
            : pos === 'below' ? cy + radius + LABEL_HEIGHT
            : cy + LABEL_HEIGHT / 2 - 2;
          const anchor = pos === 'right' ? 'start' : pos === 'left' ? 'end' : 'middle';
          return (
            <text
              x={lx} y={ly}
              textAnchor={anchor}
              fontSize={10}
              fill={opts.labelColor}
              fillOpacity={isDimmed ? 0.3 : 0.8}
              pointerEvents="none"
            >
              {payload.name}
            </text>
          );
        })()}
      </g>
    );
  }, [setHoveredEmailCb]);

  const renderBubble = useMemo(() => makeBubbleRenderer({
    baseOpacity: isLargeSet ? 0.5 : 0.7,
    dimOpacity: 0.15,
    strokeWidth: 1.5,
    labelColor: '#333',
    clickable: true,
  }), [makeBubbleRenderer, isLargeSet]);

  const renderDimmedBubble = useMemo(() => makeBubbleRenderer({
    baseOpacity: 0.25,
    dimOpacity: 0.08,
    strokeWidth: 1,
    labelColor: '#999',
    clickable: false,
  }), [makeBubbleRenderer]);

  if (metrics.length === 0) {
    return (
      <div className="flex items-center justify-center h-[400px] text-muted-foreground">
        No developer metrics available
      </div>
    );
  }

  const maxBubbleRadius = allPoints.length > 0
    ? Math.max(...allPoints.map((point) => point.r))
    : 8;

  // Dynamic margins: ensure the SVG viewport has enough room for bubbles
  // and labels that overflow the plot area (clip-path is disabled via CSS).
  const labelExtra = showLabels ? 14 : 0; // 10px font + 4px gap
  const chartMargin = {
    top:    Math.max(BASE_MARGIN.top,    maxBubbleRadius + labelExtra),
    right:  Math.max(BASE_MARGIN.right,  maxBubbleRadius + 5),
    bottom: Math.max(BASE_MARGIN.bottom, maxBubbleRadius + 5),
    left:   Math.max(BASE_MARGIN.left, maxBubbleRadius + 5),
  };

  // Axis domains: no artificial padding — clip-path override lets bubbles overflow.
  const maxX = allPoints.length > 0
    ? Math.max(...allPoints.map((point) => point.x))
    : 1;
  const maxGhost = allPoints.length > 0
    ? Math.max(...allPoints.map((point) => point.y))
    : 100;
  const yDomainMax = Math.max(120, Math.ceil(maxGhost / 50) * 50);

  // Run label collision detection (approximate pixel positions from chart geometry)
  if (showLabels) {
    const plotLeft = chartMargin.left;
    const plotWidth = Math.max(1, containerWidth - chartMargin.left - chartMargin.right);
    const plotTop = chartMargin.top;
    const plotHeight = Math.max(1, chartHeight - chartMargin.top - chartMargin.bottom);
    markLabelCollisions(allPoints, plotLeft, plotWidth, plotTop, plotHeight, [0, Math.ceil(maxX)], [0, yDomainMax]);
  }

  return (
    <div ref={containerRef} className="ghost-bubble-no-clip">
      <style>{OVERFLOW_STYLE}</style>
      <div className="flex items-center gap-4 mb-1">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground select-none cursor-pointer w-fit">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={e => setShowLabels(e.target.checked)}
            className="accent-primary"
          />
          Names
        </label>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>X:</span>
          <button
            onClick={() => setXAxisMode('workDays')}
            className={`px-1.5 py-0.5 rounded ${xAxisMode === 'workDays' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          >
            Work Days
          </button>
          <button
            onClick={() => setXAxisMode('effort')}
            className={`px-1.5 py-0.5 rounded ${xAxisMode === 'effort' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          >
            Effort
          </button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={chartHeight} style={{ overflow: 'visible' }}>
        <ScatterChart margin={chartMargin}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="x"
            name={xAxisMode === 'effort' ? 'Total Effort' : 'Work Days'}
            type="number"
            domain={[0, Math.ceil(maxX)]}
            allowDecimals={xAxisMode === 'effort'}
            tickFormatter={(value: number) =>
              xAxisMode === 'effort' ? `${Math.round(value)}h` : `${Math.round(value)}`
            }
            label={{
              value: xAxisMode === 'effort' ? 'Total Effort (h)' : 'Work Days',
              position: 'insideBottom',
              offset: -6,
            }}
          />
          <YAxis
            dataKey="y"
            name="Ghost %"
            type="number"
            domain={[0, yDomainMax]}
            allowDecimals={false}
            tickFormatter={(value: number) => `${Math.round(value)}`}
            label={{ value: 'Ghost %', angle: -90, position: 'insideLeft' }}
          />
          <ReferenceLine y={100} stroke="#666" strokeDasharray="5 5" label="Ghost Norm" />
          <ReferenceLine y={80} stroke="#eab308" strokeDasharray="3 3" strokeOpacity={0.5} />
          <Tooltip
            allowEscapeViewBox={{ x: true, y: true }}
            content={({ payload, coordinate }) => {
              if (!payload?.length || !coordinate) return null;
              const d = payload[0]!.payload as ChartPoint;
              const tipWidth = 180;
              const cx = coordinate.x ?? 0;
              const rechartsOffset = 10;
              const wouldOverflow = cx + rechartsOffset + tipWidth > containerWidth;
              // Flip tooltip to the left side of cursor when it would overflow right edge
              const offsetX = wouldOverflow ? -(tipWidth + 2 * rechartsOffset) : 0;
              return (
                <div
                  className="bg-white p-3 border rounded shadow text-sm"
                  style={offsetX ? { transform: `translateX(${offsetX}px)` } : undefined}
                >
                  <p className="font-bold">{d.name}</p>
                  <p>Ghost: {d.realGhost}%</p>
                  <p>Work Days: {d.realDays}</p>
                  <p>Effort: {d.realEffort.toFixed(1)}h</p>
                </div>
              );
            }}
          />
          {dimmed.length > 0 && (
            <Scatter data={dimmed} shape={renderDimmedBubble} />
          )}
          <Scatter
            data={data}
            shape={renderBubble}
          />
        </ScatterChart>
      </ResponsiveContainer>
      {/* resize handle */}
      <div
        onPointerDown={onResizeStart}
        className="mx-auto mt-0.5 w-16 h-2 rounded-full bg-muted hover:bg-muted-foreground/30 cursor-ns-resize transition-colors"
        title="Drag to resize"
      />
    </div>
  );
}
