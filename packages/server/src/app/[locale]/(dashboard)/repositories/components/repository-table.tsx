'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ArrowUpDown, Lock, Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatDistanceToNow } from 'date-fns';

interface Repository {
  id: string;
  provider: string;
  fullName: string;
  name: string;
  owner: string;
  language: string | null;
  stars: number;
  isPrivate: boolean;
  freshnessStatus: 'fresh' | 'stale' | 'never';
  lastAnalyzedAt: string | null;
  lastCommitAt: string | null;
  totalCommits: number;
  contributorCount: number;
}

interface RepositoryTableProps {
  repositories: Repository[];
  sort: string;
  sortOrder: string;
  onSortChange: (field: string) => void;
}

const freshnessColors: Record<string, string> = {
  fresh: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  stale: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  never: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
};

export function RepositoryTable({
  repositories,
  sort,
  sortOrder,
  onSortChange,
}: RepositoryTableProps) {
  const t = useTranslations('repositories.table');

  const SortHeader = ({ field, children }: { field: string; children: React.ReactNode }) => (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 font-medium"
      onClick={() => onSortChange(field)}
    >
      {children}
      <ArrowUpDown className="ml-1 h-3.5 w-3.5" />
      {sort === field && (
        <span className="ml-0.5 text-xs">{sortOrder === 'asc' ? '\u2191' : '\u2193'}</span>
      )}
    </Button>
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <SortHeader field="fullName">{t('repository')}</SortHeader>
          </TableHead>
          <TableHead>{t('language')}</TableHead>
          <TableHead>
            <SortHeader field="totalCommits">{t('commits')}</SortHeader>
          </TableHead>
          <TableHead>
            <SortHeader field="contributorCount">{t('contributors')}</SortHeader>
          </TableHead>
          <TableHead>{t('freshness')}</TableHead>
          <TableHead>
            <SortHeader field="lastAnalyzedAt">{t('lastAnalyzed')}</SortHeader>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {repositories.map((repo) => (
          <TableRow key={repo.id}>
            <TableCell>
              <Link
                href={`/repositories/${repo.id}`}
                className="font-medium hover:underline flex items-center gap-1.5"
              >
                {repo.isPrivate ? (
                  <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                {repo.fullName}
              </Link>
            </TableCell>
            <TableCell>
              {repo.language ? (
                <Badge variant="outline" className="text-xs">
                  {repo.language}
                </Badge>
              ) : (
                <span className="text-muted-foreground">-</span>
              )}
            </TableCell>
            <TableCell>{repo.totalCommits}</TableCell>
            <TableCell>{repo.contributorCount}</TableCell>
            <TableCell>
              <Badge className={freshnessColors[repo.freshnessStatus]}>
                {t(`freshnessStatus.${repo.freshnessStatus}`)}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {repo.lastAnalyzedAt
                ? formatDistanceToNow(new Date(repo.lastAnalyzedAt), { addSuffix: true })
                : t('neverAnalyzed')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
