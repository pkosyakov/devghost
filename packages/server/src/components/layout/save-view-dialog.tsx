'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface SaveViewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeScope: {
    scopeKind: 'all_teams' | 'team' | 'saved_view';
    scopeId?: string;
    from?: string;
    to?: string;
    repositoryIds?: string[];
    contributorIds?: string[];
  };
}

export function SaveViewDialog({ open, onOpenChange, activeScope }: SaveViewDialogProps) {
  const t = useTranslations('scope.saveView');
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'PRIVATE' | 'WORKSPACE'>('PRIVATE');
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) {
      setName('');
      setVisibility('PRIVATE');
    }
  }, [open]);

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/v2/saved-views', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          visibility,
          activeScope,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to save view');
      }
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-views'] });
      queryClient.invalidateQueries({ queryKey: ['scope-saved-views'] });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="saved-view-name">{t('name')}</Label>
            <Input
              id="saved-view-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('namePlaceholder')}
            />
          </div>

          <div className="space-y-2">
            <Label>{t('visibility')}</Label>
            <Select value={visibility} onValueChange={(value) => setVisibility(value as 'PRIVATE' | 'WORKSPACE')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PRIVATE">{t('private')}</SelectItem>
                <SelectItem value="WORKSPACE">{t('workspace')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => createMutation.mutate()}
            disabled={!name.trim() || createMutation.isPending}
          >
            {createMutation.isPending ? t('saving') : t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

