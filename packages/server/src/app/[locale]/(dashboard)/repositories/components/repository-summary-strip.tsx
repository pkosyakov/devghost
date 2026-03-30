'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { FolderGit2, Clock, AlertCircle, CircleSlash } from 'lucide-react';

interface RepositorySummaryStripProps {
  totalRepositories: number;
  freshCount: number;
  staleCount: number;
  neverCount: number;
}

export function RepositorySummaryStrip({
  totalRepositories,
  freshCount,
  staleCount,
  neverCount,
}: RepositorySummaryStripProps) {
  const t = useTranslations('repositories.summary');

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <FolderGit2 className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{totalRepositories}</p>
            <p className="text-sm text-muted-foreground">{t('total')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Clock className="h-5 w-5 text-green-500" />
          <div>
            <p className="text-2xl font-bold">{freshCount}</p>
            <p className="text-sm text-muted-foreground">{t('fresh')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <AlertCircle className="h-5 w-5 text-yellow-500" />
          <div>
            <p className="text-2xl font-bold">{staleCount}</p>
            <p className="text-sm text-muted-foreground">{t('stale')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <CircleSlash className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{neverCount}</p>
            <p className="text-sm text-muted-foreground">{t('never')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
