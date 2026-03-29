'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@/i18n/navigation';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ContributorMergeModalProps {
  contributorId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ContributorMergeModal({
  contributorId,
  open,
  onOpenChange,
}: ContributorMergeModalProps) {
  const t = useTranslations('contributorDetail.merge');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['contributors-search', search],
    queryFn: async () => {
      const res = await fetch(
        `/api/v2/contributors?search=${encodeURIComponent(search)}&pageSize=10`
      );
      const json = await res.json();
      return json.data?.contributors?.filter((c: any) => c.id !== contributorId) ?? [];
    },
    enabled: open && search.length >= 2,
  });

  const mergeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/v2/contributors/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromContributorId: contributorId,
          toContributorId: selectedId,
        }),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contributors'] });
      queryClient.invalidateQueries({ queryKey: ['identity-queue'] });
      onOpenChange(false);
      // Navigate to target contributor
      if (selectedId) {
        router.push(`/people/${selectedId}`);
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSelectedId(null);
          }}
          placeholder={t('search')}
        />

        {data && data.length > 0 ? (
          <div className="space-y-2 max-h-[200px] overflow-y-auto">
            {data.map((c: any) => (
              <button
                key={c.id}
                type="button"
                className={cn(
                  'flex items-center w-full text-left space-x-2 rounded-md border p-2 transition-colors',
                  selectedId === c.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                )}
                onClick={() => setSelectedId(c.id)}
              >
                <span className="font-medium">{c.displayName}</span>
                <span className="text-muted-foreground ml-2">{c.primaryEmail}</span>
              </button>
            ))}
          </div>
        ) : search.length >= 2 ? (
          <p className="text-sm text-muted-foreground py-4">{t('noResults')}</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => mergeMutation.mutate()}
            disabled={!selectedId || mergeMutation.isPending}
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
