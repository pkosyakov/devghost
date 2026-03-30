'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Users, AlertCircle, EyeOff } from 'lucide-react';

interface PeopleSummaryStripProps {
  totalContributors: number;
  unresolvedCount: number;
  excludedCount: number;
  onUnresolvedClick: () => void;
}

export function PeopleSummaryStrip({
  totalContributors,
  unresolvedCount,
  excludedCount,
  onUnresolvedClick,
}: PeopleSummaryStripProps) {
  const t = useTranslations('people.summary');

  return (
    <div className="grid grid-cols-3 gap-4">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Users className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{totalContributors}</p>
            <p className="text-sm text-muted-foreground">{t('total')}</p>
          </div>
        </CardContent>
      </Card>

      <Card
        className="cursor-pointer hover:border-yellow-500/50 transition-colors"
        onClick={onUnresolvedClick}
      >
        <CardContent className="flex items-center gap-3 p-4">
          <AlertCircle className="h-5 w-5 text-yellow-600" />
          <div>
            <p className="text-2xl font-bold">{unresolvedCount}</p>
            <p className="text-sm text-muted-foreground">{t('unresolved')}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <EyeOff className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{excludedCount}</p>
            <p className="text-sm text-muted-foreground">{t('excluded')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
