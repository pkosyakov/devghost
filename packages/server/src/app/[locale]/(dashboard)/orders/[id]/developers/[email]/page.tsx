'use client';

import { use, useMemo, useRef, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@/i18n/navigation';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, Legend,
} from 'recharts';
import { GHOST_NORM, formatGhostPercent, ghostColor } from '@devghost/shared';
import type { GhostMetric } from '@devghost/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DateRangePicker } from '@/components/ui/date-picker';
import { DeveloperKpiCards } from '@/components/developer-kpi-cards';
import { DeveloperEffortChart } from '@/components/developer-effort-chart';
import { CommitAnalysisTable } from '@/components/commit-analysis-table';
import { aggregateEffort, type EffortRow, type Period, type AggregatedBucket } from '@/components/effort-timeline-utils';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

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

interface DailyEffortData {
  spread: SpreadEntry[];
  sources: SourceEntry[];
  commitDistribution?: Record<string, { date: string; effort: number }[]>;
}

const ghostBadgeStyles: Record<string, string> = {
  green: 'bg-green-100 text-green-700',
  yellow: 'bg-yellow-100 text-yellow-700',
  red: 'bg-red-100 text-red-700',
  gray: 'bg-gray-100 text-gray-500',
};

const PERIODS: { value: Period; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
  { value: 'all_time', label: 'All Time' },
];

function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = WEEKDAY_SHORT[d.getUTCDay()];
  return `${day} ${dateStr.slice(5)}`;
}

/* ---------- Aggregated chart for non-day periods ---------- */

function AggregatedChart({ buckets }: { buckets: AggregatedBucket[] }) {
  // Year boundaries for week/month/quarter labels (format: "YYYY-...")
  const yearBoundaries = useMemo(() => {
    const boundaries: { label: string; year: string }[] = [];
    for (let i = 1; i < buckets.length; i++) {
      const prevYear = buckets[i - 1].label.slice(0, 4);
      const currYear = buckets[i].label.slice(0, 4);
      if (prevYear !== currYear && currYear !== 'All ') {
        boundaries.push({ label: buckets[i].label, year: currYear });
      }
    }
    return boundaries;
  }, [buckets]);

  if (buckets.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        No data for selected period
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={400}>
      <BarChart data={buckets} margin={{ top: 10, right: 30, bottom: 20, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis
          dataKey="label"
          fontSize={12}
          angle={buckets.length > 15 ? -45 : 0}
          textAnchor={buckets.length > 15 ? 'end' : 'middle'}
          height={buckets.length > 15 ? 60 : 30}
        />
        <YAxis domain={[0, 'auto']} />
        <ReferenceLine
          y={GHOST_NORM}
          stroke="#22c55e"
          strokeDasharray="5 5"
          label={{ value: `Ghost Norm (${GHOST_NORM}h)`, position: 'right', fontSize: 11 }}
        />
        {yearBoundaries.map(b => (
          <ReferenceLine
            key={b.year}
            x={b.label}
            stroke="#9ca3af"
            strokeDasharray="4 4"
            label={{ value: b.year, position: 'top', fontSize: 11, fill: '#6b7280' }}
          />
        ))}
        <Tooltip
          content={({ payload }) => {
            if (!payload?.length) return null;
            const d = payload[0]!.payload as AggregatedBucket;
            return (
              <div className="bg-background border rounded-lg shadow-lg p-3 text-sm space-y-1">
                <p className="font-bold">{d.label}</p>
                <p>
                  <span className="inline-block w-3 h-3 rounded-sm mr-1 align-middle" style={{ backgroundColor: '#6366f1' }} />
                  Placed: {d.placedHours.toFixed(1)}h
                </p>
                <p>
                  <span className="inline-block w-3 h-3 rounded-sm mr-1 align-middle" style={{ backgroundColor: '#f97316' }} />
                  Overhead: {d.overheadHours.toFixed(1)}h
                </p>
                <p className="font-semibold">Total: {d.totalHours.toFixed(1)}h</p>
                <p className="text-muted-foreground">Avg: {d.avgByActive.toFixed(1)}h/day</p>
              </div>
            );
          }}
        />
        <Legend />
        <Bar dataKey="placedHours" stackId="effort" fill="#6366f1" name="Placed" />
        <Bar dataKey="overheadHours" stackId="effort" fill="#f97316" name="Overhead" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function DeveloperDetailPage({
  params,
}: {
  params: Promise<{ id: string; email: string }>;
}) {
  const { id, email: rawEmail } = use(params);
  const email = decodeURIComponent(rawEmail);
  const router = useRouter();
  const commitSectionRef = useRef<HTMLDivElement>(null);
  const [highlightedCommit, setHighlightedCommit] = useState<string | null>(null);

  // Fetch metrics (ALL_TIME) and filter to this developer
  const { data: metrics, isLoading: metricsLoading } = useQuery<GhostMetric[]>({
    queryKey: ['metrics', id, 'ALL_TIME'],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${id}/metrics?period=ALL_TIME`);
      if (!res.ok) return [];
      const json = await res.json();
      return json.data ?? [];
    },
  });

  const metric = useMemo(
    () => metrics?.find((m) => m.developerEmail === email) ?? null,
    [metrics, email],
  );

  // Prev/next developer navigation (sorted by ghostPercent desc, same as table)
  const { prev, next } = useMemo(() => {
    if (!metrics?.length) return { prev: null, next: null };
    const sorted = [...metrics].sort((a, b) => (b.ghostPercent ?? 0) - (a.ghostPercent ?? 0));
    const idx = sorted.findIndex((m) => m.developerEmail === email);
    if (idx === -1) return { prev: null, next: null };
    return {
      prev: idx > 0 ? sorted[idx - 1] : null,
      next: idx < sorted.length - 1 ? sorted[idx + 1] : null,
    };
  }, [metrics, email]);

  // Fetch daily effort data
  const { data: dailyEffort, isLoading: dailyLoading } = useQuery<DailyEffortData>({
    queryKey: ['daily-effort', id, email],
    queryFn: async () => {
      const res = await fetch(
        `/api/orders/${id}/daily-effort?email=${encodeURIComponent(email)}`,
      );
      if (!res.ok) return { spread: [], sources: [] };
      const json = await res.json();
      return json.data ?? { spread: [], sources: [] };
    },
  });

  const spread = dailyEffort?.spread ?? [];
  const sources = dailyEffort?.sources ?? [];

  // Period & date range state
  const [period, setPeriod] = useState<Period>('day');
  const [rangeStart, setRangeStart] = useState<Date | undefined>(undefined);
  const [rangeEnd, setRangeEnd] = useState<Date | undefined>(undefined);
  const [activePreset, setActivePreset] = useState<string | null>(null);

  // Min/max dates from data for DateRangePicker constraints
  const dateBounds = useMemo(() => {
    const allDates = [
      ...spread.map(s => s.date),
      ...sources.map(s => s.date),
    ];
    if (allDates.length === 0) return { min: undefined, max: undefined };
    allDates.sort();
    return {
      min: new Date(allDates[0] + 'T00:00:00'),
      max: new Date(allDates[allDates.length - 1] + 'T00:00:00'),
    };
  }, [spread, sources]);

  // Filtered data by date range
  const filteredSpread = useMemo(() => {
    if (!rangeStart && !rangeEnd) return spread;
    const startStr = rangeStart ? toDateStr(rangeStart) : '';
    const endStr = rangeEnd ? toDateStr(rangeEnd) : '\uffff';
    return spread.filter(s => s.date >= startStr && s.date <= endStr);
  }, [spread, rangeStart, rangeEnd]);

  const filteredSources = useMemo(() => {
    if (!rangeStart && !rangeEnd) return sources;
    const startStr = rangeStart ? toDateStr(rangeStart) : '';
    const endStr = rangeEnd ? toDateStr(rangeEnd) : '\uffff';
    return sources.filter(s => s.date >= startStr && s.date <= endStr);
  }, [sources, rangeStart, rangeEnd]);

  const filteredCommitDistribution = useMemo(() => {
    const dist = dailyEffort?.commitDistribution;
    if (!dist || (!rangeStart && !rangeEnd)) return dist;
    const startStr = rangeStart ? toDateStr(rangeStart) : '';
    const endStr = rangeEnd ? toDateStr(rangeEnd) : '\uffff';
    // Keep only entries within range per commit hash
    const result: Record<string, { date: string; effort: number }[]> = {};
    for (const [hash, entries] of Object.entries(dist)) {
      const filtered = entries.filter(e => e.date >= startStr && e.date <= endStr);
      if (filtered.length > 0) result[hash] = filtered;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }, [dailyEffort?.commitDistribution, rangeStart, rangeEnd]);

  // Aggregated buckets for non-day periods
  const aggregatedBuckets = useMemo<AggregatedBucket[]>(() => {
    if (period === 'day') return [];
    // Convert filteredSources to EffortRow[] (placed + overhead rows)
    const rows: EffortRow[] = [];
    for (const s of filteredSources) {
      if (s.placed > 0) {
        rows.push({ email, date: s.date, effort: s.placed, type: 'placed' });
      }
      if (s.overhead > 0) {
        rows.push({ email, date: s.date, effort: s.overhead, type: 'overhead' });
      }
    }
    return aggregateEffort(rows, period, [email]);
  }, [filteredSources, period, email]);

  const ghostDisplay = metric?.hasEnoughData ? metric.ghostPercent : null;
  const color = metric?.hasEnoughData ? ghostColor(metric.ghostPercent) : 'gray';

  const handleBarClick = useCallback(() => {
    commitSectionRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handleCommitClick = useCallback((commitHash: string) => {
    setHighlightedCommit(commitHash);
    commitSectionRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/orders/${id}`)}
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            Back to Analysis
          </Button>
          <div>
            <h1 className="text-2xl font-bold">
              {metric?.developerName ?? email}
            </h1>
            <p className="text-sm text-muted-foreground">{email}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {metric && (
            <Badge className={`text-lg px-3 py-1 ${ghostBadgeStyles[color]}`}>
              Ghost {formatGhostPercent(ghostDisplay)}
            </Badge>
          )}
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={!prev}
              onClick={() => prev && router.push(`/orders/${id}/developers/${encodeURIComponent(prev.developerEmail)}`)}
              title={prev ? prev.developerName : undefined}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!next}
              onClick={() => next && router.push(`/orders/${id}/developers/${encodeURIComponent(next.developerEmail)}`)}
              title={next ? next.developerName : undefined}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <DeveloperKpiCards metric={metric} isLoading={metricsLoading} />

      {/* Effort Chart */}
      <Card>
        <CardHeader>
          <CardTitle>
            {({ day: 'Daily', week: 'Weekly', month: 'Monthly', quarter: 'Quarterly', year: 'Yearly', all_time: 'All Time' } as Record<Period, string>)[period]} Effort Timeline
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Controls */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex gap-1">
              {PERIODS.map(p => (
                <Button
                  key={p.value}
                  variant={period === p.value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setPeriod(p.value)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            {dateBounds.max && (() => {
              const maxY = dateBounds.max!.getFullYear();
              const presets: { key: string; label: string; start: Date; end: Date }[] = [
                {
                  key: '30d',
                  label: '30d',
                  start: (() => { const d = new Date(dateBounds.max!); d.setDate(d.getDate() - 29); return d < dateBounds.min! ? dateBounds.min! : d; })(),
                  end: dateBounds.max!,
                },
                {
                  key: '90d',
                  label: '90d',
                  start: (() => { const d = new Date(dateBounds.max!); d.setDate(d.getDate() - 89); return d < dateBounds.min! ? dateBounds.min! : d; })(),
                  end: dateBounds.max!,
                },
                {
                  key: 'thisYear',
                  label: String(maxY),
                  start: new Date(`${maxY}-01-01T00:00:00`),
                  end: dateBounds.max!,
                },
                ...(maxY > dateBounds.min!.getFullYear() ? [{
                  key: 'prevYear',
                  label: String(maxY - 1),
                  start: new Date(`${maxY - 1}-01-01T00:00:00`),
                  end: new Date(`${maxY - 1}-12-31T00:00:00`),
                }] : []),
              ];
              return (
                <div className="flex items-center gap-1">
                  {presets.map(p => (
                    <Button
                      key={p.key}
                      variant={activePreset === p.key ? 'default' : 'outline'}
                      size="sm"
                      className="h-7 text-xs px-2"
                      onClick={() => { setRangeStart(p.start); setRangeEnd(p.end); setActivePreset(p.key); }}
                    >
                      {p.label}
                    </Button>
                  ))}
                </div>
              );
            })()}
            <DateRangePicker
              startDate={rangeStart}
              endDate={rangeEnd}
              onStartDateChange={(d) => { setRangeStart(d); setActivePreset(null); }}
              onEndDateChange={(d) => { setRangeEnd(d); setActivePreset(null); }}
              minDate={dateBounds.min}
              maxDate={dateBounds.max}
              className="w-auto"
            />
            {(rangeStart || rangeEnd) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setRangeStart(undefined); setRangeEnd(undefined); setActivePreset(null); }}
              >
                Clear dates
              </Button>
            )}
          </div>

          {/* Chart */}
          {dailyLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : period === 'day' ? (
            <DeveloperEffortChart
              spread={filteredSpread}
              sources={filteredSources}
              commitDistribution={filteredCommitDistribution}
              onBarClick={handleBarClick}
              onCommitClick={handleCommitClick}
            />
          ) : (
            <AggregatedChart buckets={aggregatedBuckets} />
          )}
        </CardContent>
      </Card>

      {/* Source-Spread Summary Table */}
      {filteredSources.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Source-Spread Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 border-b">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Date</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">Day</th>
                    <th className="px-4 py-2 text-right font-medium text-muted-foreground">Estimated</th>
                    <th className="px-4 py-2 text-right font-medium text-muted-foreground">Placed</th>
                    <th className="px-4 py-2 text-right font-medium text-muted-foreground">Overhead</th>
                    <th className="px-4 py-2 text-right font-medium text-muted-foreground">Commits</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[...filteredSources].sort((a, b) => b.date.localeCompare(a.date)).map((s) => (
                    <tr key={s.date} className="hover:bg-muted/30">
                      <td className="px-4 py-2 font-mono">{s.date}</td>
                      <td className="px-4 py-2">{formatDateLabel(s.date)}</td>
                      <td className="px-4 py-2 text-right">{s.estimated.toFixed(1)}h</td>
                      <td className="px-4 py-2 text-right">{s.placed.toFixed(1)}h</td>
                      <td className={`px-4 py-2 text-right ${s.overhead > 0 ? 'text-red-600 font-medium' : ''}`}>
                        {s.overhead > 0 ? `+${s.overhead.toFixed(1)}h` : '-'}
                      </td>
                      <td className="px-4 py-2 text-right">{s.commits.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Commit Analysis Table */}
      <div ref={commitSectionRef}>
        <Card>
          <CardHeader>
            <CardTitle>Commits</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <CommitAnalysisTable orderId={id} authorEmail={email} commitDistribution={dailyEffort?.commitDistribution} highlightedCommit={highlightedCommit} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
