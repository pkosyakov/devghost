'use client';

import { useRef, useState } from 'react';
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

/* ---------- component ---------- */

export function GhostBubbleChart({ metrics, onBubbleClick }: GhostBubbleChartProps) {
  const [hoveredEmail, setHoveredEmail] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Recharts domains are based on point centers, so large bubbles near edges
  // can get clipped. Add a heuristic axis padding that also covers hover growth.
  const minDays = allPoints.length > 0
    ? Math.min(...allPoints.map((point) => point.x))
    : 0;
  const maxDays = allPoints.length > 0
    ? Math.max(...allPoints.map((point) => point.x))
    : 1;
  const xPadding = Math.max(0.5, maxBubbleRadius / 90);
  const xDomainMin = Math.max(0, minDays - xPadding);
  const xDomainMax = Math.max(xDomainMin + 1, maxDays + xPadding);

  const maxGhost = allPoints.length > 0
    ? Math.max(...allPoints.map((point) => point.y))
    : 100;
  const yPadding = Math.max(80, Math.ceil(maxBubbleRadius * 2.2));
  const yDomainMax = Math.max(120, maxGhost + yPadding);

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
    const radius = isHovered ? payload.r * 2 : payload.r;
    const opacity = isDimmed ? opts.dimOpacity : opts.baseOpacity;
    const chartWidth = containerRef.current?.clientWidth ?? 800;
    const labelLeft = cx > chartWidth * 0.6;
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
      <ResponsiveContainer width="100%" height={400} style={{ overflow: 'visible' }}>
        <ScatterChart margin={{ top: 45, right: 45, bottom: 20, left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="x"
            name="Work Days"
            type="number"
            domain={[xDomainMin, xDomainMax]}
            allowDataOverflow
          />
          <YAxis
            dataKey="y"
            name="Ghost %"
            type="number"
            domain={[0, yDomainMax]}
            allowDataOverflow
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
    </div>
  );
}
