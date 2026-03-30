'use client';

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { IdentityHealthBadge } from '../../components/identity-health-badge';
import { MoreHorizontal } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface ContributorHeaderProps {
  contributor: {
    id: string;
    displayName: string;
    primaryEmail: string;
    classification: string;
    isExcluded: boolean;
  };
  identityHealth: { status: 'healthy' | 'attention' | 'unresolved'; unresolvedAliasCount: number };
  onMergeClick: () => void;
}

export function ContributorHeader({ contributor, identityHealth, onMergeClick }: ContributorHeaderProps) {
  const t = useTranslations('contributorDetail');
  const tFilters = useTranslations('people.filters');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const invalidateContributor = () => {
    queryClient.invalidateQueries({ queryKey: ['contributor', contributor.id] });
    queryClient.invalidateQueries({ queryKey: ['contributors'] });
  };

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
    onSuccess: invalidateContributor,
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
    onSuccess: invalidateContributor,
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
    onSuccess: invalidateContributor,
    onError: (err: Error) => toast({ variant: 'destructive', title: err.message }),
  });

  return (
    <div className="flex items-start justify-between">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{contributor.displayName}</h1>
          {contributor.isExcluded && (
            <Badge variant="destructive">{t('header.excluded')}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>{contributor.primaryEmail}</span>
          <span>·</span>
          <span>{tFilters(contributor.classification.toLowerCase())}</span>
        </div>
        <IdentityHealthBadge
          status={identityHealth.status}
          unresolvedCount={identityHealth.unresolvedAliasCount}
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            {t('header.actions')} <MoreHorizontal className="ml-2 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {contributor.isExcluded ? (
            <DropdownMenuItem onClick={() => includeMutation.mutate()}>
              {t('actions.include')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => excludeMutation.mutate()}>
              {t('actions.exclude')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t('actions.classify')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {['INTERNAL', 'EXTERNAL', 'BOT', 'FORMER_EMPLOYEE'].map((cls) => (
                <DropdownMenuItem key={cls} onClick={() => classifyMutation.mutate(cls)}>
                  {tFilters(cls.toLowerCase())}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={onMergeClick}>
            {t('actions.merge')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
