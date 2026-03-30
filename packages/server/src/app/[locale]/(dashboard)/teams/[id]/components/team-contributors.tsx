'use client';

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Trash2, Pencil, Star } from 'lucide-react';
import { format } from 'date-fns';

export interface Membership {
  membershipId: string;
  contributorId: string;
  displayName: string;
  primaryEmail: string;
  classification: string;
  isExcluded: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  isPrimary: boolean;
  role: string | null;
}

interface TeamContributorsProps {
  teamId: string;
  contributors: Membership[];
  onEditMember: (member: Membership) => void;
}

export function TeamContributors({ teamId, contributors, onEditMember }: TeamContributorsProps) {
  const t = useTranslations('teamDetail.members');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const removeMutation = useMutation({
    mutationFn: async (membershipId: string) => {
      const res = await fetch(`/api/v2/teams/${teamId}/members/${membershipId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Remove failed');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team', teamId] });
    },
    onError: () => {
      toast({ variant: 'destructive', description: t('removeError') });
    },
  });

  if (contributors.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">{t('empty')}</p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('name')}</TableHead>
          <TableHead>{t('role')}</TableHead>
          <TableHead>{t('effectiveFrom')}</TableHead>
          <TableHead>{t('effectiveTo')}</TableHead>
          <TableHead>{t('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {contributors.map((m) => (
          <TableRow key={m.membershipId}>
            <TableCell>
              <div className="flex items-center gap-2">
                <Link
                  href={`/people/${m.contributorId}`}
                  className="font-medium hover:underline"
                >
                  {m.displayName}
                </Link>
                {m.isPrimary && (
                  <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500" />
                )}
                <Badge variant="outline" className="text-xs">
                  {m.classification}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{m.primaryEmail}</p>
            </TableCell>
            <TableCell className="text-sm">{m.role || '-'}</TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {format(new Date(m.effectiveFrom), 'MMM d, yyyy')}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {m.effectiveTo ? format(new Date(m.effectiveTo), 'MMM d, yyyy') : t('active')}
            </TableCell>
            <TableCell>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" onClick={() => onEditMember(m)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (confirm(t('removeConfirm'))) {
                      removeMutation.mutate(m.membershipId);
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
