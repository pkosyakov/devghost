'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { UsersRound, Users } from 'lucide-react';

interface TeamSummaryStripProps {
  teamCount: number;
  activeTeamCount: number;
  memberedContributorCount: number;
}

export function TeamSummaryStrip({ teamCount, activeTeamCount, memberedContributorCount }: TeamSummaryStripProps) {
  const t = useTranslations('teams.summary');

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <UsersRound className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{teamCount}</p>
            <p className="text-sm text-muted-foreground">{t('total')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <UsersRound className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{activeTeamCount}</p>
            <p className="text-sm text-muted-foreground">{t('active')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Users className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{memberedContributorCount}</p>
            <p className="text-sm text-muted-foreground">{t('members')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
