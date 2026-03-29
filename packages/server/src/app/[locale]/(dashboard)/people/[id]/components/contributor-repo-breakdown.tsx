'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDistanceToNow } from 'date-fns';

interface RepoEntry {
  repoName: string;
  commitCount: number;
  lastActivityAt: string;
}

interface ContributorRepoBreakdownProps {
  repositories: RepoEntry[];
}

export function ContributorRepoBreakdown({ repositories }: ContributorRepoBreakdownProps) {
  const t = useTranslations('contributorDetail.repos');

  if (repositories.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('commits')}</TableHead>
              <TableHead>{t('lastActivity')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {repositories.map((repo) => (
              <TableRow key={repo.repoName}>
                <TableCell className="font-medium">{repo.repoName}</TableCell>
                <TableCell>{repo.commitCount}</TableCell>
                <TableCell>
                  {formatDistanceToNow(new Date(repo.lastActivityAt), { addSuffix: true })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
