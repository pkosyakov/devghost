'use client';

import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

interface BenchmarkLauncherProps {
  orderId: string;
  disabled?: boolean;  // true when any job is running
  onLaunched: (jobId: string) => void;
}

export function BenchmarkLauncher({ orderId, disabled, onLaunched }: BenchmarkLauncherProps) {
  const t = useTranslations('components.benchmark');

  const launchMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/orders/${orderId}/benchmark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: 'target_rollout' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      onLaunched(data.data?.jobId || data.jobId);
    },
  });

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground space-y-0.5">
        <p className="font-medium">{t('rolloutProfile')}</p>
        <p>3-49 files: openrouter / qwen3-coder-next</p>
        <p>50+ files: FD v3 / openrouter / qwen3-coder-plus</p>
      </div>

      <Button
        size="sm"
        onClick={() => launchMutation.mutate()}
        disabled={launchMutation.isPending || disabled}
      >
        {launchMutation.isPending ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" />{t('starting')}</> : t('runRollout')}
      </Button>

      {launchMutation.isError && (
        <p className="text-xs text-red-500">{launchMutation.error.message}</p>
      )}
    </div>
  );
}
