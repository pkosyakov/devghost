'use client';

import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft } from 'lucide-react';
import { RepositoryHeader } from './components/repository-header';
import { RepositoryKpiSummary } from './components/repository-kpi-summary';
import { RepositoryContributors } from './components/repository-contributors';
import { RepositoryActivity } from './components/repository-activity';

export default function RepositoryDetailPage() {
  const t = useTranslations('repositoryDetail');
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['repository', id],
    queryFn: async () => {
      const res = await fetch(`/api/v2/repositories/${id}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
  });

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
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <p className="text-destructive">{t('error.title')}</p>
        <Button onClick={() => refetch()}>{t('error.retry')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <Link
        href="/repositories"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <RepositoryHeader repository={data.repository} />

      <RepositoryKpiSummary
        totalCommits={data.summaryMetrics.totalCommits}
        contributorCount={data.summaryMetrics.contributorCount}
        lastActivityAt={data.summaryMetrics.lastActivityAt}
      />

      <RepositoryContributors
        contributors={data.contributors}
        unresolvedContributors={data.unresolvedContributors}
      />

      <RepositoryActivity commits={data.recentActivity} />
    </div>
  );
}
