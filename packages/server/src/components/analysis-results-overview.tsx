'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { GhostDistributionPanel } from '@/components/ghost-distribution-panel';
import { GhostDeveloperTable } from '@/components/ghost-developer-table';
import { GhostPeriodSelector } from '@/components/ghost-period-selector';
import { DateRangeFilter } from '@/components/date-range-filter';
import { CommitAnalysisTable } from '@/components/commit-analysis-table';
import { EffortTimeline } from '@/components/effort-timeline';
import { GHOST_NORM, MIN_WORK_DAYS_FOR_GHOST, type GhostMetric, type GhostEligiblePeriod } from '@devghost/shared';
import type { EffortRow, TimelineDeveloper } from '@/components/effort-timeline-utils';

type GhostNormMode = 'fixed' | 'median';

interface TimelineData {
  rows: EffortRow[];
  developers: TimelineDeveloper[];
}

interface AnalysisResultsOverviewProps {
  orderId: string;
  metrics: GhostMetric[];
  period: GhostEligiblePeriod;
  onPeriodChange: (period: GhostEligiblePeriod) => void;
  onShareChange: (email: string, share: number, auto: boolean) => void;
  shareUpdating?: boolean;
  highlightedEmail: string | null;
  demoMode?: boolean;
  /** Called when the date-range slider moves to/from a sub-range (true = sub-range active). */
  onSubRangeChange?: (isSubRange: boolean) => void;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Recalculate GhostMetric[] from effort-timeline rows for a date sub-range. */
function recalcMetrics(
  rows: EffortRow[],
  dateFrom: string,
  dateTo: string,
  originalMetrics: GhostMetric[],
  ghostNorm: number,
): GhostMetric[] {
  const filtered = rows.filter(r => r.date >= dateFrom && r.date <= dateTo);

  const byDev = new Map<string, {
    totalEffort: number;
    overheadEffort: number;
    placedDates: Set<string>;
  }>();
  for (const r of filtered) {
    let dev = byDev.get(r.email);
    if (!dev) {
      dev = { totalEffort: 0, overheadEffort: 0, placedDates: new Set() };
      byDev.set(r.email, dev);
    }
    dev.totalEffort += r.effort;
    if (r.type === 'placed') {
      dev.placedDates.add(r.date);
    } else {
      dev.overheadEffort += r.effort;
    }
  }

  const result: GhostMetric[] = [];

  for (const orig of originalMetrics) {
    const dev = byDev.get(orig.developerEmail);

    if (!dev) {
      // Developer has no effort rows in this date range — show with zeroed metrics
      result.push({
        ...orig,
        totalEffortHours: 0,
        actualWorkDays: 0,
        avgDailyEffort: 0,
        ghostPercentRaw: null,
        ghostPercent: null,
        hasEnoughData: false,
        overheadHours: 0,
      });
      continue;
    }

    const workDays = dev.placedDates.size;
    const totalEffort = Math.round(dev.totalEffort * 100) / 100;
    const overheadHours = Math.round(dev.overheadEffort * 100) / 100;
    const avgDaily = workDays > 0 ? totalEffort / workDays : 0;
    const hasEnoughData = workDays >= MIN_WORK_DAYS_FOR_GHOST;
    const share = orig.share;

    const ghostPercentRaw = hasEnoughData ? (avgDaily / ghostNorm) * 100 : null;
    const ghostPercent = hasEnoughData && share > 0
      ? (avgDaily / (ghostNorm * share)) * 100
      : null;

    result.push({
      ...orig,
      totalEffortHours: totalEffort,
      actualWorkDays: workDays,
      avgDailyEffort: avgDaily,
      ghostPercentRaw,
      ghostPercent,
      hasEnoughData,
      overheadHours,
    });
  }

  return result;
}

export function AnalysisResultsOverview({
  orderId,
  metrics,
  period,
  onPeriodChange,
  onShareChange,
  shareUpdating,
  highlightedEmail,
  demoMode,
  onSubRangeChange,
}: AnalysisResultsOverviewProps) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('overview');
  const [ghostNormMode, setGhostNormMode] = useState<GhostNormMode>('fixed');

  // ---- Ghost norm calculation ----
  const normCandidates = metrics
    .filter((m) => m.hasEnoughData && Number.isFinite(m.avgDailyEffort) && m.avgDailyEffort > 0)
    .map((m) => m.avgDailyEffort);
  const medianGhostNorm = median(normCandidates);
  const effectiveGhostNorm =
    ghostNormMode === 'median' && medianGhostNorm != null ? medianGhostNorm : GHOST_NORM;
  const effectiveGhostNormMode: GhostNormMode =
    ghostNormMode === 'median' && medianGhostNorm != null ? 'median' : 'fixed';

  const normFmt = new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });
  const effectiveGhostNormLabel = normFmt.format(effectiveGhostNorm);
  const medianGhostNormLabel = medianGhostNorm != null ? normFmt.format(medianGhostNorm) : null;

  // Apply ghost norm to metrics
  const displayMetrics = useMemo(() => metrics.map((metric) => {
    if (!metric.hasEnoughData || metric.actualWorkDays <= 0) return metric;
    const avgDailyEffort = metric.avgDailyEffort;
    const raw = (avgDailyEffort / effectiveGhostNorm) * 100;
    const adjusted =
      metric.share > 0 ? (avgDailyEffort / (effectiveGhostNorm * metric.share)) * 100 : null;
    return {
      ...metric,
      ghostPercentRaw: Number.isFinite(raw) ? raw : null,
      ghostPercent: adjusted != null && Number.isFinite(adjusted) ? adjusted : null,
    };
  }), [metrics, effectiveGhostNorm]);

  // ---- Effort timeline data for date range filtering ----
  const { data: timeline } = useQuery<TimelineData>({
    queryKey: ['effort-timeline', orderId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${orderId}/effort-timeline`);
      if (!res.ok) throw new Error('Failed to fetch effort timeline');
      const json = await res.json();
      return json.data;
    },
    enabled: !demoMode,
  });

  const allDates = useMemo(() => {
    if (!timeline?.rows?.length) return [];
    const set = new Set<string>();
    for (const r of timeline.rows) set.add(r.date);
    return [...set].sort();
  }, [timeline]);

  const hasDateFilter = allDates.length >= 2 && !demoMode;

  // ---- Date range slider state ----
  const [sliderPos, setSliderPos] = useState<[number, number] | null>(null);
  const [committedRange, setCommittedRange] = useState<[number, number] | null>(null);

  // Reset on data change (use boundary dates + length for robust detection)
  const firstDate = allDates[0] ?? '';
  const lastDate = allDates[allDates.length - 1] ?? '';
  useEffect(() => { setSliderPos(null); setCommittedRange(null); }, [orderId, firstDate, lastDate, allDates.length]);

  const maxIdx = Math.max(0, allDates.length - 1);
  const startIdx = committedRange ? Math.min(committedRange[0], maxIdx) : 0;
  const endIdx = committedRange ? Math.min(committedRange[1], maxIdx) : maxIdx;
  const isFullRange = startIdx === 0 && endIdx === maxIdx;

  // Notify parent when sub-range state changes
  const prevIsFullRangeRef = useRef(true);
  useEffect(() => {
    const isSubRange = hasDateFilter && !isFullRange;
    const wasSubRange = !prevIsFullRangeRef.current;
    if (isSubRange !== wasSubRange) {
      prevIsFullRangeRef.current = !isSubRange;
      onSubRangeChange?.(isSubRange);
    }
  }, [hasDateFilter, isFullRange, onSubRangeChange]);

  // ---- Filtered metrics (applied to both charts and table) ----
  const filteredMetrics = useMemo(() => {
    if (!hasDateFilter || isFullRange || !timeline?.rows) return displayMetrics;
    return recalcMetrics(
      timeline.rows,
      allDates[startIdx],
      allDates[endIdx],
      displayMetrics,
      effectiveGhostNorm,
    );
  }, [hasDateFilter, isFullRange, timeline, startIdx, endIdx, allDates, displayMetrics, effectiveGhostNorm]);

  const handleSliderCommit = useCallback(([s, e]: [number, number]) => {
    setSliderPos([s, e]);
    setCommittedRange([s, e]);
  }, []);

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab}>
      <TabsList>
        <TabsTrigger value="overview">{t('detail.overview')}</TabsTrigger>
        {!demoMode && <TabsTrigger value="commits">{t('detail.commits')}</TabsTrigger>}
        {!demoMode && <TabsTrigger value="calendar">{t('detail.effortTimeline')}</TabsTrigger>}
      </TabsList>

      <TabsContent value="overview" className="space-y-6">
        <div className="flex justify-end items-center gap-2 flex-wrap">
          <GhostPeriodSelector value={period} onChange={onPeriodChange} />
          <Select
            value={ghostNormMode}
            onValueChange={(v) => setGhostNormMode(v as GhostNormMode)}
          >
            <SelectTrigger className="w-[320px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">
                {t('detail.ghostNormModeFixed', { hours: GHOST_NORM.toFixed(1) })}
              </SelectItem>
              <SelectItem value="median">{t('detail.ghostNormModeMedian')}</SelectItem>
            </SelectContent>
          </Select>
          <Badge variant="outline" className="text-xs">
            {t('detail.ghostNormCurrent', { hours: effectiveGhostNormLabel })}
          </Badge>
        </div>

        {ghostNormMode === 'median' && effectiveGhostNormMode === 'fixed' && (
          <p className="text-xs text-muted-foreground text-right">
            {t('detail.ghostNormMedianFallback', { hours: GHOST_NORM.toFixed(1) })}
          </p>
        )}
        {ghostNormMode === 'median' && medianGhostNormLabel && (
          <p className="text-xs text-muted-foreground text-right">
            {t('detail.ghostNormMedianValue', { hours: medianGhostNormLabel })}
          </p>
        )}

        {/* Date range filter */}
        {hasDateFilter && (
          <DateRangeFilter
            allDates={allDates}
            sliderPos={sliderPos}
            committedRange={committedRange}
            onSliderChange={setSliderPos}
            onSliderCommit={handleSliderCommit}
          />
        )}

        <Card>
          <CardHeader>
            <CardTitle>{t('detail.ghostDistribution')}</CardTitle>
          </CardHeader>
          <CardContent>
            <GhostDistributionPanel
              metrics={filteredMetrics}
              onDeveloperClick={demoMode ? undefined : (email) =>
                router.push(`/orders/${orderId}/developers/${encodeURIComponent(email)}`)
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('detail.developersTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <GhostDeveloperTable
              metrics={filteredMetrics}
              orderId={orderId}
              highlightedEmail={highlightedEmail ?? undefined}
              onShareChange={demoMode ? undefined : onShareChange}
              shareUpdating={shareUpdating}
              readOnly={demoMode}
            />
          </CardContent>
        </Card>
      </TabsContent>

      {!demoMode && (
        <TabsContent value="commits">
          <CommitAnalysisTable orderId={orderId} />
        </TabsContent>
      )}

      {!demoMode && (
        <TabsContent value="calendar">
          <EffortTimeline orderId={orderId} />
        </TabsContent>
      )}
    </Tabs>
  );
}
