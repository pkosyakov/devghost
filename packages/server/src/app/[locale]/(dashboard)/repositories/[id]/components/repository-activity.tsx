'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatDistanceToNow } from 'date-fns';

interface CommitActivity {
  commitHash: string;
  commitMessage: string;
  authorEmail: string;
  authorName: string;
  authorDate: string;
  effortHours: number | string;
  category: string | null;
  complexity: string | null;
}

interface RepositoryActivityProps {
  commits: CommitActivity[];
}

const categoryColors: Record<string, string> = {
  feature: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  bugfix: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  refactor: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  docs: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  test: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  chore: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
};

export function RepositoryActivity({ commits }: RepositoryActivityProps) {
  const t = useTranslations('repositoryDetail.activity');

  if (commits.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">{t('empty')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('commit')}</TableHead>
              <TableHead>{t('author')}</TableHead>
              <TableHead>{t('category')}</TableHead>
              <TableHead>{t('effort')}</TableHead>
              <TableHead>{t('date')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {commits.map((c) => (
              <TableRow key={c.commitHash}>
                <TableCell>
                  <div className="max-w-[300px]">
                    <p className="font-mono text-xs text-muted-foreground">
                      {c.commitHash.slice(0, 7)}
                    </p>
                    <p className="text-sm truncate">{c.commitMessage}</p>
                  </div>
                </TableCell>
                <TableCell className="text-sm">{c.authorName}</TableCell>
                <TableCell>
                  {c.category ? (
                    <Badge className={categoryColors[c.category] || ''}>
                      {c.category}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  {Number(c.effortHours).toFixed(1)}h
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDistanceToNow(new Date(c.authorDate), { addSuffix: true })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
