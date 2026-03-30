'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { Users } from 'lucide-react';

type RepositoryContributor = {
  contributor: {
    id: string;
    displayName: string;
    primaryEmail: string;
    isExcluded: boolean;
  };
  commitCount: number;
  lastActivityAt: string;
};

interface CreateTeamFromRepositoryDialogProps {
  repositoryId: string;
  repositoryName: string;
  contributors: RepositoryContributor[];
}

const RECENT_ACTIVITY_LOOKBACK_DAYS = 90;

function buildDefaultTeamName(repositoryName: string) {
  const fromSlash = repositoryName.includes('/') ? repositoryName.split('/').pop() ?? repositoryName : repositoryName;
  return fromSlash.replace(/[-_]+/g, ' ').trim() || repositoryName;
}

export function CreateTeamFromRepositoryDialog({
  repositoryId,
  repositoryName,
  contributors,
}: CreateTeamFromRepositoryDialogProps) {
  const t = useTranslations('repositoryDetail.createTeam');
  const tCommon = useTranslations('common');
  const { toast } = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();

  const initialName = useMemo(() => buildDefaultTeamName(repositoryName), [repositoryName]);
  const selectableContributors = useMemo(
    () => contributors.filter((item) => !item.contributor.isExcluded),
    [contributors],
  );
  const suggestedContributorIds = useMemo(() => {
    if (selectableContributors.length === 0) return [];

    const activityTimes = selectableContributors
      .map((item) => new Date(item.lastActivityAt).getTime())
      .filter((value) => Number.isFinite(value));

    if (activityTimes.length === 0) {
      return selectableContributors.map((item) => item.contributor.id);
    }

    const latestActivity = Math.max(...activityTimes);
    const cutoff = latestActivity - (RECENT_ACTIVITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const suggested = selectableContributors
      .filter((item) => new Date(item.lastActivityAt).getTime() >= cutoff)
      .map((item) => item.contributor.id);

    return suggested.length > 0
      ? suggested
      : selectableContributors.map((item) => item.contributor.id);
  }, [selectableContributors]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setSelectedIds(suggestedContributorIds);
  }, [open, initialName, suggestedContributorIds]);

  const toggleContributor = (contributorId: string, checked: boolean) => {
    setSelectedIds((prev) => {
      if (checked) return Array.from(new Set([...prev, contributorId]));
      return prev.filter((id) => id !== contributorId);
    });
  };

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/repositories/${repositoryId}/create-team`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          contributorIds: selectedIds,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || t('error'));
      }
      return json.data as { id: string };
    },
    onSuccess: (team) => {
      toast({ description: t('success') });
      queryClient.invalidateQueries({ queryKey: ['workspace-stage'] });
      setOpen(false);
      router.push(`/teams/${team.id}?scopeKind=team&scopeId=${team.id}&onboarding=first-team`);
    },
    onError: (err: Error) => {
      toast({
        variant: 'destructive',
        description: err.message || t('error'),
      });
    },
  });

  const allSelectableCount = selectableContributors.length;
  const allSelected = allSelectableCount > 0 && selectedIds.length === allSelectableCount;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2">
          <Users className="h-4 w-4" />
          {t('cta')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="team-name">{t('name')}</Label>
            <Input
              id="team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              required
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label>{t('contributors')}</Label>
                <p className="text-xs text-muted-foreground">{t('recentHint')}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(
                  allSelected ? [] : selectableContributors.map((c) => c.contributor.id),
                )}
              >
                {allSelected ? t('clearAll') : t('selectAll')}
              </Button>
            </div>
            {contributors.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('emptyContributors')}</p>
            ) : (
              <ScrollArea className="h-60 rounded-md border p-3">
                <div className="space-y-3">
                  {contributors.map((item) => {
                    const checked = selectedIds.includes(item.contributor.id);
                    return (
                      <label
                        key={item.contributor.id}
                        className="flex cursor-pointer items-start gap-3 rounded-md p-2 hover:bg-muted/60"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(value) => toggleContributor(item.contributor.id, Boolean(value))}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{item.contributor.displayName}</p>
                          <p className="truncate text-xs text-muted-foreground">{item.contributor.primaryEmail}</p>
                          <p className="text-xs text-muted-foreground">
                            {t('commits', { count: item.commitCount })}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={!name.trim() || mutation.isPending}>
              {mutation.isPending ? t('creating') : t('submit')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
