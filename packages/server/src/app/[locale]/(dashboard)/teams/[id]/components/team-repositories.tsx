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
import { formatDistanceToNow } from 'date-fns';

interface TeamRepositoriesProps {
  repositories: {
    repositoryId: string | null;
    fullName: string;
    activeCommitCount: number;
    activeContributorCount: number;
    lastActivityAt: string | Date | null;
  }[];
}

export function TeamRepositories({ repositories }: TeamRepositoriesProps) {
  const t = useTranslations('teamDetail.repositories');

  return (
    <div className="space-y-4">
      {!repositories?.length ? (
        <div className="text-center py-8">
          <p className="text-muted-foreground">{t('empty')}</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('commits')}</TableHead>
              <TableHead>{t('contributors')}</TableHead>
              <TableHead>{t('lastActivity')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {repositories.map((repo) => (
              <TableRow key={repo.fullName}>
                <TableCell>
                  {repo.repositoryId ? (
                    <Link
                      href={`/repositories/${repo.repositoryId}`}
                      className="font-medium hover:underline"
                    >
                      {repo.fullName}
                    </Link>
                  ) : (
                    <span className="font-medium">{repo.fullName}</span>
                  )}
                </TableCell>
                <TableCell>{repo.activeCommitCount}</TableCell>
                <TableCell>{repo.activeContributorCount}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {repo.lastActivityAt
                    ? formatDistanceToNow(new Date(repo.lastActivityAt), { addSuffix: true })
                    : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
