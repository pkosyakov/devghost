'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { pickActiveScopeParams } from '@/lib/active-scope';
import { ScreenHelpTrigger } from '@/components/layout/screen-help-trigger';

export default function ReportDetailPageWrapper() {
  return (
    <Suspense fallback={<div className="space-y-6"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>}>
      <ReportDetailPage />
    </Suspense>
  );
}

function ReportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const t = useTranslations('reportDetail');
  const queryClient = useQueryClient();

  const scopeQs = useMemo(() => pickActiveScopeParams(searchParams).toString(), [searchParams]);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['saved-view-detail', id, scopeQs],
    queryFn: async () => {
      const res = await fetch(`/api/v2/saved-views/${id}${scopeQs ? `?${scopeQs}` : ''}`);
      const json = await res.json();
      if (res.status === 404) throw new Error('not_found');
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
  });
  const isNotFound = isError && error?.message === 'not_found';

  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'PRIVATE' | 'WORKSPACE'>('PRIVATE');

  useEffect(() => {
    if (!data) return;
    setName(data.savedView.name);
    setVisibility(data.visibility);
  }, [data]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/saved-views/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, visibility }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-view-detail', id] });
      queryClient.invalidateQueries({ queryKey: ['saved-views'] });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (action: 'archive' | 'restore') => {
      const res = await fetch(`/api/v2/saved-views/${id}/${action}`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-view-detail', id] });
      queryClient.invalidateQueries({ queryKey: ['saved-views'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-stage'] });
      refetch();
    },
  });

  const activateHref = useMemo(() => {
    if (!data) {
      return `/dashboard?scopeKind=saved_view&scopeId=${id}`;
    }

    const params = new URLSearchParams({
      scopeKind: 'saved_view',
      scopeId: id,
    });

    if (data.resolvedScope.dateRange.start) params.set('from', data.resolvedScope.dateRange.start);
    if (data.resolvedScope.dateRange.end) params.set('to', data.resolvedScope.dateRange.end);
    if (data.resolvedScope.repositoryIds.length) {
      params.set('repositoryIds', data.resolvedScope.repositoryIds.join(','));
    }
    if (data.resolvedScope.contributorIds.length) {
      params.set('contributorIds', data.resolvedScope.contributorIds.join(','));
    }

    return `/dashboard?${params.toString()}`;
  }, [data, id]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isNotFound) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <p className="text-muted-foreground">{t('notFound')}</p>
        <Link href="/reports">
          <Button variant="outline">{t('back')}</Button>
        </Link>
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
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{data.savedView.name}</h1>
              {data.savedView.isArchived && (
                <Badge variant="secondary">{t('archivedBadge')}</Badge>
              )}
            </div>
            <p className="text-muted-foreground">{t('description')}</p>
          </div>
          <ScreenHelpTrigger
            screenTitle={t('help.title')}
            what={t('help.what')}
            how={t('help.how')}
            className="mt-1"
          />
        </div>
        <div className="flex gap-2">
          <Link href={`/reports`}>
            <Button variant="ghost">{t('back')}</Button>
          </Link>
          {!data.savedView.isArchived && (
            <Link href={activateHref}>
              <Button variant="outline">{t('activate')}</Button>
            </Link>
          )}
          <Button
            variant="outline"
            onClick={() => archiveMutation.mutate(data.savedView.isArchived ? 'restore' : 'archive')}
          >
            {data.savedView.isArchived ? t('restore') : t('archive')}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('settings.title')}</CardTitle>
          <CardDescription>{t('settings.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{t('settings.name')}</Label>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>{t('settings.visibility')}</Label>
            <Select value={visibility} onValueChange={(value) => setVisibility(value as 'PRIVATE' | 'WORKSPACE')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PRIVATE">{t('settings.private')}</SelectItem>
                <SelectItem value="WORKSPACE">{t('settings.workspace')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="md:col-span-2">
            <Button onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending || !name.trim()}>
              {updateMutation.isPending ? t('settings.saving') : t('settings.save')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('scope.title')}</CardTitle>
          <CardDescription>{t('scope.description')}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground">
          <div>{t('scope.kind', { value: data.resolvedScope.scopeKind })}</div>
          <div>{t('scope.teams', { count: data.resolvedScope.teamIds.length })}</div>
          <div>{t('scope.repositories', { count: data.resolvedScope.repositoryIds.length })}</div>
          <div>{t('scope.contributors', { count: data.resolvedScope.contributorIds.length })}</div>
          <div>{t('scope.range', {
            start: data.resolvedScope.dateRange.start ?? t('scope.none'),
            end: data.resolvedScope.dateRange.end ?? t('scope.none'),
          })}</div>
          {data.saveViewState && (
            <div className="pt-2 font-medium text-foreground">
              {data.saveViewState.isDirty ? t('scope.dirty') : t('scope.synced')}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
