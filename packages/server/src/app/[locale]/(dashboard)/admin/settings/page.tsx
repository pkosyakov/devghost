'use client';

import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Settings2, AlertCircle, ChevronsUpDown, RefreshCw, Database, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useTranslations } from 'next-intl';

interface LlmSettings {
  llmProvider: string;
  ollamaUrl: string;
  ollamaModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  openrouterProviderOrder: string;
  openrouterProviderIgnore: string;
  openrouterAllowFallbacks: boolean;
  openrouterRequireParameters: boolean;
  openrouterKeySource?: 'db' | 'env' | 'none';
  openrouterInputPrice?: number;
  openrouterOutputPrice?: number;
  demoLiveMode: boolean;
  demoLiveChunkSize: number;
}

interface OpenRouterModel {
  id: string;
  name: string;
  inputPrice: number;
  outputPrice: number;
  contextLength: number;
}

interface CacheStats {
  totalMb: number;
  repos: number;
  diffs: number;
  llm: number;
}

/** Format price as string, handling very small numbers. */
function formatPrice(price: number): string {
  if (price === 0) return '$0';
  if (price < 0.001) return `$${price.toFixed(6)}`;
  if (price < 1) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

export default function AdminSettingsPage() {
  const t = useTranslations('admin.settings');
  const tc = useTranslations('common');
  const { toast } = useToast();

  // LLM settings
  const [llmSettings, setLlmSettings] = useState<LlmSettings>({
    llmProvider: 'ollama',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'qwen2.5-coder:32b',
    openrouterApiKey: '',
    openrouterModel: 'qwen/qwen-2.5-coder-32b-instruct',
    openrouterProviderOrder: 'Chutes',
    openrouterProviderIgnore: 'Cloudflare',
    openrouterAllowFallbacks: true,
    openrouterRequireParameters: true,
    openrouterInputPrice: 0.03,
    openrouterOutputPrice: 0.11,
    demoLiveMode: false,
    demoLiveChunkSize: 10,
  });
  const [llmLoading, setLlmLoading] = useState(true);
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmError, setLlmError] = useState('');

  // OpenRouter model list
  const [orModels, setOrModels] = useState<OpenRouterModel[]>([]);
  const [orModelsLoading, setOrModelsLoading] = useState(false);
  const [orModelSearch, setOrModelSearch] = useState('');
  const [orPopoverOpen, setOrPopoverOpen] = useState(false);
  const [priceRefreshing, setPriceRefreshing] = useState(false);

  // Cache management
  const queryClient = useQueryClient();

  const { data: cacheStats, isLoading: cacheLoading } = useQuery<CacheStats>({
    queryKey: ['cache-stats'],
    queryFn: async () => {
      const res = await fetch('/api/cache');
      if (!res.ok) throw new Error('Failed to fetch cache stats');
      return res.json();
    },
  });

  const [clearingLevel, setClearingLevel] = useState<string | null>(null);

  const clearCacheMutation = useMutation({
    mutationFn: async (level: string) => {
      setClearingLevel(level);
      const res = await fetch(`/api/cache?level=${level}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to clear cache');
      return res.json();
    },
    onSuccess: (data, level) => {
      queryClient.invalidateQueries({ queryKey: ['cache-stats'] });
      const { cleared } = data;
      const total = cleared.repos + cleared.diffs + cleared.llm;
      toast({
        title: t('cacheCleared'),
        description: t('cacheRemovedEntries', { total, level }),
      });
    },
    onError: () => {
      toast({
        title: tc('errorTitle'),
        description: t('failedClearCache'),
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setClearingLevel(null);
    },
  });

  // Load LLM settings
  useEffect(() => {
    const loadLlmSettings = async () => {
      setLlmLoading(true);
      try {
        const response = await fetch('/api/admin/llm-settings');
        if (response.ok) {
          const result = await response.json();
          if (result.success && result.data) {
            setLlmSettings((prev) => ({
              ...prev,
              ...result.data,
              demoLiveChunkSize: result.data.demoLiveChunkSize ?? prev.demoLiveChunkSize,
            }));
          }
        }
      } catch {
        // Settings will use defaults
      } finally {
        setLlmLoading(false);
      }
    };

    loadLlmSettings();
  }, []);

  // Load OpenRouter model list when provider is openrouter
  useEffect(() => {
    if (llmSettings.llmProvider !== 'openrouter') return;
    if (orModels.length > 0) return; // already loaded

    const loadModels = async () => {
      setOrModelsLoading(true);
      try {
        const response = await fetch('/api/admin/openrouter-models');
        if (response.ok) {
          const result = await response.json();
          if (result.success && result.data?.models) {
            setOrModels(result.data.models);
          }
        }
      } catch {
        // Models will remain empty — user can type manually
      } finally {
        setOrModelsLoading(false);
      }
    };

    loadModels();
  }, [llmSettings.llmProvider, orModels.length]);

  // Filtered model list
  const filteredModels = useMemo(() => {
    if (!orModelSearch) return orModels;
    const q = orModelSearch.toLowerCase();
    return orModels.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    );
  }, [orModels, orModelSearch]);

  const handleLlmSave = async () => {
    setLlmSaving(true);
    setLlmError('');
    try {
      const response = await fetch('/api/admin/llm-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(llmSettings),
      });

      const result = await response.json();

      if (result.success) {
        setLlmSettings(result.data);
        toast({
          title: t('settingsSaved'),
          description: t('settingsSavedProvider', { provider: result.data.llmProvider }),
        });
      } else {
        setLlmError(result.error || 'Failed to save LLM settings');
      }
    } catch {
      setLlmError('Failed to save LLM settings');
    } finally {
      setLlmSaving(false);
    }
  };

  const handleSelectModel = (model: OpenRouterModel) => {
    setLlmSettings((prev) => ({
      ...prev,
      openrouterModel: model.id,
      openrouterInputPrice: model.inputPrice,
      openrouterOutputPrice: model.outputPrice,
    }));
    setOrPopoverOpen(false);
    setOrModelSearch('');
  };

  const handleRefreshPricing = async () => {
    setPriceRefreshing(true);
    try {
      const response = await fetch('/api/admin/openrouter-models');
      if (!response.ok) throw new Error('Failed to fetch');
      const result = await response.json();
      if (!result.success || !result.data?.models) throw new Error('Bad response');

      const models: OpenRouterModel[] = result.data.models;
      setOrModels(models);

      const match = models.find((m) => m.id === llmSettings.openrouterModel);
      if (match) {
        setLlmSettings((prev) => ({
          ...prev,
          openrouterInputPrice: match.inputPrice,
          openrouterOutputPrice: match.outputPrice,
        }));
        toast({ title: t('pricingUpdated'), description: `${match.id}: ${t('priceIn', { price: formatPrice(match.inputPrice) })}, ${t('priceOut', { price: formatPrice(match.outputPrice) })}` });
      } else {
        toast({ title: t('modelNotFound'), description: t('modelNotFoundDesc', { model: llmSettings.openrouterModel }), variant: 'destructive' });
      }
    } catch {
      toast({ title: tc('errorTitle'), description: t('failedFetchPricing'), variant: 'destructive' });
    } finally {
      setPriceRefreshing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      {/* LLM Provider */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" />
            <CardTitle>{t('llmProvider')}</CardTitle>
          </div>
          <CardDescription>
            {t('llmProviderDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {llmLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm text-muted-foreground">{t('loadingSettings')}</span>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>{t('provider')}</Label>
                <Select
                  value={llmSettings.llmProvider}
                  onValueChange={(value) =>
                    setLlmSettings((prev) => ({ ...prev, llmProvider: value }))
                  }
                >
                  <SelectTrigger className="w-[240px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ollama">{t('ollamaLocal')}</SelectItem>
                    <SelectItem value="openrouter">{t('openrouterCloud')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3 rounded-md border p-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <Label htmlFor="demo-live-mode">{t('demoLiveMode')}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t('demoLiveModeHint')}
                    </p>
                  </div>
                  <Switch
                    id="demo-live-mode"
                    checked={llmSettings.demoLiveMode}
                    onCheckedChange={(checked) =>
                      setLlmSettings((prev) => ({ ...prev, demoLiveMode: checked }))
                    }
                  />
                </div>
                <div className="max-w-56 space-y-1">
                  <Label htmlFor="demo-live-chunk-size">{t('demoLiveChunkSize')}</Label>
                  <Input
                    id="demo-live-chunk-size"
                    type="number"
                    min={1}
                    max={200}
                    step={1}
                    disabled={!llmSettings.demoLiveMode}
                    value={llmSettings.demoLiveChunkSize}
                    onChange={(e) => {
                      const parsed = Number.parseInt(e.target.value, 10);
                      if (Number.isNaN(parsed)) return;
                      setLlmSettings((prev) => ({
                        ...prev,
                        demoLiveChunkSize: Math.max(1, Math.min(200, parsed)),
                      }));
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('demoLiveChunkSizeHint')}
                  </p>
                </div>
              </div>

              {llmSettings.llmProvider === 'ollama' && (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="ollama-url">{t('ollamaUrl')}</Label>
                    <Input
                      id="ollama-url"
                      placeholder="http://localhost:11434"
                      value={llmSettings.ollamaUrl}
                      onChange={(e) =>
                        setLlmSettings((prev) => ({ ...prev, ollamaUrl: e.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ollama-model">{t('model')}</Label>
                    <Input
                      id="ollama-model"
                      placeholder="qwen2.5-coder:32b"
                      value={llmSettings.ollamaModel}
                      onChange={(e) =>
                        setLlmSettings((prev) => ({ ...prev, ollamaModel: e.target.value }))
                      }
                    />
                  </div>
                </div>
              )}

              {llmSettings.llmProvider === 'openrouter' && (
                <div className="space-y-4">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="or-apikey">{t('apiKey')}</Label>
                      <Input
                        id="or-apikey"
                        type="password"
                        placeholder="sk-or-..."
                        value={llmSettings.openrouterApiKey}
                        onChange={(e) =>
                          setLlmSettings((prev) => ({
                            ...prev,
                            openrouterApiKey: e.target.value,
                          }))
                        }
                      />
                      {llmSettings.openrouterKeySource === 'env' && (
                        <p className="text-xs text-muted-foreground">
                          {t('keyFromEnv')}
                        </p>
                      )}
                      {llmSettings.openrouterKeySource === 'db' && (
                        <p className="text-xs text-muted-foreground">
                          {t('keyFromDb')}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label>{t('model')}</Label>
                      <Popover open={orPopoverOpen} onOpenChange={setOrPopoverOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            role="combobox"
                            aria-expanded={orPopoverOpen}
                            className="w-full justify-between font-mono text-xs"
                          >
                            <span className="truncate">
                              {llmSettings.openrouterModel || t('selectModel')}
                            </span>
                            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[460px] p-0" align="start">
                          <div className="p-2 border-b">
                            <Input
                              placeholder={t('filterModels')}
                              value={orModelSearch}
                              onChange={(e) => setOrModelSearch(e.target.value)}
                              className="h-8"
                            />
                          </div>
                          {orModelsLoading ? (
                            <div className="flex items-center justify-center p-4">
                              <Loader2 className="h-4 w-4 animate-spin mr-2" />
                              <span className="text-sm text-muted-foreground">{t('loadingModels')}</span>
                            </div>
                          ) : orModels.length === 0 ? (
                            <div className="p-4">
                              <p className="text-sm text-muted-foreground">
                                {t('failedLoadModels')}
                              </p>
                              <Input
                                className="mt-2"
                                placeholder="qwen/qwen-2.5-coder-32b-instruct"
                                value={llmSettings.openrouterModel}
                                onChange={(e) =>
                                  setLlmSettings((prev) => ({
                                    ...prev,
                                    openrouterModel: e.target.value,
                                  }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') setOrPopoverOpen(false);
                                }}
                              />
                            </div>
                          ) : (
                            <ScrollArea className="h-[300px]">
                              <div className="p-1">
                                {filteredModels.length === 0 && (
                                  <p className="text-sm text-muted-foreground p-2">
                                    {t('noModelsMatch', { query: orModelSearch })}
                                  </p>
                                )}
                                {filteredModels.map((model) => (
                                  <button
                                    key={model.id}
                                    className={`w-full text-left px-2 py-1.5 rounded-sm text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer ${
                                      model.id === llmSettings.openrouterModel
                                        ? 'bg-accent text-accent-foreground'
                                        : ''
                                    }`}
                                    onClick={() => handleSelectModel(model)}
                                  >
                                    <div className="font-mono text-xs truncate">
                                      {model.id}
                                    </div>
                                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                                      <span>{t('contextSize', { size: (model.contextLength / 1024).toFixed(0) })}</span>
                                      <span>
                                        {t('priceIn', { price: formatPrice(model.inputPrice) })}
                                      </span>
                                      <span>
                                        {t('priceOut', { price: formatPrice(model.outputPrice) })}
                                      </span>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            </ScrollArea>
                          )}
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="or-provider-order">{t('providerOrder')}</Label>
                      <Input
                        id="or-provider-order"
                        placeholder="Chutes, DeepInfra"
                        value={llmSettings.openrouterProviderOrder}
                        onChange={(e) =>
                          setLlmSettings((prev) => ({
                            ...prev,
                            openrouterProviderOrder: e.target.value,
                          }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('providerOrderHint')}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="or-provider-ignore">{t('ignoreProviders')}</Label>
                      <Input
                        id="or-provider-ignore"
                        placeholder="Cloudflare"
                        value={llmSettings.openrouterProviderIgnore}
                        onChange={(e) =>
                          setLlmSettings((prev) => ({
                            ...prev,
                            openrouterProviderIgnore: e.target.value,
                          }))
                        }
                      />
                      <p className="text-xs text-muted-foreground">
                        {t('ignoreProvidersHint')}
                      </p>
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <p className="text-sm font-medium">{t('allowFallbacks')}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('allowFallbacksHint')}
                        </p>
                      </div>
                      <Switch
                        checked={llmSettings.openrouterAllowFallbacks}
                        onCheckedChange={(checked) =>
                          setLlmSettings((prev) => ({
                            ...prev,
                            openrouterAllowFallbacks: checked,
                          }))
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-md border p-3">
                      <div>
                        <p className="text-sm font-medium">{t('requireParameters')}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('requireParametersHint')}
                        </p>
                      </div>
                      <Switch
                        checked={llmSettings.openrouterRequireParameters}
                        onCheckedChange={(checked) =>
                          setLlmSettings((prev) => ({
                            ...prev,
                            openrouterRequireParameters: checked,
                          }))
                        }
                      />
                    </div>
                  </div>

                  {/* Pricing fields */}
                  <div className="flex items-end gap-4">
                    <div className="grid flex-1 gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="or-input-price">{t('inputPrice')}</Label>
                        <Input
                          id="or-input-price"
                          type="number"
                          step="0.0001"
                          min="0"
                          value={llmSettings.openrouterInputPrice ?? 0}
                          onChange={(e) =>
                            setLlmSettings((prev) => ({
                              ...prev,
                              openrouterInputPrice: parseFloat(e.target.value) || 0,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="or-output-price">{t('outputPrice')}</Label>
                        <Input
                          id="or-output-price"
                          type="number"
                          step="0.0001"
                          min="0"
                          value={llmSettings.openrouterOutputPrice ?? 0}
                          onChange={(e) =>
                            setLlmSettings((prev) => ({
                              ...prev,
                              openrouterOutputPrice: parseFloat(e.target.value) || 0,
                            }))
                          }
                        />
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleRefreshPricing}
                      disabled={priceRefreshing || !llmSettings.openrouterModel}
                      title={t('refreshPricing')}
                    >
                      <RefreshCw className={`h-4 w-4 ${priceRefreshing ? 'animate-spin' : ''}`} />
                    </Button>
                  </div>
                </div>
              )}

              {llmError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{llmError}</AlertDescription>
                </Alert>
              )}

              <div className="flex justify-end">
                <Button onClick={handleLlmSave} disabled={llmSaving} size="sm">
                  {llmSaving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('saving')}
                    </>
                  ) : (
                    t('saveLlmSettings')
                  )}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Pipeline Cache */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            <CardTitle>{t('pipelineCache')}</CardTitle>
          </div>
          <CardDescription>
            {t('pipelineCacheDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {cacheLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm text-muted-foreground">{t('loadingCache')}</span>
            </div>
          ) : cacheStats ? (
            <>
              <div className="grid gap-4 md:grid-cols-4">
                <div className="rounded-md border p-3 text-center">
                  <p className="text-2xl font-bold">{cacheStats.totalMb}</p>
                  <p className="text-xs text-muted-foreground">{t('totalSizeMb')}</p>
                </div>
                <div className="rounded-md border p-3 text-center">
                  <p className="text-2xl font-bold">{cacheStats.repos}</p>
                  <p className="text-xs text-muted-foreground">{t('repoClones')}</p>
                </div>
                <div className="rounded-md border p-3 text-center">
                  <p className="text-2xl font-bold">{cacheStats.diffs}</p>
                  <p className="text-xs text-muted-foreground">{t('diffCache')}</p>
                </div>
                <div className="rounded-md border p-3 text-center">
                  <p className="text-2xl font-bold">{cacheStats.llm}</p>
                  <p className="text-xs text-muted-foreground">{t('llmCache')}</p>
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={clearCacheMutation.isPending}
                  onClick={() => clearCacheMutation.mutate('all')}
                >
                  {clearingLevel === 'all' ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" />
                  )}
                  {t('clearAll')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={clearCacheMutation.isPending}
                  onClick={() => clearCacheMutation.mutate('llm')}
                >
                  {clearingLevel === 'llm' && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {t('clearLlm')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={clearCacheMutation.isPending}
                  onClick={() => clearCacheMutation.mutate('diffs')}
                >
                  {clearingLevel === 'diffs' && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  {t('clearDiffs')}
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('failedCache')}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
