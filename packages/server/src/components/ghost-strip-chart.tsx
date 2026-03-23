'use client';

import { useRef, useState } from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, ReferenceLine,
         Tooltip, ResponsiveContainer } from 'recharts';
import type { GhostMetric } from '@devghost/shared';
import { beeswarmLayout, ghostFill } from './ghost-chart-utils';

/* ---------- types ---------- */

interface GhostStripChartProps {
  metrics: GhostMetric[];
  onDeveloperClick?: (email: string) => void;
}

interface StripPoint {
  name: string;
  email: string;
  x: number;
  y: number;
  ghostPercent: number;
  workDays: number;
  effort: number;
  fill: string;
}

/* ---------- constants ---------- */

const DOT_RADIUS = 4;

/* ---------- component ---------- */

export function GhostStripChart({ metrics, onDeveloperClick }: GhostStripChartProps) {
  const [hoveredEmail, setHoveredEmail] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter to valid metrics, exclude developers with insufficient data
  const valid = metrics
    .filter(m => m.hasEnoughData && m.ghostPercent != null)
    .sort((a, b) => a.ghostPercent! - b.ghostPercent!);

  if (valid.length === 0) {
    return (
      <div className="flex items-center justify-center h-[300px] text-muted-foreground">
        No developer metrics available
      </div>
    );
  }

  const layout = beeswarmLayout(valid.map(m => ({ ghostPercent: m.ghostPercent! })));

  const data: StripPoint[] = valid.map((m, i) => ({
    name: m.developerName,
    email: m.developerEmail,
    x: layout[i].x,
    y: layout[i].y,
    ghostPercent: Math.round(m.ghostPercent!),
    workDays: m.actualWorkDays,
    effort: m.totalEffortHours,
    fill: ghostFill(m.ghostPercent!),
  }));

  const renderDot = (props: any) => {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null) return <circle r={0} />;
    const isHovered = hoveredEmail === payload.email;
    const isDimmed = hoveredEmail != null && !isHovered;
    const radius = isHovered ? DOT_RADIUS * 2 : DOT_RADIUS;
    const opacity = isDimmed ? 0.15 : 0.7;
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
          strokeWidth={1.5}
          style={{ cursor: 'pointer', transition: 'r 0.15s, fill-opacity 0.15s' }}
          onMouseEnter={() => setHoveredEmail(payload.email)}
          onMouseLeave={() => setHoveredEmail(null)}
          onClick={() => onDeveloperClick?.(payload.email)}
        />
        {isHovered && (
          <text
            x={labelLeft ? cx - radius - 4 : cx + radius + 4}
            y={cy - 4}
            textAnchor={labelLeft ? 'end' : 'start'}
            fontSize={12}
            fill="#333"
            pointerEvents="none"
          >
            {payload.name}
          </text>
        )}
      </g>
    );
  };

  return (
    <div ref={containerRef}>
      <ResponsiveContainer width="100%" height={300}>
        <ScatterChart margin={{ top: 20, right: 30, bottom: 20, left: 20 }}>
          <XAxis
            dataKey="x"
            name="Ghost %"
            type="number"
            unit="%"
            domain={[0, 'auto']}
          />
          <YAxis
            dataKey="y"
            type="number"
            hide={true}
          />
          <ReferenceLine
            x={100}
            stroke="#666"
            strokeDasharray="5 5"
            label="Ghost Norm"
          />
          <ReferenceLine
            x={80}
            stroke="#eab308"
            strokeDasharray="3 3"
            strokeOpacity={0.5}
          />
          <Tooltip
            content={({ payload }) => {
              if (!payload?.length) return null;
              const d = payload[0]!.payload as StripPoint;
              return (
                <div className="bg-white p-3 border rounded shadow text-sm">
                  <p className="font-bold">{d.name}</p>
                  <p>Ghost: {d.ghostPercent}%</p>
                  <p>Work Days: {d.workDays}</p>
                  <p>Effort: {d.effort.toFixed(1)}h</p>
                </div>
              );
            }}
          />
          <Scatter data={data} shape={renderDot} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
