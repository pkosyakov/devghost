'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft } from 'lucide-react';
import { TeamHeader } from './components/team-header';
import { TeamKpiSummary } from './components/team-kpi-summary';
import { TeamContributors, type Membership } from './components/team-contributors';
import { TeamRepositories } from './components/team-repositories';
import { AddMemberDialog } from './components/add-member-dialog';
import { EditMembershipDialog } from './components/edit-membership-dialog';

export default function TeamDetailPage() {
  const t = useTranslations('teamDetail');
  const { id } = useParams<{ id: string }>();
  const [editingMember, setEditingMember] = useState<Membership | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['team', id],
    queryFn: async () => {
      const res = await fetch(`/api/v2/teams/${id}`);
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
      <Link
        href="/teams"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <TeamHeader team={data.team} />

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
            existingContributorIds={data.contributors
              .filter((c: any) => !c.effectiveTo || new Date(c.effectiveTo) > new Date())
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
        <TeamRepositories teamId={id} />
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
