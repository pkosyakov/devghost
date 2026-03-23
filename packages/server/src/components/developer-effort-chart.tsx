'use client';

import { useMemo, useCallback, useState, useRef } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { GHOST_NORM, MAX_DAILY_EFFORT } from '@devghost/shared';

/* ── Types ─────────────────────────────────────────────────── */

interface SpreadEntry {
  date: string;
  effort: number;
  commits: string[];
}

interface SourceEntry {
  date: string;
  estimated: number;
  placed: number;
  overhead: number;
  commits: string[];
}

interface CommitSegment {
  hash: string;
  effort: number;
}

interface ChartDataPoint {
  date: string;
  dateLabel: string;
  placed: number;
  overhead: number;
  commitCount: number;
  commitHashes: string[];
  commitSegments: CommitSegment[];
  isWeekend: boolean;
}

export interface DeveloperEffortChartProps {
  spread: SpreadEntry[];
  sources: SourceEntry[];
  commitDistribution?: Record<string, { date: string; effort: number }[]>;
  onBarClick?: (date: string) => void;
  onCommitClick?: (commitHash: string) => void;
}

/* ── Commit color palette ──────────────────────────────────── */

const COMMIT_COLORS = [
  '#f97316', '#06b6d4', '#8b5cf6', '#ec4899', '#14b8a6',
  '#6366f1', '#10b981', '#e11d48', '#0ea5e9', '#84cc16',
  '#a855f7', '#0891b2', '#db2777', '#65a30d', '#d946ef',
];

export function commitColor(hash: string): string {
  let h = 0;
  for (let i = 0; i < hash.length; i++) {
    h = ((h << 5) - h + hash.charCodeAt(i)) | 0;
  }
  return COMMIT_COLORS[Math.abs(h) % COMMIT_COLORS.length];
}

/* ── Date helpers ──────────────────────────────────────────── */

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${dateStr.slice(5)}`;
}

function isWeekendDate(dateStr: string): boolean {
  const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return dow === 0 || dow === 6;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function workDaysBetween(a: string, b: string): number {
  let count = 0;
  let cur = addDays(a, 1);
  while (cur < b) {
    if (!isWeekendDate(cur)) count++;
    cur = addDays(cur, 1);
  }
  return count;
}

/* ── Data transformation ───────────────────────────────────── */

function buildChartData(
  spread: SpreadEntry[],
  sources: SourceEntry[],
  commitDistribution?: Record<string, { date: string; effort: number }[]>,
): ChartDataPoint[] {
  const spreadMap = new Map(spread.map(d => [d.date, d]));
  const sourceMap = new Map(sources.map(s => [s.date, s]));

  const allDates = Array.from(new Set([
    ...spread.map(d => d.date),
    ...sources.map(s => s.date),
  ])).sort();

  if (allDates.length === 0) return [];

  // Fill gaps up to 3 working days
  const filledDates = new Set(allDates);
  for (let i = 0; i < allDates.length - 1; i++) {
    if (workDaysBetween(allDates[i], allDates[i + 1]) <= 3) {
      let d = addDays(allDates[i], 1);
      while (d < allDates[i + 1]) { filledDates.add(d); d = addDays(d, 1); }
    }
  }

  // Reverse map: date → commit segments
  const dayCommitMap = new Map<string, CommitSegment[]>();
  if (commitDistribution) {
    for (const [hash, entries] of Object.entries(commitDistribution)) {
      for (const e of entries) {
        const arr = dayCommitMap.get(e.date) ?? [];
        arr.push({ hash, effort: e.effort });
        dayCommitMap.set(e.date, arr);
      }
    }
  }

  return Array.from(filledDates).sort().map(date => {
    const sp = spreadMap.get(date);
    const src = sourceMap.get(date);
    return {
      date,
      dateLabel: formatDateLabel(date),
      placed: sp?.effort ?? 0,
      overhead: src?.overhead ?? 0,
      commitCount: sp?.commits?.length ?? 0,
      commitHashes: sp?.commits ?? [],
      commitSegments: dayCommitMap.get(date) ?? [],
      isWeekend: isWeekendDate(date),
    };
  });
}

/* ── Custom segmented bar ──────────────────────────────────── */

interface SegmentedBarProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: ChartDataPoint;
  hoveredCommit: string | null;
  onCommitHover: (hash: string | null) => void;
  onCommitClick?: (hash: string) => void;
}

function SegmentedBar({
  x = 0, y = 0, width = 0, height = 0,
  payload,
  hoveredCommit,
  onCommitHover,
  onCommitClick,
}: SegmentedBarProps) {
  if (height <= 0 || !payload) return null;

  const { commitSegments, isWeekend } = payload;
  const baseColor = isWeekend ? '#f59e0b' : '#3b82f6';

  // No segment data — solid bar
  if (!commitSegments.length) {
    return (
      <rect
        x={x} y={y} width={width} height={height}
        fill={baseColor}
        opacity={hoveredCommit ? 0.15 : 1}
        rx={1}
      />
    );
  }

  const totalEffort = commitSegments.reduce((s, c) => s + c.effort, 0);
  if (totalEffort <= 0) return null;

  let currentY = y + height; // build from bottom up

  return (
    <g onMouseLeave={() => onCommitHover(null)}>
      {commitSegments.map((seg) => {
        const segHeight = (seg.effort / totalEffort) * height;
        currentY -= segHeight;

        const isHighlighted = hoveredCommit === seg.hash;
        const isDimmed = hoveredCommit !== null && !isHighlighted;

        const fill = isHighlighted ? commitColor(seg.hash) : baseColor;
        const opacity = isDimmed ? 0.15 : 1;
        const showBorder = hoveredCommit !== null;

        return (
          <rect
            key={seg.hash}
            x={x}
            y={currentY}
            width={width}
            height={Math.max(segHeight, 0.5)}
            fill={fill}
            opacity={opacity}
            stroke={showBorder ? '#374151' : 'transparent'}
            strokeWidth={showBorder ? 1 : 0}
            rx={1}
            onMouseEnter={() => onCommitHover(seg.hash)}
            onClick={() => onCommitClick?.(seg.hash)}
            style={{ cursor: 'pointer', transition: 'opacity 0.15s ease, fill 0.15s ease' }}
          />
        );
      })}
    </g>
  );
}

/* ── Custom tooltip ────────────────────────────────────────── */

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; payload: ChartDataPoint }>;
  hoveredCommit: string | null;
}

function ChartTooltip({ active, payload, hoveredCommit }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const total = point.placed + point.overhead;

  const hoveredSeg = hoveredCommit
    ? point.commitSegments.find(s => s.hash === hoveredCommit)
    : null;

  return (
    <div className="bg-background border rounded-lg shadow-lg p-3 text-sm space-y-1">
      <p className="font-medium">{point.dateLabel}{point.isWeekend ? ' (weekend)' : ''}</p>
      {point.placed > 0 && <p className="text-blue-600">Placed: {point.placed.toFixed(1)}h</p>}
      {point.overhead > 0 && <p className="text-red-500">Overhead: +{point.overhead.toFixed(1)}h</p>}
      {total > 0 && <p className="font-medium">Total: {total.toFixed(1)}h</p>}
      {point.commitCount > 0 && <p className="text-purple-600">Commits: {point.commitCount}</p>}

      {hoveredSeg && hoveredCommit && (
        <div className="border-t pt-1 mt-1">
          <p className="font-mono text-xs font-medium" style={{ color: commitColor(hoveredCommit) }}>
            {hoveredCommit.slice(0, 7)}: {hoveredSeg.effort.toFixed(2)}h on this day
          </p>
        </div>
      )}

      {!hoveredCommit && point.commitHashes.length > 0 && (
        <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
          {point.commitHashes.slice(0, 3).map(h => (
            <p key={h} className="font-mono">{h.slice(0, 7)}</p>
          ))}
          {point.commitHashes.length > 3 && <p>+{point.commitHashes.length - 3} more</p>}
        </div>
      )}
    </div>
  );
}

/* ── Main component ────────────────────────────────────────── */

export function DeveloperEffortChart({
  spread, sources, commitDistribution, onBarClick, onCommitClick,
}: DeveloperEffortChartProps) {
  const [hoveredCommit, setHoveredCommit] = useState<string | null>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const data = useMemo(
    () => buildChartData(spread, sources, commitDistribution),
    [spread, sources, commitDistribution],
  );

  const maxY = useMemo(() => {
    const maxEffort = Math.max(...data.map(d => d.placed + d.overhead), 0);
    return Math.max(maxEffort, MAX_DAILY_EFFORT) + 1;
  }, [data]);

  const maxCommits = useMemo(
    () => Math.max(...data.map(d => d.commitCount), 1),
    [data],
  );

  // Year boundary markers — vertical lines where year changes
  const yearBoundaries = useMemo(() => {
    const boundaries: { dateLabel: string; year: string }[] = [];
    for (let i = 1; i < data.length; i++) {
      const prevYear = data[i - 1].date.slice(0, 4);
      const currYear = data[i].date.slice(0, 4);
      if (prevYear !== currYear) {
        boundaries.push({ dateLabel: data[i].dateLabel, year: currYear });
      }
    }
    return boundaries;
  }, [data]);

  // Debounced hover: prevents flicker when moving between bars
  const handleCommitHover = useCallback((hash: string | null) => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    if (hash) {
      setHoveredCommit(hash);
    } else {
      hoverTimeoutRef.current = setTimeout(() => setHoveredCommit(null), 80);
    }
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleBarClick = useCallback((barData: any) => {
    const date: string | undefined = barData?.date ?? barData?.payload?.date;
    if (date && onBarClick) onBarClick(date);
  }, [onBarClick]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No daily effort data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={400}>
      <ComposedChart data={data} margin={{ top: 20, right: 30, left: 10, bottom: 60 }}>
        <CartesianGrid strokeDasharray="3 3" opacity={0.3} />

        <XAxis
          dataKey="dateLabel"
          tick={{ fontSize: 11 }}
          angle={-45}
          textAnchor="end"
          height={70}
          interval={data.length > 30 ? Math.floor(data.length / 20) : 0}
        />
        <YAxis
          yAxisId="hours"
          domain={[0, Math.ceil(maxY)]}
          tick={{ fontSize: 12 }}
          label={{ value: 'Hours', angle: -90, position: 'insideLeft', offset: 0 }}
        />
        <YAxis
          yAxisId="commits"
          orientation="right"
          domain={[0, Math.ceil(maxCommits * 1.2)]}
          tick={{ fontSize: 12 }}
          label={{ value: 'Commits', angle: 90, position: 'insideRight', offset: 0 }}
          allowDecimals={false}
        />

        <Tooltip
          content={
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (props: any) => <ChartTooltip {...props} hoveredCommit={hoveredCommit} />
          }
        />

        <ReferenceLine
          yAxisId="hours"
          y={MAX_DAILY_EFFORT}
          stroke="#ef4444"
          strokeDasharray="6 3"
          label={{ value: `Max ${MAX_DAILY_EFFORT}h`, position: 'right', fill: '#ef4444', fontSize: 11 }}
        />
        <ReferenceLine
          yAxisId="hours"
          y={GHOST_NORM}
          stroke="#22c55e"
          strokeDasharray="6 3"
          label={{ value: `Norm ${GHOST_NORM}h`, position: 'right', fill: '#22c55e', fontSize: 11 }}
        />

        {yearBoundaries.map(b => (
          <ReferenceLine
            key={b.year}
            yAxisId="hours"
            x={b.dateLabel}
            stroke="#9ca3af"
            strokeDasharray="4 4"
            label={{ value: b.year, position: 'top', fontSize: 11, fill: '#6b7280' }}
          />
        ))}

        <Bar
          yAxisId="hours"
          dataKey="placed"
          stackId="effort"
          name="Placed"
          // Custom shape renders commit segments with hover interaction
          shape={
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (props: any) => (
              <SegmentedBar
                {...props}
                hoveredCommit={hoveredCommit}
                onCommitHover={handleCommitHover}
                onCommitClick={onCommitClick}
              />
            )
          }
          onClick={handleBarClick}
          cursor="pointer"
        />

        <Bar
          yAxisId="hours"
          dataKey="overhead"
          stackId="effort"
          name="Overhead"
          fill="#ef4444"
          opacity={hoveredCommit ? 0.3 : 0.6}
          onClick={handleBarClick}
          cursor="pointer"
        />

        <Line
          yAxisId="commits"
          type="monotone"
          dataKey="commitCount"
          stroke="#8b5cf6"
          strokeWidth={2}
          dot={{ r: 3, fill: '#8b5cf6' }}
          name="Commits"
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
