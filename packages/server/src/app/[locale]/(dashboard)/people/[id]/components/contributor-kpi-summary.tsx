'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { GitCommitHorizontal, FolderGit2, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface ContributorKpiSummaryProps {
  totalCommits: number;
  activeRepositoryCount: number;
  lastActivityAt: string | null;
}

export function ContributorKpiSummary({
  totalCommits,
  activeRepositoryCount,
  lastActivityAt,
}: ContributorKpiSummaryProps) {
  const t = useTranslations('contributorDetail.kpi');

  return (
    <div className="grid grid-cols-3 gap-4">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <GitCommitHorizontal className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{totalCommits}</p>
            <p className="text-sm text-muted-foreground">{t('commits')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <FolderGit2 className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{activeRepositoryCount}</p>
            <p className="text-sm text-muted-foreground">{t('repositories')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Clock className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">
              {lastActivityAt
                ? formatDistanceToNow(new Date(lastActivityAt), { addSuffix: true })
                : '—'}
            </p>
            <p className="text-sm text-muted-foreground">{t('lastActivity')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
