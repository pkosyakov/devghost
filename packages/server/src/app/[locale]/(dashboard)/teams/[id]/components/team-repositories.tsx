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
  scopeFrom: string;
  scopeTo: string;
  onScopeChange: (from: string, to: string) => void;
}

export function TeamRepositories({ teamId, scopeFrom, scopeTo, onScopeChange }: TeamRepositoriesProps) {
  const t = useTranslations('teamDetail.repositories');
  // Local draft state for the date inputs; applied on button click
  const [draftFrom, setDraftFrom] = useState(scopeFrom);
  const [draftTo, setDraftTo] = useState(scopeTo);

  const queryParams = new URLSearchParams();
  if (scopeFrom) queryParams.set('from', scopeFrom);
  if (scopeTo) queryParams.set('to', scopeTo);

  const { data, isLoading } = useQuery({
    queryKey: ['team-repositories', teamId, scopeFrom, scopeTo],
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
            value={draftFrom}
            onChange={(e) => setDraftFrom(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('to')}</Label>
          <Input
            type="date"
            value={draftTo}
            onChange={(e) => setDraftTo(e.target.value)}
            className="w-40"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onScopeChange(draftFrom, draftTo)}
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
