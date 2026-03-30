'use client';

import { Suspense, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useRouter, usePathname } from '@/i18n/navigation';
import { useQuery } from '@tanstack/react-query';
import { pickActiveScopeParams } from '@/lib/active-scope';
import { TeamSummaryStrip } from './components/team-summary-strip';
import { TeamTable } from './components/team-table';
import { CreateTeamDialog } from './components/create-team-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ScreenHelpTrigger } from '@/components/layout/screen-help-trigger';

export default function TeamsPageWrapper() {
  return (
    <Suspense fallback={<div className="space-y-6 p-6"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>}>
      <TeamsPage />
    </Suspense>
  );
}

function TeamsPage() {
  const t = useTranslations('teams');
  const tCommon = useTranslations('common');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const page = Number(searchParams.get('page') || '1');
  const pageSize = Number(searchParams.get('pageSize') || '20');
  const sort = searchParams.get('sort') || 'name';
  const sortOrder = searchParams.get('sortOrder') || 'asc';
  const search = searchParams.get('search') || '';

  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === '' || value === 'all') {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      router.replace(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname],
  );

  const queryParams = new URLSearchParams();
  queryParams.set('page', String(page));
  queryParams.set('pageSize', String(pageSize));
  queryParams.set('sort', sort);
  queryParams.set('sortOrder', sortOrder);
  if (search) queryParams.set('search', search);
  const activeScopeParams = pickActiveScopeParams(searchParams);
  activeScopeParams.forEach((value, key) => queryParams.set(key, value));

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['teams', queryParams.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/v2/teams?${queryParams.toString()}`);
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
        <Skeleton className="h-20 w-48" />
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

  if (!data?.teams?.length && !search) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <h2 className="text-xl font-semibold">{t('empty.title')}</h2>
        <p className="text-muted-foreground">{t('empty.description')}</p>
        <CreateTeamDialog />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <ScreenHelpTrigger
            screenTitle={t('title')}
            what={t('help.what')}
            how={t('help.how')}
          />
        </div>
        <CreateTeamDialog />
      </div>

      <TeamSummaryStrip
        teamCount={data?.summary?.teamCount ?? 0}
        activeTeamCount={data?.summary?.activeTeamCount ?? 0}
        memberedContributorCount={data?.summary?.memberedContributorCount ?? 0}
      />

      <Input
        placeholder={t('filters.searchPlaceholder')}
        value={search}
        onChange={(e) => updateParams({ search: e.target.value, page: '1' })}
        className="max-w-sm"
      />

      {data?.teams?.length ? (
        <>
          <TeamTable
            teams={data.teams}
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
            onClick={() => updateParams({ search: '', page: '1' })}
          >
            {t('filteredEmpty.reset')}
          </Button>
        </div>
      )}
    </div>
  );
}
