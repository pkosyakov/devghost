'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft } from 'lucide-react';
import { ContributorHeader } from './components/contributor-header';
import { ContributorKpiSummary } from './components/contributor-kpi-summary';
import { ContributorAliasesPanel } from './components/contributor-aliases-panel';
import { ContributorRepoBreakdown } from './components/contributor-repo-breakdown';
import { ContributorCommitEvidence } from './components/contributor-commit-evidence';
import { ContributorMergeModal } from './components/contributor-merge-modal';

export default function ContributorDetailPage() {
  const t = useTranslations('contributorDetail');
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const [mergeOpen, setMergeOpen] = useState(false);

  // Preserve list state for back navigation
  const fromParams = searchParams.get('from') || '';

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['contributor', id],
    queryFn: async () => {
      const res = await fetch(`/api/v2/contributors/${id}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
  });

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-16 w-full" />
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  // Error / not found state
  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <p className="text-destructive">{t(data ? 'error.title' : 'error.notFound')}</p>
        <Button onClick={() => refetch()}>{t('error.retry')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Back link preserving list state */}
      <Link
        href={`/people${fromParams ? `?${fromParams}` : ''}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <ContributorHeader
        contributor={data.contributor}
        identityHealth={data.identityHealth}
        onMergeClick={() => setMergeOpen(true)}
      />

      <ContributorKpiSummary
        totalCommits={data.summaryMetrics.totalCommits}
        activeRepositoryCount={data.summaryMetrics.activeRepositoryCount}
        lastActivityAt={data.summaryMetrics.lastActivityAt}
      />

      <ContributorAliasesPanel
        contributorId={data.contributor.id}
        aliases={data.aliases}
        potentialMatches={data.potentialMatches}
      />

      <ContributorRepoBreakdown repositories={data.repositoryBreakdown} />

      <ContributorCommitEvidence contributorId={data.contributor.id} />

      <ContributorMergeModal
        contributorId={data.contributor.id}
        open={mergeOpen}
        onOpenChange={setMergeOpen}
      />
    </div>
  );
}
