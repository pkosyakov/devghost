'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
         Tooltip, ReferenceLine, ResponsiveContainer } from 'recharts';
import type { GhostMetric } from '@devghost/shared';
import { LARGE_SET_THRESHOLD, effortToRadius, applyJitter, ghostFill } from './ghost-chart-utils';

interface GhostBubbleChartProps {
  metrics: GhostMetric[];
  onBubbleClick?: (email: string) => void;
}

/* ---------- types ---------- */

interface ChartPoint {
  name: string; email: string;
  x: number; y: number; z: number; r: number; fill: string;
  realDays: number; realGhost: number;
}

const CHART_MARGIN = { top: 45, right: 45, bottom: 20, left: 20 };

/* ---------- component ---------- */

export function GhostBubbleChart({ metrics, onBubbleClick }: GhostBubbleChartProps) {
  const [showLabels, setShowLabels] = useState(false);
  const [hoveredEmail, setHoveredEmail] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(700);
  const [chartHeight, setChartHeight] = useState(400);

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

  if (metrics.length === 0) {
    return (
      <div className="flex items-center justify-center h-[400px] text-muted-foreground">
        No developer metrics available
      </div>
    );
  }

  const isLargeSet = metrics.length >= LARGE_SET_THRESHOLD;
  const maxEffort = Math.max(...metrics.map(m => m.totalEffortHours), 1);

  const data = applyJitter(
    metrics
      .filter(m => m.hasEnoughData && m.ghostPercent != null)
      .map(m => ({
        name: m.developerName,
        email: m.developerEmail,
        x: m.actualWorkDays,
        y: Math.round(m.ghostPercent!),
        z: m.totalEffortHours,
        r: effortToRadius(m.totalEffortHours, maxEffort, isLargeSet),
        fill: ghostFill(m.ghostPercent!),
        realDays: m.actualWorkDays,
        realGhost: Math.round(m.ghostPercent!),
      })),
    metrics.length,
  );

  const dimmed = applyJitter(
    metrics
      .filter(m => !m.hasEnoughData)
      .map(m => ({
        name: m.developerName,
        email: m.developerEmail,
        x: m.actualWorkDays,
        y: Math.round(m.ghostPercent ?? 0),
        z: m.totalEffortHours,
        r: effortToRadius(m.totalEffortHours, maxEffort, isLargeSet),
        fill: '#d1d5db',
        realDays: m.actualWorkDays,
        realGhost: Math.round(m.ghostPercent ?? 0),
      })),
    metrics.length,
  );

  const allPoints = [...data, ...dimmed];
  const maxBubbleRadius = allPoints.length > 0
    ? Math.max(...allPoints.map((point) => point.r))
    : 8;

  // Convert max bubble radius (px) to axis-unit padding so the full circle
  // (center +/- radius) stays within the rendered plot area.
  // Formula: pad_units = R_px * data_range / (plot_px - 2*R_px)
  const plotWidth = containerWidth - CHART_MARGIN.left - CHART_MARGIN.right;
  const plotHeight = chartHeight - CHART_MARGIN.top - CHART_MARGIN.bottom;

  const minDays = allPoints.length > 0
    ? Math.min(...allPoints.map((point) => point.x))
    : 0;
  const maxDays = allPoints.length > 0
    ? Math.max(...allPoints.map((point) => point.x))
    : 1;
  const dataXRange = (maxDays - minDays) || 1;
  const xPadding = maxBubbleRadius * dataXRange / Math.max(plotWidth - 2 * maxBubbleRadius, 100);
  const xDomainMin = Math.max(0, Math.floor(minDays - xPadding));
  const xDomainMax = Math.max(xDomainMin + 1, Math.ceil(maxDays + xPadding));

  const maxGhost = allPoints.length > 0
    ? Math.max(...allPoints.map((point) => point.y))
    : 100;
  const dataYRange = maxGhost || 100;
  const yPadding = maxBubbleRadius * dataYRange / Math.max(plotHeight - 2 * maxBubbleRadius, 100);
  const yDomainMax = Math.max(120, Math.ceil((maxGhost + yPadding) / 50) * 50);

  const makeBubbleRenderer = (opts: {
    baseOpacity: number;
    dimOpacity: number;
    strokeWidth: number;
    labelColor: string;
    clickable: boolean;
  }) => (props: any) => {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null) return <circle r={0} />;
    const isHovered = hoveredEmail === payload.email;
    const isDimmed = hoveredEmail != null && !isHovered;
    const opacity = isDimmed ? opts.dimOpacity : opts.baseOpacity;
    const pW = containerWidth - CHART_MARGIN.left - CHART_MARGIN.right;
    const pH = chartHeight - CHART_MARGIN.top - CHART_MARGIN.bottom;
    const baseRadius = payload.r;
    const desiredHoverRadius = payload.r * 2;
    const maxRadiusInsidePlot = Math.min(
      cx - CHART_MARGIN.left,
      CHART_MARGIN.left + pW - cx,
      cy - CHART_MARGIN.top,
      CHART_MARGIN.top + pH - cy,
    ) - 1;
    const radius = isHovered
      ? Math.max(baseRadius, Math.min(desiredHoverRadius, maxRadiusInsidePlot))
      : baseRadius;
    const labelLeft = cx > containerWidth * 0.6;
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
          onMouseEnter={() => setHoveredEmail(payload.email)}
          onMouseLeave={() => setHoveredEmail(null)}
          onClick={opts.clickable ? () => onBubbleClick?.(payload.email) : undefined}
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
        {showLabels && !isHovered && (
          <text
            x={cx}
            y={cy - radius - 4}
            textAnchor="middle"
            fontSize={10}
            fill={opts.labelColor}
            fillOpacity={isDimmed ? 0.3 : 0.8}
            pointerEvents="none"
          >
            {payload.name}
          </text>
        )}
      </g>
    );
  };

  const renderBubble = makeBubbleRenderer({
    baseOpacity: isLargeSet ? 0.5 : 0.7,
    dimOpacity: 0.15,
    strokeWidth: 1.5,
    labelColor: '#333',
    clickable: true,
  });

  const renderDimmedBubble = makeBubbleRenderer({
    baseOpacity: 0.25,
    dimOpacity: 0.08,
    strokeWidth: 1,
    labelColor: '#999',
    clickable: false,
  });

  return (
    <div ref={containerRef}>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1 select-none cursor-pointer w-fit">
        <input
          type="checkbox"
          checked={showLabels}
          onChange={e => setShowLabels(e.target.checked)}
          className="accent-primary"
        />
        Names
      </label>
      <ResponsiveContainer width="100%" height={chartHeight} style={{ overflow: 'visible' }}>
        <ScatterChart margin={CHART_MARGIN}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="x"
            name="Work Days"
            type="number"
            domain={[xDomainMin, xDomainMax]}
            allowDataOverflow
            allowDecimals={false}
            tickFormatter={(value: number) => `${Math.round(value)}`}
            label={{ value: 'Work Days', position: 'insideBottom', offset: -6 }}
          />
          <YAxis
            dataKey="y"
            name="Ghost %"
            type="number"
            domain={[0, yDomainMax]}
            allowDataOverflow
            allowDecimals={false}
            tickFormatter={(value: number) => `${Math.round(value)}`}
            label={{ value: 'Ghost %', angle: -90, position: 'insideLeft' }}
          />
          <ReferenceLine y={100} stroke="#666" strokeDasharray="5 5" label="Ghost Norm" />
          <ReferenceLine y={80} stroke="#eab308" strokeDasharray="3 3" strokeOpacity={0.5} />
          <Tooltip
            allowEscapeViewBox={{ x: true, y: true }}
            content={({ payload }) => {
              if (!payload?.length) return null;
              const d = payload[0]!.payload as ChartPoint;
              return (
                <div className="bg-white p-3 border rounded shadow text-sm">
                  <p className="font-bold">{d.name}</p>
                  <p>Ghost: {d.realGhost}%</p>
                  <p>Work Days: {d.realDays}</p>
                  <p>Effort: {d.z.toFixed(1)}h</p>
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
