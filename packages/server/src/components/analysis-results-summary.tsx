'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { GhostKpiCards } from '@/components/ghost-kpi-cards';
import { CalendarRange } from 'lucide-react';

interface AnalysisResultsSummaryProps {
  orderName: string;
  /** Completed-result counts (not raw extraction-era) */
  repoCount: number;
  contributorCount: number;
  commitCount: number;
  completedAt: string | null;
  /** KPI data */
  avgGhostPercent: number | null;
  totalWorkDays: number;
  ghostNormHours: number;
  /** Scope display */
  dateRangeLabel: string | null;
  scopeLabel: string | null;
  isPartialScope: boolean;
}

export function AnalysisResultsSummary({
  orderName,
  repoCount,
  contributorCount,
  commitCount,
  completedAt,
  avgGhostPercent,
  totalWorkDays,
  ghostNormHours,
  dateRangeLabel,
  scopeLabel,
  isPartialScope,
}: AnalysisResultsSummaryProps) {
  const t = useTranslations('analysisResults');

  return (
    <div className="space-y-4">
      {/* Headline */}
      <div>
        <h1 className="text-2xl font-bold">{orderName}</h1>
        <p className="text-sm text-muted-foreground">
          {t('summary.subtitle', { repoCount, contributorCount, commitCount })}
          {completedAt && (
            <span className="ml-2">
              &middot; {t('summary.completedAt', { date: new Date(completedAt).toLocaleDateString() })}
            </span>
          )}
        </p>
      </div>

      {/* KPI Cards */}
      <GhostKpiCards
        avgGhostPercent={avgGhostPercent}
        developerCount={contributorCount}
        commitCount={commitCount}
        totalWorkDays={totalWorkDays}
        ghostNormHours={ghostNormHours}
      />

      {/* Scope / date range */}
      {dateRangeLabel && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
          <CalendarRange className="h-4 w-4 flex-shrink-0" />
          <span>{dateRangeLabel}</span>
          {scopeLabel && (
            <>
              <span className="text-muted-foreground/40">&middot;</span>
              {isPartialScope ? (
                <Badge variant="outline" className="border-amber-300 text-amber-700 bg-amber-50 text-xs font-normal">
                  {scopeLabel}
                </Badge>
              ) : (
                <span>{scopeLabel}</span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
