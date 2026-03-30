'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { MoreVertical, Pencil, Trash2 } from 'lucide-react';

interface TeamHeaderProps {
  team: {
    id: string;
    name: string;
    description: string | null;
  };
}

export function TeamHeader({ team }: TeamHeaderProps) {
  const t = useTranslations('teamDetail.settings');
  const tCommon = useTranslations('common');
  const { toast } = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? '');

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/teams/${team.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || null }),
      });
      if (!res.ok) throw new Error('Update failed');
    },
    onSuccess: () => {
      toast({ description: t('editSuccess') });
      queryClient.invalidateQueries({ queryKey: ['team', team.id] });
      setEditing(false);
    },
    onError: () => {
      toast({ variant: 'destructive', description: t('editError') });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/teams/${team.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
    },
    onSuccess: () => {
      toast({ description: t('deleteSuccess') });
      router.push('/teams');
    },
    onError: () => {
      toast({ variant: 'destructive', description: t('deleteError') });
    },
  });

  if (editing) {
    return (
      <div className="space-y-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => updateMutation.mutate()} disabled={!name.trim()}>
            {tCommon('save')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => { setEditing(false); setName(team.name); setDescription(team.description ?? ''); }}>
            {tCommon('cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between">
      <div>
        <h1 className="text-2xl font-bold">{team.name}</h1>
        {team.description && (
          <p className="text-muted-foreground mt-1">{team.description}</p>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditing(true)}>
            <Pencil className="mr-2 h-4 w-4" />
            {t('edit')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            onClick={() => {
              if (confirm(t('deleteConfirm'))) {
                deleteMutation.mutate();
              }
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
