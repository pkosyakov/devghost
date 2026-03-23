'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, Play, AlertCircle } from 'lucide-react';

export default function DemoPage() {
  const t = useTranslations('demo');
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createDemo = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/demo', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create demo order');
      }

      const data = await res.json();
      const orderId = data.data?.orderId || data.data?.id;

      if (orderId) {
        router.push(`/orders/${orderId}`);
      } else {
        throw new Error('No order ID returned');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setLoading(false);
    }
  };

  return (
    <div className="container max-w-2xl py-8">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>
            {t('description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t('intro')}
            </p>
            <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
              <li>{t('item1')}</li>
              <li>{t('item2')}</li>
              <li>{t('item3')}</li>
              <li>{t('item4')}</li>
            </ul>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 text-red-700 rounded-md">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          <Button
            onClick={createDemo}
            disabled={loading}
            className="w-full"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('creating')}
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                {t('create')}
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
