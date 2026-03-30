'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { IdentityHealthBadge } from './identity-health-badge';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { Link } from '@/i18n/navigation';

interface PeopleIdentityQueueProps {
  unresolvedCount: number;
}

export function PeopleIdentityQueue({ unresolvedCount }: PeopleIdentityQueueProps) {
  const t = useTranslations('people.identityQueue');
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(unresolvedCount > 0);
  const [resolvingAliasId, setResolvingAliasId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedContributorId, setSelectedContributorId] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['identity-queue'],
    queryFn: async () => {
      const res = await fetch('/api/v2/contributors/identity-queue?pageSize=5');
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
    enabled: isOpen && unresolvedCount > 0,
  });

  const { data: searchResults } = useQuery({
    queryKey: ['resolve-search', search],
    queryFn: async () => {
      const res = await fetch(`/api/v2/contributors?search=${encodeURIComponent(search)}&pageSize=5`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data?.contributors ?? [];
    },
    enabled: !!resolvingAliasId && search.length >= 2,
  });

  const resolveMutation = useMutation({
    mutationFn: async ({ aliasId, contributorId }: { aliasId: string; contributorId: string }) => {
      const res = await fetch(`/api/v2/contributors/aliases/${aliasId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contributorId }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json;
    },
    onError: (err: Error) => toast({ variant: 'destructive', title: err.message }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['identity-queue'] });
      queryClient.invalidateQueries({ queryKey: ['contributors'] });
      setResolvingAliasId(null);
      setSearch('');
      setSelectedContributorId(null);
    },
  });

  if (unresolvedCount === 0) return null;

  return (
    <Card id="identity-queue">
      <CardHeader
        className="cursor-pointer flex flex-row items-center justify-between py-3"
        onClick={() => setIsOpen(!isOpen)}
      >
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          {t('title')}
          <IdentityHealthBadge status="unresolved" unresolvedCount={unresolvedCount} />
        </CardTitle>
        {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </CardHeader>

      {isOpen && (
        <CardContent className="pt-0">
          <p className="text-sm text-muted-foreground mb-3">{t('description')}</p>
          {data?.aliases?.length > 0 ? (
            <div className="space-y-2">
              {data.aliases.map((item: any) => (
                <div key={item.alias.id} className="rounded-md border p-2 text-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-medium">{item.alias.email}</span>
                      {item.alias.username && (
                        <span className="text-muted-foreground ml-2">@{item.alias.username}</span>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        if (resolvingAliasId === item.alias.id) {
                          setResolvingAliasId(null);
                          setSearch('');
                          setSelectedContributorId(null);
                        } else {
                          setResolvingAliasId(item.alias.id);
                          setSearch('');
                          setSelectedContributorId(null);
                        }
                      }}
                    >
                      {resolvingAliasId === item.alias.id ? t('cancel') : t('resolve')}
                    </Button>
                  </div>

                  {resolvingAliasId === item.alias.id && (
                    <div className="mt-2 space-y-2">
                      <div className="relative">
                        <Search className="absolute left-2 top-2.5 h-3 w-3 text-muted-foreground" />
                        <Input
                          value={search}
                          onChange={(e) => {
                            setSearch(e.target.value);
                            setSelectedContributorId(null);
                          }}
                          placeholder={t('searchContributor')}
                          className="h-8 pl-7 text-sm"
                        />
                      </div>
                      {searchResults && searchResults.length > 0 && (
                        <div className="max-h-[120px] overflow-y-auto space-y-1">
                          {searchResults.map((c: any) => (
                            <button
                              key={c.id}
                              type="button"
                              className={cn(
                                'flex items-center w-full text-left text-xs rounded border px-2 py-1 transition-colors',
                                selectedContributorId === c.id
                                  ? 'border-primary bg-primary/5'
                                  : 'hover:bg-muted/50'
                              )}
                              onClick={() => setSelectedContributorId(c.id)}
                            >
                              <span className="font-medium">{c.displayName}</span>
                              <span className="text-muted-foreground ml-2">{c.primaryEmail}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      {search.length >= 2 && searchResults?.length === 0 && (
                        <p className="text-xs text-muted-foreground">{t('noResults')}</p>
                      )}
                      {selectedContributorId && (
                        <Button
                          size="sm"
                          className="w-full"
                          disabled={resolveMutation.isPending}
                          onClick={() =>
                            resolveMutation.mutate({
                              aliasId: item.alias.id,
                              contributorId: selectedContributorId,
                            })
                          }
                        >
                          {t('confirmResolve')}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {unresolvedCount > 5 && (
                <Link
                  href="/people?identityHealth=unresolved"
                  className="block text-center text-sm text-primary hover:underline mt-2"
                >
                  {t('viewAll')}
                </Link>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
