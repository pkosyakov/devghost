'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useRouter, usePathname } from '@/i18n/navigation';
import { useQuery } from '@tanstack/react-query';
import { PeopleSummaryStrip } from './components/people-summary-strip';
import { PeopleFilters } from './components/people-filters';
import { PeopleIdentityQueue } from './components/people-identity-queue';
import { PeopleTable } from './components/people-table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export default function PeoplePage() {
  const t = useTranslations('people');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Read filter state from URL
  const page = Number(searchParams.get('page') || '1');
  const pageSize = Number(searchParams.get('pageSize') || '20');
  const sort = searchParams.get('sort') || 'displayName';
  const sortOrder = searchParams.get('sortOrder') || 'asc';
  const classification = searchParams.get('classification') || 'all';
  const identityHealth = searchParams.get('identityHealth') || 'all';
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

  // Fetch contributors
  const queryParams = new URLSearchParams();
  queryParams.set('page', String(page));
  queryParams.set('pageSize', String(pageSize));
  queryParams.set('sort', sort);
  queryParams.set('sortOrder', sortOrder);
  if (classification !== 'all') queryParams.set('classification', classification);
  if (identityHealth !== 'all') queryParams.set('identityHealth', identityHealth);
  if (search) queryParams.set('search', search);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['contributors', queryParams.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/v2/contributors?${queryParams.toString()}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
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

  const handleUnresolvedClick = () => {
    const el = document.getElementById('identity-queue');
    el?.scrollIntoView({ behavior: 'smooth' });
    updateParams({ identityHealth: 'unresolved' });
  };

  // Loading state
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

  // Error state
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <p className="text-destructive">{t('error.title')}</p>
        <Button onClick={() => refetch()}>{t('error.retry')}</Button>
      </div>
    );
  }

  // Empty state
  if (!data?.contributors?.length && !search && classification === 'all' && identityHealth === 'all') {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <h2 className="text-xl font-semibold">{t('empty.title')}</h2>
        <p className="text-muted-foreground">{t('empty.description')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>

      <PeopleSummaryStrip
        totalContributors={data?.totalContributors ?? 0}
        unresolvedCount={data?.identityQueueSummary?.unresolvedCount ?? 0}
        excludedCount={data?.excludedCount ?? 0}
        onUnresolvedClick={handleUnresolvedClick}
      />

      <PeopleFilters
        search={search}
        classification={classification}
        identityHealth={identityHealth}
        onSearchChange={(v) => updateParams({ search: v, page: '1' })}
        onClassificationChange={(v) => updateParams({ classification: v, page: '1' })}
        onIdentityHealthChange={(v) => updateParams({ identityHealth: v, page: '1' })}
      />

      <PeopleIdentityQueue
        unresolvedCount={data?.identityQueueSummary?.unresolvedCount ?? 0}
      />

      {data?.contributors?.length ? (
        <>
          <PeopleTable
            contributors={data.contributors}
            sort={sort}
            sortOrder={sortOrder}
            onSortChange={handleSortChange}
            searchParams={searchParams.toString()}
          />

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {data.pagination.total} total
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => updateParams({ page: String(page - 1) })}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.pagination.totalPages}
                onClick={() => updateParams({ page: String(page + 1) })}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-8">
          <p className="text-muted-foreground">{t('filteredEmpty.title')}</p>
          <Button
            variant="link"
            onClick={() => updateParams({ search: '', classification: 'all', identityHealth: 'all', page: '1' })}
          >
            {t('filteredEmpty.reset')}
          </Button>
        </div>
      )}
    </div>
  );
}
