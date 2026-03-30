'use client';

import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { ChevronDown, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface AddMemberDialogProps {
  teamId: string;
  existingContributorIds: string[];
  repositoryOptions: string[];
  scopeQueryString?: string;
}

interface MemberCandidate {
  contributorId: string;
  displayName: string;
  primaryEmail: string;
  classification: 'INTERNAL' | 'EXTERNAL' | 'BOT' | 'FORMER_EMPLOYEE';
  isExcluded: boolean;
  commitCount: number;
  activeRepositoryCount: number;
  repositoryNames: string[];
  firstActivityAt: string | null;
  lastActivityAt: string | null;
}

export function AddMemberDialog({
  teamId,
  existingContributorIds,
  repositoryOptions,
  scopeQueryString,
}: AddMemberDialogProps) {
  const t = useTranslations('teamDetail.addMember');
  const tCommon = useTranslations('common');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [repository, setRepository] = useState('all');
  const [classification, setClassification] = useState('all');
  const [sort, setSort] = useState<'activity' | 'commits' | 'name' | 'repositories'>('activity');
  const [selectedId, setSelectedId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [role, setRole] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const deferredSearch = useDeferredValue(search);

  const { data: candidatesData, isLoading: isLoadingCandidates } = useQuery({
    queryKey: ['team-member-candidates', teamId, scopeQueryString, repository],
    queryFn: async () => {
      const params = new URLSearchParams(scopeQueryString ?? '');
      if (repository !== 'all') params.set('repository', repository);
      else params.delete('repository');

      const res = await fetch(`/api/v2/teams/${teamId}/member-candidates?${params.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.success) return { candidates: [] };
      return json.data;
    },
    enabled: open,
    staleTime: 30_000,
  });

  const availableCandidates = useMemo(() => {
    const searchNeedle = deferredSearch.trim().toLowerCase();
    const rows = ((candidatesData?.candidates ?? []) as MemberCandidate[]).filter(
      (candidate) => !existingContributorIds.includes(candidate.contributorId),
    );

    const filtered = rows.filter((candidate) => {
      if (classification !== 'all' && candidate.classification !== classification) {
        return false;
      }
      if (!searchNeedle) return true;
      return candidate.displayName.toLowerCase().includes(searchNeedle)
        || candidate.primaryEmail.toLowerCase().includes(searchNeedle)
        || candidate.repositoryNames.some((name) => name.toLowerCase().includes(searchNeedle));
    });

    filtered.sort((a, b) => {
      if (sort === 'name') {
        return a.displayName.localeCompare(b.displayName);
      }
      if (sort === 'repositories') {
        return b.activeRepositoryCount - a.activeRepositoryCount
          || b.commitCount - a.commitCount
          || a.displayName.localeCompare(b.displayName);
      }
      if (sort === 'commits') {
        return b.commitCount - a.commitCount
          || b.activeRepositoryCount - a.activeRepositoryCount
          || a.displayName.localeCompare(b.displayName);
      }
      return (b.lastActivityAt ? new Date(b.lastActivityAt).getTime() : 0)
        - (a.lastActivityAt ? new Date(a.lastActivityAt).getTime() : 0)
        || b.commitCount - a.commitCount
        || a.displayName.localeCompare(b.displayName);
    });

    return filtered;
  }, [candidatesData, classification, deferredSearch, existingContributorIds, sort]);

  const selectedCandidate = useMemo(
    () => availableCandidates.find((candidate) => candidate.contributorId === selectedId) ?? null,
    [availableCandidates, selectedId],
  );

  const mutation = useMutation({
    mutationFn: async () => {
      const body: any = { contributorId: selectedId, isPrimary };
      const suggestedEffectiveFrom = selectedCandidate?.firstActivityAt?.slice(0, 10);
      if (effectiveFrom || suggestedEffectiveFrom) {
        body.effectiveFrom = effectiveFrom || suggestedEffectiveFrom;
      }
      if (effectiveTo) body.effectiveTo = effectiveTo;
      if (role) body.role = role;

      const res = await fetch(`/api/v2/teams/${teamId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed');
      return json.data;
    },
    onSuccess: () => {
      toast({ description: t('success') });
      queryClient.invalidateQueries({ queryKey: ['team', teamId] });
      queryClient.invalidateQueries({ queryKey: ['team-repositories', teamId] });
      resetAndClose();
    },
    onError: (err: Error) => {
      toast({
        variant: 'destructive',
        description: err.message.includes('Unique constraint') ? t('alreadyMember') : t('error'),
      });
    },
  });

  function resetAndClose() {
    setOpen(false);
    setSearch('');
    setRepository('all');
    setClassification('all');
    setSort('activity');
    setSelectedId('');
    setEffectiveFrom('');
    setEffectiveTo('');
    setIsPrimary(false);
    setRole('');
    setShowAdvanced(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose(); else setOpen(true); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1">
          <Plus className="h-4 w-4" />
          {t('title')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t('contributor')}</Label>
            <Input
              placeholder={t('contributorPlaceholder')}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelectedId('');
              }}
            />
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <Label>{t('filters.repository')}</Label>
              <Select value={repository} onValueChange={(value) => {
                setRepository(value);
                setSelectedId('');
              }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('filters.allRepositories')}</SelectItem>
                  {repositoryOptions.map((repoName) => (
                    <SelectItem key={repoName} value={repoName}>
                      {repoName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{t('filters.classification')}</Label>
              <Select value={classification} onValueChange={(value) => {
                setClassification(value);
                setSelectedId('');
              }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('filters.allClassifications')}</SelectItem>
                  <SelectItem value="INTERNAL">{t('filters.internal')}</SelectItem>
                  <SelectItem value="EXTERNAL">{t('filters.external')}</SelectItem>
                  <SelectItem value="BOT">{t('filters.bot')}</SelectItem>
                  <SelectItem value="FORMER_EMPLOYEE">{t('filters.formerEmployee')}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{t('filters.sort')}</Label>
              <Select value={sort} onValueChange={(value) => {
                setSort(value as typeof sort);
                setSelectedId('');
              }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="activity">{t('filters.sortActivity')}</SelectItem>
                  <SelectItem value="commits">{t('filters.sortCommits')}</SelectItem>
                  <SelectItem value="repositories">{t('filters.sortRepositories')}</SelectItem>
                  <SelectItem value="name">{t('filters.sortName')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('candidateList')}</Label>
            <div className="rounded-md border max-h-64 overflow-y-auto">
              {isLoadingCandidates ? (
                <div className="px-3 py-6 text-sm text-muted-foreground">{tCommon('loading')}</div>
              ) : availableCandidates.length === 0 ? (
                <div className="px-3 py-6 text-sm text-muted-foreground">{t('emptyCandidates')}</div>
              ) : (
                availableCandidates.map((candidate) => {
                  const isSelected = selectedId === candidate.contributorId;
                  return (
                    <button
                      key={candidate.contributorId}
                      type="button"
                      className={cn(
                        'w-full border-b px-3 py-3 text-left last:border-b-0 hover:bg-accent/40',
                        isSelected && 'bg-accent',
                        candidate.isExcluded && 'opacity-70',
                      )}
                      onClick={() => {
                        setSelectedId(candidate.contributorId);
                        if (candidate.firstActivityAt) {
                          setEffectiveFrom(candidate.firstActivityAt.slice(0, 10));
                        }
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{candidate.displayName}</div>
                          <div className="truncate text-sm text-muted-foreground">
                            {candidate.primaryEmail}
                          </div>
                          {candidate.repositoryNames.length > 0 ? (
                            <div className="truncate text-xs text-muted-foreground mt-1">
                              {candidate.repositoryNames.slice(0, 3).join(', ')}
                            </div>
                          ) : null}
                        </div>
                        <div className="shrink-0 text-right text-xs text-muted-foreground">
                          <div>{t('stats.commits', { count: candidate.commitCount })}</div>
                          <div>{t('stats.repositories', { count: candidate.activeRepositoryCount })}</div>
                          {candidate.isExcluded ? <div>{t('stats.excluded')}</div> : null}
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {selectedCandidate?.firstActivityAt ? (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              {t('suggestedStartDate', { date: selectedCandidate.firstActivityAt.slice(0, 10) })}
            </div>
          ) : null}

          <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" className="justify-start px-0 text-sm">
                <ChevronDown className={cn('mr-2 h-4 w-4 transition-transform', showAdvanced && 'rotate-180')} />
                {t('advanced.toggle')}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-2">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t('effectiveFrom')}</Label>
                  <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>{t('effectiveTo')}</Label>
                  <Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t('role')}</Label>
                <Input placeholder={t('rolePlaceholder')} value={role} onChange={(e) => setRole(e.target.value)} />
              </div>

              <div className="flex items-center gap-2">
                <Checkbox id="is-primary" checked={isPrimary} onCheckedChange={(v) => setIsPrimary(v === true)} />
                <Label htmlFor="is-primary">{t('isPrimary')}</Label>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={resetAndClose}>{tCommon('cancel')}</Button>
            <Button onClick={() => mutation.mutate()} disabled={!selectedId || mutation.isPending}>
              {t('submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
