'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
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

interface Contributor {
  contributor: {
    id: string;
    displayName: string;
    primaryEmail: string;
    classification: string;
    isExcluded: boolean;
  };
  commitCount: number;
  lastActivityAt: string;
}

interface UnresolvedContributor {
  email: string;
  name: string | null;
  commitCount: number;
  lastActivityAt: string;
}

interface RepositoryContributorsProps {
  contributors: Contributor[];
  unresolvedContributors?: UnresolvedContributor[];
}

const classificationColors: Record<string, string> = {
  INTERNAL: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  EXTERNAL: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  BOT: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  FORMER_EMPLOYEE: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
};

export function RepositoryContributors({
  contributors,
  unresolvedContributors = [],
}: RepositoryContributorsProps) {
  const t = useTranslations('repositoryDetail.contributors');
  const totalCount = contributors.length + unresolvedContributors.length;

  if (totalCount === 0) {
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
        <CardTitle>{t('title')} ({totalCount})</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('classification')}</TableHead>
              <TableHead>{t('commits')}</TableHead>
              <TableHead>{t('lastActivity')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {contributors.map((c) => (
              <TableRow key={c.contributor.id}>
                <TableCell>
                  <Link
                    href={`/people/${c.contributor.id}`}
                    className="font-medium hover:underline"
                  >
                    {c.contributor.displayName}
                  </Link>
                  <p className="text-xs text-muted-foreground">{c.contributor.primaryEmail}</p>
                </TableCell>
                <TableCell>
                  <Badge className={classificationColors[c.contributor.classification] || ''}>
                    {c.contributor.classification}
                  </Badge>
                </TableCell>
                <TableCell>{c.commitCount}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDistanceToNow(new Date(c.lastActivityAt), { addSuffix: true })}
                </TableCell>
              </TableRow>
            ))}
            {unresolvedContributors.map((c) => (
              <TableRow key={c.email} className="opacity-70">
                <TableCell>
                  <span className="font-medium">{c.name || c.email}</span>
                  {c.name && (
                    <p className="text-xs text-muted-foreground">{c.email}</p>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{t('unresolved')}</Badge>
                </TableCell>
                <TableCell>{c.commitCount}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDistanceToNow(new Date(c.lastActivityAt), { addSuffix: true })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
