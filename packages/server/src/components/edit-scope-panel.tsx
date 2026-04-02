'use client';

import { useState, useDeferredValue } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { AlertTriangle, Database, Loader2, Settings2, Sparkles } from 'lucide-react';
import {
  AnalysisPeriodInline,
  type AnalysisPeriodSettings,
} from '@/components/analysis-period-selector';

export type { AnalysisPeriodSettings };

interface RepoCacheBreakdown {
  repository: string;
  totalCommits: number;
  cachedCommits: number;
  newCommits: number;
}

interface EditScopePanelProps {
  orderId: string;
  currentSettings: AnalysisPeriodSettings;
  onSubmit: (settings: AnalysisPeriodSettings, forceRecalculate: boolean) => void;
  onCancel: () => void;
  isSubmitting: boolean;
  availableStartDate?: Date;
  availableEndDate?: Date;
  /** Warning shown when current mode will be changed (e.g. SELECTED_YEARS -> DATE_RANGE) */
  modeChangeWarning?: string;
}

function buildPreviewParams(settings: AnalysisPeriodSettings): string {
  const params = new URLSearchParams({
    includeRepoBreakdown: 'true',
    analysisPeriodMode: settings.mode,
  });
  if (settings.mode === 'DATE_RANGE') {
    if (settings.startDate) params.set('analysisStartDate', settings.startDate.toISOString());
    if (settings.endDate) params.set('analysisEndDate', settings.endDate.toISOString());
  }
  if (settings.mode === 'LAST_N_COMMITS' && settings.commitLimit) {
    params.set('analysisCommitLimit', String(settings.commitLimit));
  }
  return params.toString();
}

export function EditScopePanel({
  orderId,
  currentSettings,
  onSubmit,
  onCancel,
  isSubmitting,
  availableStartDate,
  availableEndDate,
  modeChangeWarning,
}: EditScopePanelProps) {
  const t = useTranslations('components.editScope');
  const [settings, setSettings] = useState<AnalysisPeriodSettings>(currentSettings);
  const [forceRecalculate, setForceRecalculate] = useState(false);

  // Debounce settings changes to avoid excessive API calls
  const deferredSettings = useDeferredValue(settings);

  const { data: cacheStats, isLoading: cacheLoading } = useQuery<{
    totalScopedCommits: number;
    reusableCachedCommits: number;
    billableCommits: number;
    isFirstRunEstimate: boolean;
    repos?: RepoCacheBreakdown[];
  }>({
    queryKey: ['billing-preview', orderId, deferredSettings.mode, deferredSettings.startDate?.toISOString(), deferredSettings.endDate?.toISOString(), deferredSettings.commitLimit],
    queryFn: async () => {
      const params = buildPreviewParams(deferredSettings);
      const res = await fetch(`/api/orders/${orderId}/billing-preview?${params}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed to fetch');
      return json.data;
    },
    staleTime: 10_000,
  });

  const showCacheStats = cacheStats && !cacheStats.isFirstRunEstimate;
  const repos = cacheStats?.repos ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Settings2 className="h-4 w-4" />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {modeChangeWarning && (
          <div className="flex items-start gap-2 p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{modeChangeWarning}</span>
          </div>
        )}
        <AnalysisPeriodInline
          settings={settings}
          onChange={setSettings}
          availableStartDate={availableStartDate}
          availableEndDate={availableEndDate}
        />

        {/* Cache statistics */}
        {cacheLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 bg-muted/50 rounded-lg">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('calculatingCache')}
          </div>
        )}

        {showCacheStats && (
          <div className={`p-3 bg-muted/50 rounded-lg space-y-2 text-sm ${forceRecalculate ? 'opacity-50' : ''}`}>
            <div className="flex items-center gap-4 flex-wrap">
              <span className="flex items-center gap-1.5">
                <Database className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                <span className="font-medium">{cacheStats.reusableCachedCommits.toLocaleString()}</span>
                {' '}{t('inCache')}
              </span>
              <span className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                <span className="font-medium">{cacheStats.billableCommits.toLocaleString()}</span>
                {' '}{t('needsAnalysis')}
              </span>
              <span className="text-muted-foreground">
                ({t('total')}: {cacheStats.totalScopedCommits.toLocaleString()})
              </span>
            </div>

            {repos.length > 1 && (
              <div className="text-xs text-muted-foreground space-y-0.5 pt-1 border-t">
                {repos.map((r) => (
                  <div key={r.repository} className="flex justify-between">
                    <span className="truncate mr-2">{r.repository}</span>
                    <span className="shrink-0 tabular-nums">
                      {r.cachedCommits}/{r.totalCommits} {t('cached')}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {forceRecalculate && (
              <div className="text-xs text-amber-700 dark:text-amber-300">
                {t('cacheIgnored', { count: cacheStats.totalScopedCommits })}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center space-x-2">
          <Checkbox
            id="force-recalculate"
            checked={forceRecalculate}
            onCheckedChange={(checked) => setForceRecalculate(checked === true)}
          />
          <Label htmlFor="force-recalculate" className="text-sm text-muted-foreground">
            {t('recalculate')}
          </Label>
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            onClick={() => onSubmit(settings, forceRecalculate)}
            disabled={isSubmitting}
            size="sm"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t('saveAndAnalyze')}
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={isSubmitting}>
            {t('cancel')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
