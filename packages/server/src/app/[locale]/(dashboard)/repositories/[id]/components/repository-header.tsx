'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Lock, Globe, ExternalLink } from 'lucide-react';

interface RepositoryHeaderProps {
  repository: {
    fullName: string;
    provider: string;
    language: string | null;
    stars: number;
    isPrivate: boolean;
    defaultBranch: string | null;
    url: string | null;
    freshnessStatus: 'fresh' | 'stale' | 'never';
    lastAnalyzedAt: string | null;
  };
}

const freshnessColors: Record<string, string> = {
  fresh: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  stale: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  never: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
};

export function RepositoryHeader({ repository }: RepositoryHeaderProps) {
  const t = useTranslations('repositoryDetail.header');

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        {repository.isPrivate ? (
          <Lock className="h-5 w-5 text-muted-foreground" />
        ) : (
          <Globe className="h-5 w-5 text-muted-foreground" />
        )}
        <h1 className="text-2xl font-bold">{repository.fullName}</h1>
        {repository.url && (
          <a
            href={repository.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge className={freshnessColors[repository.freshnessStatus]}>
          {t(`freshness.${repository.freshnessStatus}`)}
        </Badge>
        {repository.language && (
          <Badge variant="outline">{repository.language}</Badge>
        )}
        <Badge variant="outline">{repository.provider}</Badge>
        {repository.defaultBranch && (
          <Badge variant="outline">{repository.defaultBranch}</Badge>
        )}
      </div>
    </div>
  );
}
