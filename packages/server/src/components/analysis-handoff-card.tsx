'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Users, FolderGit2, UsersRound, AlertCircle } from 'lucide-react';
import type { WorkspaceStage } from '@/hooks/use-workspace-stage';

interface AnalysisHandoffCardProps {
  analysisId: string;
  workspaceStage: WorkspaceStage;
  topCanonicalRepoId: string | null;
  unresolvedIdentityCount: number;
}

export function AnalysisHandoffCard({
  analysisId,
  workspaceStage,
  topCanonicalRepoId,
  unresolvedIdentityCount,
}: AnalysisHandoffCardProps) {
  const t = useTranslations('analysisResults');
  const fromParam = `fromAnalysis=${encodeURIComponent(analysisId)}`;

  const identityBanner = unresolvedIdentityCount > 0 && (
    <div className="flex items-center justify-between rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-2 dark:border-yellow-800 dark:bg-yellow-950">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-yellow-600" />
        <span className="text-sm">
          {t('handoff.identityBanner', { count: unresolvedIdentityCount })}
        </span>
      </div>
      <Button variant="outline" size="sm" asChild>
        <Link href={`/people?identityHealth=unresolved&${fromParam}`}>
          {t('handoff.peopleCta')}
        </Link>
      </Button>
    </div>
  );

  if (workspaceStage === 'first_data') {
    const teamHref = topCanonicalRepoId
      ? `/repositories/${topCanonicalRepoId}?${fromParam}`
      : `/repositories?${fromParam}`;
    const teamLabel = topCanonicalRepoId
      ? t('handoff.teamCta')
      : t('handoff.teamFallbackCta');

    return (
      <div className="space-y-3">
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="pt-6">
            <div className="space-y-3">
              <div>
                <p className="font-medium">{t('handoff.title')}</p>
                <p className="text-sm text-muted-foreground">{t('handoff.description')}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/people?${fromParam}`}>
                  <Button variant="default" size="sm">
                    <Users className="h-4 w-4 mr-2" />
                    {t('handoff.peopleCta')}
                  </Button>
                </Link>
                <Link href={`/repositories?${fromParam}`}>
                  <Button variant="outline" size="sm">
                    <FolderGit2 className="h-4 w-4 mr-2" />
                    {t('handoff.repositoriesCta')}
                  </Button>
                </Link>
                <Link href={teamHref}>
                  <Button variant="outline" size="sm">
                    <UsersRound className="h-4 w-4 mr-2" />
                    {teamLabel}
                  </Button>
                </Link>
              </div>
            </div>
          </CardContent>
        </Card>
        {identityBanner}
      </div>
    );
  }

  // operational: compact variant
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-lg border px-4 py-3 text-sm">
        <span className="text-muted-foreground">{t('handoff.operationalLabel')}</span>
        <Link
          href={`/people?${fromParam}`}
          className="font-medium text-primary hover:underline"
        >
          {t('handoff.operationalPeople')}
        </Link>
        <Link
          href={`/repositories?${fromParam}`}
          className="font-medium text-primary hover:underline"
        >
          {t('handoff.operationalRepositories')}
        </Link>
      </div>
      {identityBanner}
    </div>
  );
}
