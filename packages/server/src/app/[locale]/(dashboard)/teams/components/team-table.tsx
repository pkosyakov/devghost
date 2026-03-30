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
import { Button } from '@/components/ui/button';
import { ArrowUpDown } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface TeamRow {
  teamId: string;
  name: string;
  description: string | null;
  memberCount: number;
  activeRepositoryCount: number;
  lastActivityAt: string | null;
  healthStatus: string | null;
  createdAt: string;
}

interface TeamTableProps {
  teams: TeamRow[];
  sort: string;
  sortOrder: string;
  onSortChange: (field: string) => void;
}

export function TeamTable({ teams, sort, sortOrder, onSortChange }: TeamTableProps) {
  const t = useTranslations('teams.table');

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
            <SortHeader field="name">{t('name')}</SortHeader>
          </TableHead>
          <TableHead>
            <SortHeader field="memberCount">{t('members')}</SortHeader>
          </TableHead>
          <TableHead>
            <SortHeader field="activeRepositoryCount">{t('repositories')}</SortHeader>
          </TableHead>
          <TableHead>
            <SortHeader field="lastActivityAt">{t('lastActivity')}</SortHeader>
          </TableHead>
          <TableHead>
            <SortHeader field="createdAt">{t('created')}</SortHeader>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {teams.map((team) => (
          <TableRow key={team.teamId}>
            <TableCell>
              <Link
                href={`/teams/${team.teamId}`}
                className="font-medium hover:underline"
              >
                {team.name}
              </Link>
              {team.description && (
                <p className="text-sm text-muted-foreground truncate max-w-md">
                  {team.description}
                </p>
              )}
            </TableCell>
            <TableCell>{team.memberCount}</TableCell>
            <TableCell>{team.activeRepositoryCount}</TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {team.lastActivityAt
                ? formatDistanceToNow(new Date(team.lastActivityAt), { addSuffix: true })
                : '-'}
            </TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {formatDistanceToNow(new Date(team.createdAt), { addSuffix: true })}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
