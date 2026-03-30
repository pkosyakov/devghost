'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDistanceToNow } from 'date-fns';

interface TeamRepositoriesProps {
  teamId: string;
}

export function TeamRepositories({ teamId }: TeamRepositoriesProps) {
  const t = useTranslations('teamDetail.repositories');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [appliedFrom, setAppliedFrom] = useState('');
  const [appliedTo, setAppliedTo] = useState('');

  const queryParams = new URLSearchParams();
  if (appliedFrom) queryParams.set('from', appliedFrom);
  if (appliedTo) queryParams.set('to', appliedTo);

  const { data, isLoading } = useQuery({
    queryKey: ['team-repositories', teamId, appliedFrom, appliedTo],
    queryFn: async () => {
      const res = await fetch(`/api/v2/teams/${teamId}/repositories?${queryParams.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-4">
        <div className="space-y-1">
          <Label className="text-xs">{t('from')}</Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('to')}</Label>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-40"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setAppliedFrom(from);
            setAppliedTo(to);
          }}
        >
          {t('apply')}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : !data?.repositories?.length ? (
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
            {data.repositories.map((repo: any) => (
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
