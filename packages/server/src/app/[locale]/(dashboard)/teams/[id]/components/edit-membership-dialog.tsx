'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';

interface Membership {
  membershipId: string;
  displayName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isPrimary: boolean;
  role: string | null;
}

interface EditMembershipDialogProps {
  teamId: string;
  membership: Membership | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditMembershipDialog({ teamId, membership, open, onOpenChange }: EditMembershipDialogProps) {
  const t = useTranslations('teamDetail.editMember');
  const tAdd = useTranslations('teamDetail.addMember');
  const tCommon = useTranslations('common');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [role, setRole] = useState('');

  useEffect(() => {
    if (membership) {
      setEffectiveFrom(format(new Date(membership.effectiveFrom), 'yyyy-MM-dd'));
      setEffectiveTo(membership.effectiveTo ? format(new Date(membership.effectiveTo), 'yyyy-MM-dd') : '');
      setIsPrimary(membership.isPrimary);
      setRole(membership.role ?? '');
    }
  }, [membership]);

  const mutation = useMutation({
    mutationFn: async () => {
      const body: any = { isPrimary };
      if (effectiveFrom) body.effectiveFrom = effectiveFrom;
      body.effectiveTo = effectiveTo || null;
      body.role = role || null;

      const res = await fetch(`/api/v2/teams/${teamId}/members/${membership!.membershipId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Update failed');
    },
    onSuccess: () => {
      toast({ description: t('success') });
      queryClient.invalidateQueries({ queryKey: ['team', teamId] });
      queryClient.invalidateQueries({ queryKey: ['team-repositories', teamId] });
      onOpenChange(false);
    },
    onError: () => {
      toast({ variant: 'destructive', description: t('error') });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}: {membership?.displayName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tAdd('effectiveFrom')}</Label>
              <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{tAdd('effectiveTo')}</Label>
              <Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{tAdd('role')}</Label>
            <Input placeholder={tAdd('rolePlaceholder')} value={role} onChange={(e) => setRole(e.target.value)} />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id="edit-primary" checked={isPrimary} onCheckedChange={(v) => setIsPrimary(v === true)} />
            <Label htmlFor="edit-primary">{tAdd('isPrimary')}</Label>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>{tCommon('cancel')}</Button>
            <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
              {t('submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
