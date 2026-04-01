'use client';

import { useState } from 'react';
import { useRouter } from '@/i18n/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { GhostDistributionPanel } from '@/components/ghost-distribution-panel';
import { GhostDeveloperTable } from '@/components/ghost-developer-table';
import { GhostPeriodSelector } from '@/components/ghost-period-selector';
import { CommitAnalysisTable } from '@/components/commit-analysis-table';
import { EffortTimeline } from '@/components/effort-timeline';
import { GHOST_NORM, type GhostMetric, type GhostEligiblePeriod } from '@devghost/shared';

type GhostNormMode = 'fixed' | 'median';

interface AnalysisResultsOverviewProps {
  orderId: string;
  metrics: GhostMetric[];
  period: GhostEligiblePeriod;
  onPeriodChange: (period: GhostEligiblePeriod) => void;
  onShareChange: (email: string, share: number, auto: boolean) => void;
  highlightedEmail: string | null;
  demoMode?: boolean;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function AnalysisResultsOverview({
  orderId,
  metrics,
  period,
  onPeriodChange,
  onShareChange,
  highlightedEmail,
  demoMode,
}: AnalysisResultsOverviewProps) {
  const t = useTranslations('orders');
  const locale = useLocale();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('overview');
  const [ghostNormMode, setGhostNormMode] = useState<GhostNormMode>('fixed');

  // Ghost norm calculation
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
  const displayMetrics: GhostMetric[] = metrics.map((metric) => {
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
  });

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

        <Card>
          <CardHeader>
            <CardTitle>{t('detail.ghostDistribution')}</CardTitle>
          </CardHeader>
          <CardContent>
            <GhostDistributionPanel
              metrics={displayMetrics}
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
              metrics={displayMetrics}
              orderId={orderId}
              highlightedEmail={highlightedEmail ?? undefined}
              onShareChange={demoMode ? undefined : onShareChange}
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
