'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SelectGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { SaveViewDialog } from '@/components/layout/save-view-dialog';
import { pickActiveScopeParams } from '@/lib/active-scope';
import { useWorkspaceStage } from '@/hooks/use-workspace-stage';

function isPrimaryAnalyticalPath(pathname: string): boolean {
  return pathname === '/dashboard'
    || pathname === '/teams'
    || /^\/teams\/[^/]+$/.test(pathname)
    || pathname === '/people'
    || pathname === '/repositories'
    || pathname === '/reports'
    || /^\/reports\/[^/]+$/.test(pathname);
}

export function GlobalContextBar() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useParams<{ id?: string }>();
  const t = useTranslations('scope.bar');
  const isAnalyticalPath = isPrimaryAnalyticalPath(pathname);

  // undefined = data not yet loaded → default to showing chrome (avoids regressing mature users)
  const { data: stageData } = useWorkspaceStage();
  const isEarlyStage = stageData?.workspaceStage === 'empty' || stageData?.workspaceStage === 'first_data';

  const [saveDialogOpen, setSaveDialogOpen] = useState(false);

  const routeTeamId = /^\/teams\/[^/]+$/.test(pathname) ? params.id ?? undefined : undefined;
  const rawScope = activeScopeQuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
  const currentScope = rawScope.success ? rawScope.data : {
    scopeKind: 'all_teams' as const,
    scopeId: undefined,
    from: undefined,
    to: undefined,
    repositoryIds: [],
    contributorIds: [],
  };

  const effectiveScope = routeTeamId
    ? { ...currentScope, scopeKind: 'team' as const, scopeId: routeTeamId }
    : currentScope;

  const [draftFrom, setDraftFrom] = useState(effectiveScope.from ?? '');
  const [draftTo, setDraftTo] = useState(effectiveScope.to ?? '');

  useEffect(() => {
    setDraftFrom(effectiveScope.from ?? '');
    setDraftTo(effectiveScope.to ?? '');
  }, [effectiveScope.from, effectiveScope.to]);

  const teamsQuery = useQuery({
    queryKey: ['scope-teams'],
    enabled: isAnalyticalPath,
    queryFn: async () => {
      const res = await fetch('/api/v2/teams?page=1&pageSize=100&sort=name&sortOrder=asc');
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data.teams as { teamId: string; name: string }[];
    },
  });

  const savedViewsQuery = useQuery({
    queryKey: ['scope-saved-views'],
    enabled: isAnalyticalPath,
    queryFn: async () => {
      const res = await fetch('/api/v2/saved-views?page=1&pageSize=100&sort=updatedAt&sortOrder=desc');
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data.savedViews as {
        savedViewId: string;
        name: string;
        visibility: 'PRIVATE' | 'WORKSPACE';
      }[];
    },
  });

  const activeSavedViewQuery = useQuery({
    queryKey: ['saved-view-active', effectiveScope.scopeKind, effectiveScope.scopeId, pickActiveScopeParams(searchParams).toString()],
    enabled: isAnalyticalPath && effectiveScope.scopeKind === 'saved_view' && !!effectiveScope.scopeId,
    queryFn: async () => {
      const scopeQs = pickActiveScopeParams(searchParams).toString();
      const res = await fetch(`/api/v2/saved-views/${effectiveScope.scopeId}${scopeQs ? `?${scopeQs}` : ''}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data as { saveViewState?: { isDirty: boolean } | null };
    },
  });

  const selectedScopeValue = useMemo(() => {
    if (routeTeamId) return `team:${routeTeamId}`;
    if (effectiveScope.scopeKind === 'team' && effectiveScope.scopeId) return `team:${effectiveScope.scopeId}`;
    if (effectiveScope.scopeKind === 'saved_view' && effectiveScope.scopeId) return `saved_view:${effectiveScope.scopeId}`;
    return 'all_teams';
  }, [effectiveScope.scopeId, effectiveScope.scopeKind, routeTeamId]);

  const currentTeamName = teamsQuery.data?.find((team) => team.teamId === routeTeamId)?.name;
  const isDirty = activeSavedViewQuery.data?.saveViewState?.isDirty ?? false;
  const isUnavailableSavedView = effectiveScope.scopeKind === 'saved_view'
    && !!effectiveScope.scopeId
    && activeSavedViewQuery.isError;

  const replaceScope = (nextParams: URLSearchParams) => {
    const serialized = nextParams.toString();
    router.replace(serialized ? `${pathname}?${serialized}` : pathname);
  };

  const applyDateRange = () => {
    const nextParams = new URLSearchParams(searchParams.toString());

    if (draftFrom) nextParams.set('from', draftFrom);
    else nextParams.delete('from');

    if (draftTo) nextParams.set('to', draftTo);
    else nextParams.delete('to');

    if (routeTeamId) {
      nextParams.set('scopeKind', 'team');
      nextParams.set('scopeId', routeTeamId);
    }

    replaceScope(nextParams);
  };

  const handleScopeChange = async (value: string) => {
    const nextParams = routeTeamId
      ? pickActiveScopeParams(searchParams)
      : new URLSearchParams(searchParams.toString());
    nextParams.delete('repositoryIds');
    nextParams.delete('contributorIds');

    if (value === 'all_teams') {
      if (routeTeamId) {
        nextParams.delete('scopeKind');
        nextParams.delete('scopeId');
        router.replace(nextParams.toString() ? `/teams?${nextParams.toString()}` : '/teams');
        return;
      }
      nextParams.delete('scopeKind');
      nextParams.delete('scopeId');
      replaceScope(nextParams);
      return;
    }

    const [kind, id] = value.split(':');
    if (kind === 'team') {
      nextParams.set('scopeKind', 'team');
      nextParams.set('scopeId', id);
      if (routeTeamId) {
        const serialized = nextParams.toString();
        router.replace(serialized ? `/teams/${id}?${serialized}` : `/teams/${id}`);
        return;
      }
      replaceScope(nextParams);
      return;
    }

    const res = await fetch(`/api/v2/saved-views/${id}`);
    const json = await res.json();
    if (!res.ok || !json.success) return;

    nextParams.set('scopeKind', 'saved_view');
    nextParams.set('scopeId', id);

    const resolvedScope = json.data.resolvedScope;
    if (resolvedScope.dateRange.start) nextParams.set('from', resolvedScope.dateRange.start);
    else nextParams.delete('from');
    if (resolvedScope.dateRange.end) nextParams.set('to', resolvedScope.dateRange.end);
    else nextParams.delete('to');

    if (resolvedScope.repositoryIds?.length) {
      nextParams.set('repositoryIds', resolvedScope.repositoryIds.join(','));
    } else {
      nextParams.delete('repositoryIds');
    }

    if (resolvedScope.contributorIds?.length) {
      nextParams.set('contributorIds', resolvedScope.contributorIds.join(','));
    } else {
      nextParams.delete('contributorIds');
    }

    replaceScope(nextParams);
  };

  if (!isAnalyticalPath || isEarlyStage) {
    return null;
  }

  const activeScopePayload = {
    scopeKind: effectiveScope.scopeKind,
    scopeId: effectiveScope.scopeId,
    from: effectiveScope.from,
    to: effectiveScope.to,
    repositoryIds: effectiveScope.repositoryIds,
    contributorIds: effectiveScope.contributorIds,
  };

  return (
    <>
      <div className="mb-6 rounded-xl border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="grid flex-1 gap-4 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('scope')}
              </p>

              {routeTeamId ? (
                <Select value={selectedScopeValue} onValueChange={handleScopeChange}>
                  <SelectTrigger>
                    <SelectValue placeholder={currentTeamName ?? t('loading')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>{t('teams')}</SelectLabel>
                      {teamsQuery.data?.map((team) => (
                        <SelectItem key={team.teamId} value={`team:${team.teamId}`}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              ) : (
                <Select value={selectedScopeValue} onValueChange={handleScopeChange}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all_teams">{t('allTeams')}</SelectItem>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>{t('teams')}</SelectLabel>
                      {teamsQuery.data?.map((team) => (
                        <SelectItem key={team.teamId} value={`team:${team.teamId}`}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>{t('savedViews')}</SelectLabel>
                      {savedViewsQuery.data?.map((savedView) => (
                        <SelectItem key={savedView.savedViewId} value={`saved_view:${savedView.savedViewId}`}>
                          {savedView.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('from')}
              </p>
              <Input type="date" value={draftFrom} onChange={(event) => setDraftFrom(event.target.value)} />
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('to')}
              </p>
              <Input type="date" value={draftTo} onChange={(event) => setDraftTo(event.target.value)} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isUnavailableSavedView ? (
              <Badge variant="destructive">
                {t('savedViewUnavailable')}
              </Badge>
            ) : effectiveScope.scopeKind === 'saved_view' && (
              <Badge variant={isDirty ? 'secondary' : 'outline'}>
                {isDirty ? t('unsavedChanges') : t('savedView')}
              </Badge>
            )}

            <Button variant="outline" onClick={applyDateRange}>
              {t('apply')}
            </Button>
            <Button onClick={() => setSaveDialogOpen(true)}>
              {t('saveView')}
            </Button>
          </div>
        </div>
      </div>

      <SaveViewDialog
        open={saveDialogOpen}
        onOpenChange={setSaveDialogOpen}
        activeScope={activeScopePayload}
      />
    </>
  );
}
