'use client';

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle2, AlertCircle } from 'lucide-react';

interface Alias {
  id: string;
  email: string;
  username: string | null;
  providerType: string;
  resolveStatus: string;
  mergeReason: string | null;
}

interface PotentialMatch {
  id: string;
  email: string;
  username: string | null;
  providerType: string;
  lastSeenAt: string | null;
}

interface ContributorAliasesPanelProps {
  contributorId: string;
  aliases: Alias[];
  potentialMatches: PotentialMatch[];
}

export function ContributorAliasesPanel({
  contributorId,
  aliases,
  potentialMatches,
}: ContributorAliasesPanelProps) {
  const t = useTranslations('contributorDetail.identity');
  const queryClient = useQueryClient();

  const resolveMutation = useMutation({
    mutationFn: async (aliasId: string) => {
      const res = await fetch(`/api/v2/contributors/aliases/${aliasId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contributorId }),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contributor', contributorId] });
      queryClient.invalidateQueries({ queryKey: ['contributors'] });
      queryClient.invalidateQueries({ queryKey: ['identity-queue'] });
    },
  });

  const statusLabel = (status: string) => {
    switch (status) {
      case 'AUTO_MERGED': return t('autoMerged');
      case 'MANUAL': return t('manual');
      case 'SUGGESTED': return t('unresolved');
      default: return t('unresolved');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Attached Aliases */}
        <div>
          <h4 className="text-sm font-medium mb-2">{t('attached')}</h4>
          <div className="space-y-2">
            {aliases.map((alias) => (
              <div
                key={alias.id}
                className="flex items-center justify-between rounded-md border p-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span className="font-medium">{alias.email}</span>
                  {alias.username && (
                    <span className="text-muted-foreground">@{alias.username}</span>
                  )}
                  <Badge variant="secondary" className="text-xs">
                    {alias.providerType}
                  </Badge>
                </div>
                <Badge variant="outline" className="text-xs">
                  {statusLabel(alias.resolveStatus)}
                </Badge>
              </div>
            ))}
          </div>
        </div>

        {/* Potential Matches */}
        {potentialMatches.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">{t('potentialMatches')}</h4>
            <div className="space-y-2">
              {potentialMatches.map((match) => (
                <div
                  key={match.id}
                  className="flex items-center justify-between rounded-md border border-dashed border-yellow-500/50 p-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-yellow-500" />
                    <span className="font-medium">{match.email}</span>
                    {match.username && (
                      <span className="text-muted-foreground">@{match.username}</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resolveMutation.mutate(match.id)}
                    disabled={resolveMutation.isPending}
                  >
                    {t('attachToThis')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
