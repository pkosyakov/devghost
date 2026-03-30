'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, Save } from 'lucide-react';
import { pickActiveScopeParams } from '@/lib/active-scope';
import { useWorkspaceStage } from '@/hooks/use-workspace-stage';
import { SaveViewDialog } from '@/components/layout/save-view-dialog';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { ScreenHelpTrigger } from '@/components/layout/screen-help-trigger';
import { TeamHeader } from './components/team-header';
import { TeamKpiSummary } from './components/team-kpi-summary';
import { TeamContributors, type Membership } from './components/team-contributors';
import { TeamRepositories } from './components/team-repositories';
import { AddMemberDialog } from './components/add-member-dialog';
import { EditMembershipDialog } from './components/edit-membership-dialog';

export default function TeamDetailPage() {
  const t = useTranslations('teamDetail');
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const [editingMember, setEditingMember] = useState<Membership | null>(null);
  const scopeQs = useMemo(() => pickActiveScopeParams(searchParams).toString(), [searchParams]);
  const isFirstTeamOnboarding = searchParams.get('onboarding') === 'first-team';
  const { data: stageData } = useWorkspaceStage();
  const showSaveViewPrompt = isFirstTeamOnboarding && stageData?.onboarding?.needsFirstSavedView;
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);

  const activeScopePayload = useMemo(() => {
    const raw = activeScopeQuerySchema.safeParse(Object.fromEntries(searchParams.entries()));
    const scope = raw.success ? raw.data : {
      scopeKind: 'team' as const,
      scopeId: id,
      from: undefined,
      to: undefined,
      repositoryIds: [] as string[],
      contributorIds: [] as string[],
    };
    return {
      scopeKind: scope.scopeKind || ('team' as const),
      scopeId: scope.scopeId || id,
      from: scope.from,
      to: scope.to,
      repositoryIds: scope.repositoryIds,
      contributorIds: scope.contributorIds,
    };
  }, [searchParams, id]);

  const backHref = useMemo(() => {
    const serialized = pickActiveScopeParams(searchParams).toString();
    return serialized ? `/teams?${serialized}` : '/teams';
  }, [searchParams]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['team', id, scopeQs],
    queryFn: async () => {
      const url = `/api/v2/teams/${id}${scopeQs ? '?' + scopeQs : ''}`;
      const res = await fetch(url);
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
      <div className="flex items-center justify-between gap-3">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('backToList')}
        </Link>
        <ScreenHelpTrigger
          screenTitle={t('help.title')}
          what={t('help.what')}
          how={t('help.how')}
        />
      </div>

      <TeamHeader team={data.team} />

      {isFirstTeamOnboarding && (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-1">
              <p className="font-medium">{t('onboarding.title')}</p>
              <p className="text-sm text-muted-foreground">{t('onboarding.description')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href={`/dashboard?scopeKind=team&scopeId=${id}`}>
                <Button>{t('onboarding.openHome')}</Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      )}

      {showSaveViewPrompt && (
        <>
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="flex flex-col gap-3 pt-6 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-1">
                <p className="font-medium">{t('onboarding.saveViewTitle')}</p>
                <p className="text-sm text-muted-foreground">{t('onboarding.saveViewDescription')}</p>
              </div>
              <Button onClick={() => setSaveDialogOpen(true)}>
                <Save className="h-4 w-4 mr-2" />
                {t('onboarding.saveViewCta')}
              </Button>
            </CardContent>
          </Card>
          <SaveViewDialog
            open={saveDialogOpen}
            onOpenChange={setSaveDialogOpen}
            activeScope={activeScopePayload}
          />
        </>
      )}

      <TeamKpiSummary
        memberCount={data.summaryMetrics.memberCount}
        repositoryCount={data.summaryMetrics.activeRepositoryCount}
        lastActivityAt={data.summaryMetrics.lastActivityAt}
      />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('members.title')}</h2>
          <AddMemberDialog
            teamId={id}
            scopeQueryString={scopeQs}
            repositoryOptions={data.repositories.map((repository: any) => repository.fullName)}
            existingContributorIds={data.contributors
              .filter((c: any) => new Date(c.effectiveFrom) <= new Date() && (!c.effectiveTo || new Date(c.effectiveTo) > new Date()))
              .map((c: any) => c.contributorId)}
          />
        </div>
        <TeamContributors
          teamId={id}
          contributors={data.contributors}
          onEditMember={setEditingMember}
        />
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t('repositories.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('repositories.description')}</p>
        <TeamRepositories repositories={data.repositories} />
      </div>

      <EditMembershipDialog
        teamId={id}
        membership={editingMember}
        open={!!editingMember}
        onOpenChange={(open) => { if (!open) setEditingMember(null); }}
      />
    </div>
  );
}
