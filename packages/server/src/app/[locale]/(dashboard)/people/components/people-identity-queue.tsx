'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { IdentityHealthBadge } from './identity-health-badge';

interface PeopleIdentityQueueProps {
  unresolvedCount: number;
}

export function PeopleIdentityQueue({ unresolvedCount }: PeopleIdentityQueueProps) {
  const t = useTranslations('people.identityQueue');
  const [isOpen, setIsOpen] = useState(unresolvedCount > 0);

  const { data } = useQuery({
    queryKey: ['identity-queue'],
    queryFn: async () => {
      const res = await fetch('/api/v2/contributors/identity-queue?pageSize=5');
      const json = await res.json();
      return json.data;
    },
    enabled: isOpen && unresolvedCount > 0,
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
                <div
                  key={item.alias.id}
                  className="flex items-center justify-between rounded-md border p-2 text-sm"
                >
                  <div>
                    <span className="font-medium">{item.alias.email}</span>
                    {item.alias.username && (
                      <span className="text-muted-foreground ml-2">@{item.alias.username}</span>
                    )}
                  </div>
                  <Button size="sm" variant="outline">
                    {t('resolve')}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
