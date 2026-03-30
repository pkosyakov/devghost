'use client';

import { Suspense, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useRouter, usePathname } from '@/i18n/navigation';
import { useQuery } from '@tanstack/react-query';
import { pickActiveScopeParams } from '@/lib/active-scope';
import { RepositorySummaryStrip } from './components/repository-summary-strip';
import { RepositoryFilters } from './components/repository-filters';
import { RepositoryTable } from './components/repository-table';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ScreenHelpTrigger } from '@/components/layout/screen-help-trigger';
import { useWorkspaceStage } from '@/hooks/use-workspace-stage';
import { UsersRound } from 'lucide-react';

export default function RepositoriesPageWrapper() {
  return (
    <Suspense fallback={<div className="space-y-6 p-6"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>}>
      <RepositoriesPage />
    </Suspense>
  );
}

function RepositoriesPage() {
  const t = useTranslations('repositories');
  const tCommon = useTranslations('common');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const page = Number(searchParams.get('page') || '1');
  const pageSize = Number(searchParams.get('pageSize') || '20');
  const sort = searchParams.get('sort') || 'fullName';
  const sortOrder = searchParams.get('sortOrder') || 'asc';
  const freshness = searchParams.get('freshness') || 'all';
  const language = searchParams.get('language') || 'all';
  const search = searchParams.get('search') || '';

  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === 'all' || value === '') {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      router.replace(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname]
  );

  const queryParams = new URLSearchParams();
  queryParams.set('page', String(page));
  queryParams.set('pageSize', String(pageSize));
  queryParams.set('sort', sort);
  queryParams.set('sortOrder', sortOrder);
  if (freshness !== 'all') queryParams.set('freshness', freshness);
  if (language !== 'all') queryParams.set('language', language);
  if (search) queryParams.set('search', search);
  const activeScopeParams = pickActiveScopeParams(searchParams);
  activeScopeParams.forEach((value, key) => queryParams.set(key, value));

  const { data: stageData } = useWorkspaceStage();
  const showFirstTeamBanner = stageData?.workspaceStage === 'first_data';

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['repositories', queryParams.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/v2/repositories?${queryParams.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
  });

  const handleSortChange = (field: string) => {
    if (sort === field) {
      updateParams({ sortOrder: sortOrder === 'asc' ? 'desc' : 'asc' });
    } else {
      updateParams({ sort: field, sortOrder: 'asc' });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <p className="text-destructive">{t('error.title')}</p>
        <Button onClick={() => refetch()}>{t('error.retry')}</Button>
      </div>
    );
  }

  if (!data?.repositories?.length && !search && freshness === 'all' && language === 'all') {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <h2 className="text-xl font-semibold">{t('empty.title')}</h2>
        <p className="text-muted-foreground">{t('empty.description')}</p>
      </div>
    );
  }

  const freshCount = data?.summary?.freshCount ?? 0;
  const staleCount = data?.summary?.staleCount ?? 0;
  const neverCount = data?.summary?.neverCount ?? 0;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <ScreenHelpTrigger
          screenTitle={t('title')}
          what={t('help.what')}
          how={t('help.how')}
        />
      </div>

      <RepositorySummaryStrip
        totalRepositories={data?.summary?.totalRepositories ?? 0}
        freshCount={freshCount}
        staleCount={staleCount}
        neverCount={neverCount}
      />

      {showFirstTeamBanner && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex items-center gap-4 pt-6">
            <UsersRound className="h-6 w-6 shrink-0 text-primary" />
            <div className="space-y-1">
              <p className="font-medium">{t('firstTeamBanner.title')}</p>
              <p className="text-sm text-muted-foreground">{t('firstTeamBanner.description')}</p>
            </div>
          </CardContent>
        </Card>
      )}

      <RepositoryFilters
        search={search}
        freshness={freshness}
        language={language}
        languages={data?.summary?.languages ?? []}
        onSearchChange={(v) => updateParams({ search: v, page: '1' })}
        onFreshnessChange={(v) => updateParams({ freshness: v, page: '1' })}
        onLanguageChange={(v) => updateParams({ language: v, page: '1' })}
      />

      {data?.repositories?.length ? (
        <>
          <RepositoryTable
            repositories={data.repositories}
            sort={sort}
            sortOrder={sortOrder}
            onSortChange={handleSortChange}
          />

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {tCommon('totalCount', { count: data.pagination.total })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => updateParams({ page: String(page - 1) })}
              >
                {tCommon('previous')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.pagination.totalPages}
                onClick={() => updateParams({ page: String(page + 1) })}
              >
                {tCommon('next')}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-8">
          <p className="text-muted-foreground">{t('filteredEmpty.title')}</p>
          <Button
            variant="link"
            onClick={() => updateParams({ search: '', freshness: 'all', language: 'all', page: '1' })}
          >
            {t('filteredEmpty.reset')}
          </Button>
        </div>
      )}
    </div>
  );
}
