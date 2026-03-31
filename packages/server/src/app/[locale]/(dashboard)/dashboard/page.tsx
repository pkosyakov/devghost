'use client';

import { Suspense } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import { pickActiveScopeParams } from '@/lib/active-scope';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ScreenHelpTrigger } from '@/components/layout/screen-help-trigger';

export default function DashboardPageWrapper() {
  return (
    <Suspense fallback={<div className="space-y-6"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>}>
      <DashboardPage />
    </Suspense>
  );
}

function DashboardPage() {
  const t = useTranslations('home');
  const searchParams = useSearchParams();
  const scopeQs = pickActiveScopeParams(searchParams).toString();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['home', scopeQs],
    queryFn: async () => {
      const res = await fetch(`/api/v2/home${scopeQs ? `?${scopeQs}` : ''}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid gap-4 md:grid-cols-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-80 w-full" />
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

  if (data.workspaceStage === 'empty') {
    return <EmptyStage t={t} />;
  }

  if (data.workspaceStage === 'first_data') {
    return <FirstDataStage t={t} data={data} scopeQs={scopeQs} />;
  }

  return <OperationalStage t={t} data={data} scopeQs={scopeQs} />;
}

function EmptyStage({ t }: { t: (key: string) => string }) {
  const steps = ['empty.step1', 'empty.step2', 'empty.step3'] as const;
  return (
    <div className="flex flex-col items-center justify-center py-24 space-y-8 text-center">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">{t('empty.title')}</h1>
        <p className="text-lg text-muted-foreground max-w-md">{t('empty.description')}</p>
      </div>
      <ol className="space-y-3 text-left max-w-sm w-full">
        {steps.map((key, i) => (
          <li key={key} className="flex items-start gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-semibold">
              {i + 1}
            </span>
            <span className="text-sm text-muted-foreground pt-0.5">{t(key)}</span>
          </li>
        ))}
      </ol>
      <Link href="/orders/new">
        <Button size="lg">{t('empty.cta')}</Button>
      </Link>
    </div>
  );
}

function FirstDataStage({
  t,
  data,
  scopeQs,
}: {
  t: ReturnType<typeof useTranslations>;
  data: any;
  scopeQs: string;
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('firstData.title')}</h1>
        <p className="text-muted-foreground">{t('firstData.description')}</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard title={t('metrics.activeContributors')} value={data.summaryMetrics.activeContributorCount} />
        <MetricCard title={t('metrics.activeRepositories')} value={data.summaryMetrics.activeRepositoryCount} />
        <MetricCard title={t('metrics.commits')} value={data.summaryMetrics.totalCommits} />
      </div>

      {data.latestCompletedAnalysis && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex items-center justify-between gap-4 pt-6">
            <div className="space-y-1">
              <p className="font-medium">{t('firstData.latestAnalysis.title')}</p>
              <p className="text-sm text-muted-foreground">
                {t('firstData.latestAnalysis.subtitle', {
                  repoCount: data.latestCompletedAnalysis.repoCount,
                  contributorCount: data.latestCompletedAnalysis.contributorCount,
                  commitCount: data.latestCompletedAnalysis.commitCount,
                })}
              </p>
            </div>
            <Link href={`/orders/${data.latestCompletedAnalysis.id}`}>
              <Button>{t('firstData.latestAnalysis.cta')}</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-3">
        <Link href={`/people${scopeQs ? `?${scopeQs}` : ''}`}>
          <Button>{t('firstData.peopleCta')}</Button>
        </Link>
        <Link href={`/repositories${scopeQs ? `?${scopeQs}` : ''}`}>
          <Button variant="outline">{t('firstData.repositoriesCta')}</Button>
        </Link>
      </div>

      {data.topRepositories.length > 0 && (() => {
        const topRepo = data.topRepositories.find((r: any) => r.repositoryId) ?? data.topRepositories[0];
        return topRepo?.repositoryId ? (
          <Card>
            <CardContent className="flex items-center justify-between gap-4 pt-6">
              <div className="space-y-1">
                <p className="font-medium">{t('firstData.teamCtaTitle')}</p>
                <p className="text-sm text-muted-foreground">{t('firstData.teamHint')}</p>
              </div>
              <Link href={`/repositories/${topRepo.repositoryId}${scopeQs ? `?${scopeQs}` : ''}`}>
                <Button variant="default">{t('firstData.teamCta')}</Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="pt-6">
              <p className="text-sm text-muted-foreground">{t('firstData.teamHint')}</p>
            </CardContent>
          </Card>
        );
      })()}
    </div>
  );
}

function OperationalStage({
  t,
  data,
  scopeQs,
}: {
  t: ReturnType<typeof useTranslations>;
  data: any;
  scopeQs: string;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-start gap-2">
          <div>
            <h1 className="text-2xl font-bold">{t('title')}</h1>
            <p className="text-muted-foreground">{t('description')}</p>
          </div>
          <ScreenHelpTrigger
            screenTitle={t('title')}
            what={t('help.what')}
            how={t('help.how')}
            className="mt-1"
          />
        </div>
        <Link href="/reports">
          <Button variant="outline">{t('reportsCta')}</Button>
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <MetricCard title={t('metrics.activeTeams')} value={data.summaryMetrics.activeTeamCount} />
        <MetricCard title={t('metrics.activeContributors')} value={data.summaryMetrics.activeContributorCount} />
        <MetricCard title={t('metrics.activeRepositories')} value={data.summaryMetrics.activeRepositoryCount} />
        <MetricCard title={t('metrics.commits')} value={data.summaryMetrics.totalCommits} />
      </div>

      {data.onboarding?.needsFirstSavedView && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex flex-col gap-4 pt-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1">
              <p className="font-medium">{t('operational.firstSavedView.title')}</p>
              <p className="text-sm text-muted-foreground">{t('operational.firstSavedView.description')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {data.topTeams?.[0]?.teamId ? (
                <Link href={`/teams/${data.topTeams[0].teamId}?scopeKind=team&scopeId=${data.topTeams[0].teamId}`}>
                  <Button>{t('operational.firstSavedView.openTeam')}</Button>
                </Link>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>{t('highlights.title')}</CardTitle>
            <CardDescription>{t('highlights.description')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 lg:grid-cols-3">
            <ListCard
              title={t('sections.teams')}
              emptyLabel={t('sections.empty')}
              items={data.topTeams.map((team: any) => ({
                key: team.teamId,
                label: team.name,
                meta: `${team.memberCount} ${t('labels.members')}`,
                href: `/teams/${team.teamId}${scopeQs ? `?${scopeQs}` : ''}`,
              }))}
            />
            <ListCard
              title={t('sections.contributors')}
              emptyLabel={t('sections.empty')}
              items={data.topContributors.map((contributor: any) => ({
                key: contributor.contributorId ?? contributor.primaryEmail,
                label: contributor.displayName,
                meta: `${contributor.commitCount} ${t('labels.commits')}`,
                href: contributor.contributorId
                  ? `/people/${contributor.contributorId}${scopeQs ? `?${scopeQs}` : ''}`
                  : undefined,
              }))}
            />
            <ListCard
              title={t('sections.repositories')}
              emptyLabel={t('sections.empty')}
              items={data.topRepositories.map((repository: any) => ({
                key: repository.repositoryId ?? repository.fullName,
                label: repository.fullName,
                meta: `${repository.commitCount} ${t('labels.commits')}`,
                href: repository.repositoryId
                  ? `/repositories/${repository.repositoryId}${scopeQs ? `?${scopeQs}` : ''}`
                  : undefined,
              }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t('freshness.title')}</CardTitle>
            <CardDescription>{t('freshness.description')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <FreshnessRow label={t('freshness.fresh')} value={data.freshnessSummary.fresh} />
            <FreshnessRow label={t('freshness.stale')} value={data.freshnessSummary.stale} />
            <FreshnessRow label={t('freshness.never')} value={data.freshnessSummary.never} />
            <div className="pt-2 text-sm text-muted-foreground">
              {data.saveViewState.activeSavedViewId
                ? (data.saveViewState.isDirty ? t('saveState.dirty') : t('saveState.saved'))
                : t('saveState.adhoc')}
            </div>
          </CardContent>
        </Card>

        {data.latestCompletedAnalysis && (
          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <span className="text-sm text-muted-foreground">
              {t('operational.latestAnalysis.label')}
            </span>
            <Link
              href={`/orders/${data.latestCompletedAnalysis.id}`}
              className="text-sm font-medium text-primary hover:underline"
            >
              {data.latestCompletedAnalysis.name}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ title, value }: { title: string; value: number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-3xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function FreshnessRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between rounded-lg border px-3 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

function ListCard({
  title,
  emptyLabel,
  items,
}: {
  title: string;
  emptyLabel: string;
  items: { key: string; label: string; meta: string; href?: string }[];
}) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const content = (
              <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-medium" title={item.label}>
                  {item.label}
                </span>
                <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                  {item.meta}
                </span>
              </div>
            );

            return item.href ? (
              <Link key={item.key} href={item.href} className="block hover:opacity-90">
                {content}
              </Link>
            ) : (
              <div key={item.key}>{content}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
