'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2 } from 'lucide-react';
import { ModelPickerDialog, type ModelInfo } from '@/components/model-picker-dialog';
import { useModelPreferences } from '@/hooks/use-model-preferences';

interface BenchmarkLauncherProps {
  orderId: string;
  disabled?: boolean;  // true when any job is running
  commitCount?: number;
  avgInputTokens?: number;
  onLaunched: (jobId: string) => void;
}

export function BenchmarkLauncher({ orderId, disabled, commitCount, avgInputTokens, onLaunched }: BenchmarkLauncherProps) {
  const t = useTranslations('components.benchmark');
  const [provider, setProvider] = useState<'ollama' | 'openrouter'>('ollama');
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null);
  const [promptRepeat, setPromptRepeat] = useState(false);
  const { addRecent } = useModelPreferences();

  const modelsQuery = useQuery({
    queryKey: ['llm-models', provider],
    queryFn: async () => {
      const res = await fetch(`/api/llm/models?provider=${provider}`);
      if (!res.ok) throw new Error('Failed to fetch models');
      return res.json() as Promise<{ models: ModelInfo[] }>;
    },
  });

  const launchMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/orders/${orderId}/benchmark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model: selectedModel?.id, contextLength: selectedModel?.contextLength, promptRepeat }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (selectedModel) {
        addRecent(provider, selectedModel.id);
      }
      onLaunched(data.data?.jobId || data.jobId);
    },
  });

  const estimatedCost = (() => {
    if (!selectedModel || !commitCount) return 0;
    const avgInput = avgInputTokens || 3000;
    const inputTokens = avgInput * commitCount;
    const outputTokens = 1024 * commitCount;
    const inputCost = (inputTokens / 1e6) * (selectedModel.inputPricePerMToken || 0);
    const outputCost = (outputTokens / 1e6) * (selectedModel.outputPricePerMToken || 0);
    return inputCost + outputCost;
  })();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Select
        value={provider}
        onValueChange={(v) => {
          setProvider(v as 'ollama' | 'openrouter');
          setSelectedModel(null);
        }}
      >
        <SelectTrigger className="w-[130px] h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ollama">Ollama</SelectItem>
          <SelectItem value="openrouter">OpenRouter</SelectItem>
        </SelectContent>
      </Select>

      <ModelPickerDialog
        provider={provider}
        models={modelsQuery.data?.models ?? []}
        isLoading={modelsQuery.isLoading}
        selectedModelId={selectedModel?.id ?? null}
        onSelect={setSelectedModel}
      />

      {selectedModel && provider === 'openrouter' && commitCount && selectedModel.inputPricePerMToken != null && selectedModel.outputPricePerMToken != null && (
        <p className="text-xs text-muted-foreground">
          {t('estCost', { cost: estimatedCost.toFixed(2), commits: commitCount })}
        </p>
      )}
      {selectedModel && provider === 'ollama' && (
        <p className="text-xs text-muted-foreground">{t('freeLocal')}</p>
      )}

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
        <Checkbox
          checked={promptRepeat}
          onCheckedChange={(v) => setPromptRepeat(v === true)}
          className="h-3.5 w-3.5"
        />
        {t('promptRepeat')}
      </label>

      <Button
        size="sm"
        onClick={() => launchMutation.mutate()}
        disabled={!selectedModel || launchMutation.isPending || disabled}
      >
        {launchMutation.isPending ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" />{t('starting')}</> : t('run')}
      </Button>

      {launchMutation.isError && (
        <span className="text-xs text-red-500">{launchMutation.error.message}</span>
      )}
    </div>
  );
}
