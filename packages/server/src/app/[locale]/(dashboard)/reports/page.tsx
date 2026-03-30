'use client';

import { Suspense, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, usePathname, useRouter } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ScreenHelpTrigger } from '@/components/layout/screen-help-trigger';

export default function ReportsPageWrapper() {
  return (
    <Suspense fallback={<div className="space-y-6"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>}>
      <ReportsPage />
    </Suspense>
  );
}

function ReportsPage() {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const queryClient = useQueryClient();
  const page = Number(searchParams.get('page') || '1');
  const search = searchParams.get('search') || '';
  const includeArchived = searchParams.get('includeArchived') === 'true';

  const updateParams = useCallback((updates: Record<string, string>) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    router.replace(`${pathname}?${next.toString()}`);
  }, [pathname, router, searchParams]);

  const hasActiveFilters = !!search || includeArchived;

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['saved-views', page, search, includeArchived],
    queryFn: async () => {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: '20',
        sort: 'updatedAt',
        sortOrder: 'desc',
      });
      if (search) qs.set('search', search);
      if (includeArchived) qs.set('includeArchived', 'true');
      const res = await fetch(`/api/v2/saved-views?${qs.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'archive' | 'restore' }) => {
      const res = await fetch(`/api/v2/saved-views/${id}/${action}`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-views'] });
    },
  });

  const buildSavedViewActivateHref = (savedView: {
    savedViewId: string;
    dateRange?: { start?: string | null; end?: string | null } | null;
    repositoryIds?: string[];
    contributorIds?: string[];
  }) => {
    const params = new URLSearchParams({
      scopeKind: 'saved_view',
      scopeId: savedView.savedViewId,
    });

    if (savedView.dateRange?.start) params.set('from', savedView.dateRange.start);
    if (savedView.dateRange?.end) params.set('to', savedView.dateRange.end);
    if (savedView.repositoryIds?.length) params.set('repositoryIds', savedView.repositoryIds.join(','));
    if (savedView.contributorIds?.length) params.set('contributorIds', savedView.contributorIds.join(','));

    return `/dashboard?${params.toString()}`;
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
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
      </div>

      <div className="flex items-center gap-4">
        <Input
          className="max-w-sm"
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={(event) => updateParams({ search: event.target.value, page: '1' })}
        />
        <div className="flex items-center gap-2">
          <Checkbox
            id="includeArchived"
            checked={includeArchived}
            onCheckedChange={(checked) =>
              updateParams({ includeArchived: checked ? 'true' : '', page: '1' })
            }
          />
          <Label htmlFor="includeArchived" className="text-sm cursor-pointer">
            {t('includeArchived')}
          </Label>
        </div>
      </div>

      <div className="grid gap-4">
        {data.savedViews.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-4 py-12 text-center text-muted-foreground">
              <p>{hasActiveFilters ? t('filteredEmpty') : t('empty')}</p>
              {!hasActiveFilters && (
                <Link href="/dashboard">
                  <Button variant="outline">{t('emptyCta')}</Button>
                </Link>
              )}
            </CardContent>
          </Card>
        ) : (
          data.savedViews.map((savedView: any) => (
            <Card key={savedView.savedViewId}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <div>
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg">{savedView.name}</CardTitle>
                    {savedView.isArchived && (
                      <Badge variant="secondary">{t('archivedBadge')}</Badge>
                    )}
                  </div>
                  <CardDescription>
                    {t('scopeKind', { kind: savedView.scopeKind })} · {t('visibility', { value: savedView.visibility.toLowerCase() })}
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {!savedView.isArchived && (
                    <Link href={buildSavedViewActivateHref(savedView)}>
                      <Button variant="outline" size="sm">{t('activate')}</Button>
                    </Link>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={archiveMutation.isPending}
                    onClick={() => archiveMutation.mutate({
                      id: savedView.savedViewId,
                      action: savedView.isArchived ? 'restore' : 'archive',
                    })}
                  >
                    {savedView.isArchived ? t('restore') : t('archive')}
                  </Button>
                  <Link href={`/reports/${savedView.savedViewId}`}>
                    <Button size="sm">{t('open')}</Button>
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="grid gap-2 text-sm text-muted-foreground md:grid-cols-3">
                <div>{t('teamsCount', { count: savedView.teamCount })}</div>
                <div>{t('repositoriesCount', { count: savedView.repositoryCount })}</div>
                <div>{t('contributorsCount', { count: savedView.contributorCount })}</div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

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
    </div>
  );
}
