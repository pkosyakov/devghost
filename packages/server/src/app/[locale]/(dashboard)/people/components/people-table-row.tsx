'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TableCell, TableRow } from '@/components/ui/table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { MoreHorizontal } from 'lucide-react';
import { IdentityHealthBadge } from './identity-health-badge';
import { useToast } from '@/hooks/use-toast';
import { formatDistanceToNow } from 'date-fns';

interface ContributorRow {
  id: string;
  displayName: string;
  primaryEmail: string;
  classification: string;
  isExcluded: boolean;
  identityHealth: { status: 'healthy' | 'attention' | 'unresolved'; unresolvedAliasCount: number };
  aliasCount: number;
  lastActivityAt: string;
}

interface PeopleTableRowProps {
  contributor: ContributorRow;
  searchParams: string;
}

export function PeopleTableRow({ contributor, searchParams }: PeopleTableRowProps) {
  const t = useTranslations('people.actions');
  const tFilters = useTranslations('people.filters');
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const excludeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/contributors/${contributor.id}/exclude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contributors'] }),
    onError: (err: Error) => toast({ variant: 'destructive', title: err.message }),
  });

  const includeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/contributors/${contributor.id}/include`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contributors'] }),
    onError: (err: Error) => toast({ variant: 'destructive', title: err.message }),
  });

  const classifyMutation = useMutation({
    mutationFn: async (classification: string) => {
      const res = await fetch(`/api/v2/contributors/${contributor.id}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classification }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contributors'] }),
    onError: (err: Error) => toast({ variant: 'destructive', title: err.message }),
  });

  const handleNavigate = () => {
    router.push(`/people/${contributor.id}?from=${encodeURIComponent(searchParams)}`);
  };

  return (
    <TableRow className="cursor-pointer" onClick={handleNavigate}>
      <TableCell className="font-medium">{contributor.displayName}</TableCell>
      <TableCell>{contributor.primaryEmail}</TableCell>
      <TableCell>{tFilters(contributor.classification.toLowerCase())}</TableCell>
      <TableCell>
        <IdentityHealthBadge
          status={contributor.identityHealth.status}
          unresolvedCount={contributor.identityHealth.unresolvedAliasCount}
        />
      </TableCell>
      <TableCell>{contributor.aliasCount}</TableCell>
      <TableCell>
        {contributor.lastActivityAt
          ? formatDistanceToNow(new Date(contributor.lastActivityAt), { addSuffix: true })
          : '—'}
      </TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleNavigate}>
              {t('viewDetail')}
            </DropdownMenuItem>
            {contributor.isExcluded ? (
              <DropdownMenuItem onClick={() => includeMutation.mutate()}>
                {t('include')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => excludeMutation.mutate()}>
                {t('exclude')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t('classifyAs')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {['INTERNAL', 'EXTERNAL', 'BOT', 'FORMER_EMPLOYEE'].map((cls) => (
                  <DropdownMenuItem
                    key={cls}
                    onClick={() => classifyMutation.mutate(cls)}
                  >
                    {tFilters(cls.toLowerCase())}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
