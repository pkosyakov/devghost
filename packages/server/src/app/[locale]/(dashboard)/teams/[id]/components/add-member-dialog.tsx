'use client';

import { useState } from 'react';
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
import { useToast } from '@/hooks/use-toast';
import { Plus } from 'lucide-react';

interface AddMemberDialogProps {
  teamId: string;
  existingContributorIds: string[];
}

export function AddMemberDialog({ teamId, existingContributorIds }: AddMemberDialogProps) {
  const t = useTranslations('teamDetail.addMember');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [role, setRole] = useState('');

  const { data: contributorsData } = useQuery({
    queryKey: ['contributors-search', search],
    queryFn: async () => {
      const params = new URLSearchParams({ pageSize: '20' });
      if (search) params.set('search', search);
      const res = await fetch(`/api/v2/contributors?${params.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.success) return { contributors: [] };
      return json.data;
    },
    enabled: open,
  });

  const availableContributors = (contributorsData?.contributors ?? []).filter(
    (c: any) => !existingContributorIds.includes(c.id),
  );

  const mutation = useMutation({
    mutationFn: async () => {
      const body: any = { contributorId: selectedId, isPrimary };
      if (effectiveFrom) body.effectiveFrom = effectiveFrom;
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
    setSelectedId('');
    setEffectiveFrom('');
    setEffectiveTo('');
    setIsPrimary(false);
    setRole('');
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
              onChange={(e) => { setSearch(e.target.value); setSelectedId(''); }}
            />
            {search && availableContributors.length > 0 && !selectedId && (
              <div className="border rounded-md max-h-40 overflow-y-auto">
                {availableContributors.map((c: any) => (
                  <button
                    key={c.id}
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-accent text-sm"
                    onClick={() => { setSelectedId(c.id); setSearch(c.displayName); }}
                  >
                    <span className="font-medium">{c.displayName}</span>
                    <span className="text-muted-foreground ml-2">{c.primaryEmail}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

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

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={resetAndClose}>Cancel</Button>
            <Button onClick={() => mutation.mutate()} disabled={!selectedId || mutation.isPending}>
              {t('submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
