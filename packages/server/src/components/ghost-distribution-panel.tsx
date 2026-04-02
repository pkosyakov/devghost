'use client';

import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations, useLocale } from 'next-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Slider } from '@/components/ui/slider';
import { GhostBubbleChart } from './ghost-bubble-chart';
import { GhostStripChart } from './ghost-strip-chart';
import { GhostHeatmap } from './ghost-heatmap';
import { GHOST_NORM, MIN_WORK_DAYS_FOR_GHOST } from '@devghost/shared';
import type { GhostMetric } from '@devghost/shared';
import type { EffortRow, TimelineDeveloper } from './effort-timeline-utils';

interface TimelineData {
  rows: EffortRow[];
  developers: TimelineDeveloper[];
}

interface GhostDistributionPanelProps {
  orderId?: string;
  metrics: GhostMetric[];
  effectiveGhostNorm?: number;
  onDeveloperClick?: (email: string) => void;
}

/** Recalculate GhostMetric[] from effort-timeline rows for a date sub-range. */
function recalcMetrics(
  rows: EffortRow[],
  dateFrom: string,
  dateTo: string,
  originalMetrics: GhostMetric[],
  ghostNorm: number,
): GhostMetric[] {
  // Filter rows to selected date range
  const filtered = rows.filter(r => r.date >= dateFrom && r.date <= dateTo);

  // Group by developer
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

  // Build lookup from original metrics for names, share, etc.
  const origMap = new Map(originalMetrics.map(m => [m.developerEmail, m]));

  const result: GhostMetric[] = [];
  for (const [email, dev] of byDev) {
    const orig = origMap.get(email);
    if (!orig) continue; // excluded developer

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
      commitCount: orig.commitCount, // preserve original (not computable per sub-range)
    });
  }

  return result;
}

function formatSliderDate(dateStr: string, locale: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

export function GhostDistributionPanel({
  orderId,
  metrics,
  effectiveGhostNorm,
  onDeveloperClick,
}: GhostDistributionPanelProps) {
  const t = useTranslations('orders.detail');
  const locale = useLocale();

  // Fetch effort-timeline data (shared cache with EffortTimeline tab)
  const { data: timeline } = useQuery<TimelineData>({
    queryKey: ['effort-timeline', orderId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${orderId}/effort-timeline`);
      if (!res.ok) throw new Error('Failed to fetch effort timeline');
      const json = await res.json();
      return json.data;
    },
    enabled: !!orderId,
  });

  // Sorted unique dates from effort-timeline rows
  const allDates = useMemo(() => {
    if (!timeline?.rows?.length) return [];
    const set = new Set<string>();
    for (const r of timeline.rows) set.add(r.date);
    return [...set].sort();
  }, [timeline]);

  const hasSliderData = allDates.length >= 2;
  const maxIdx = Math.max(0, allDates.length - 1);

  // Visual slider position (updates on every drag tick for smooth UX)
  const [sliderPos, setSliderPos] = useState<[number, number] | null>(null);
  // Committed range for metrics recalculation (updates on thumb release)
  const [committedRange, setCommittedRange] = useState<[number, number] | null>(null);

  // Reset slider when order or data changes
  useEffect(() => { setSliderPos(null); setCommittedRange(null); }, [orderId, allDates.length]);

  // Visual indices (for date labels — follow drag in real time)
  const visStartIdx = sliderPos ? Math.min(sliderPos[0], maxIdx) : 0;
  const visEndIdx = sliderPos ? Math.min(sliderPos[1], maxIdx) : maxIdx;

  // Committed indices (for metrics recalculation — only on release)
  const startIdx = committedRange ? Math.min(committedRange[0], maxIdx) : 0;
  const endIdx = committedRange ? Math.min(committedRange[1], maxIdx) : maxIdx;
  const isFullRange = startIdx === 0 && endIdx === maxIdx;

  // Recalculate metrics for sub-range, or use original for full range
  const displayMetrics = useMemo(() => {
    if (!hasSliderData || isFullRange || !timeline?.rows) return metrics;
    return recalcMetrics(
      timeline.rows,
      allDates[startIdx],
      allDates[endIdx],
      metrics,
      effectiveGhostNorm ?? GHOST_NORM,
    );
  }, [hasSliderData, isFullRange, timeline, startIdx, endIdx, allDates, metrics, effectiveGhostNorm]);

  const daysInRange = hasSliderData ? visEndIdx - visStartIdx + 1 : 0;
  const visIsFullRange = visStartIdx === 0 && visEndIdx === maxIdx;

  return (
    <div className="space-y-3">
      {/* Date range slider */}
      {hasSliderData && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{formatSliderDate(allDates[visStartIdx], locale)}</span>
            <span>
              {visIsFullRange
                ? t('sliderFullRange', { count: allDates.length })
                : t('sliderSubRange', { selected: daysInRange, total: allDates.length })}
            </span>
            <span>{formatSliderDate(allDates[visEndIdx], locale)}</span>
          </div>
          <Slider
            aria-label={t('sliderAriaLabel')}
            min={0}
            max={maxIdx}
            step={1}
            value={[visStartIdx, visEndIdx]}
            onValueChange={([s, e]) => setSliderPos([s, e])}
            onValueCommit={([s, e]) => { setSliderPos([s, e]); setCommittedRange([s, e]); }}
          />
        </div>
      )}

      {/* Chart tabs */}
      <Tabs defaultValue="bubble">
        <TabsList>
          <TabsTrigger value="bubble">{t('bubbleChart')}</TabsTrigger>
          <TabsTrigger value="strip">{t('stripChart')}</TabsTrigger>
          <TabsTrigger value="heatmap">{t('heatmap')}</TabsTrigger>
        </TabsList>
        <TabsContent value="bubble" className="min-h-[400px]">
          <GhostBubbleChart metrics={displayMetrics} onBubbleClick={onDeveloperClick} />
        </TabsContent>
        <TabsContent value="strip" className="min-h-[400px]">
          <GhostStripChart metrics={displayMetrics} onDeveloperClick={onDeveloperClick} />
        </TabsContent>
        <TabsContent value="heatmap" className="min-h-[400px]">
          <GhostHeatmap metrics={displayMetrics} onDeveloperClick={onDeveloperClick} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
