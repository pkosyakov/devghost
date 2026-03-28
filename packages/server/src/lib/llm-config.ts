// Server-level LLM configuration.
// Primary source: SystemSettings table in DB.
// Fallback: env vars (used to seed initial DB record).

import prisma from '@/lib/db';

export type LlmProvider = 'ollama' | 'openrouter';

export interface LlmConfig {
  provider: LlmProvider;
  ollama: {
    url: string;
    model: string;
  };
  openrouter: {
    apiKey: string;
    model: string;
    inputPrice: number;  // $ per million tokens
    outputPrice: number; // $ per million tokens
    providerOrder: string[];
    providerIgnore: string[];
    allowFallbacks: boolean;
    requireParameters: boolean;
  };
}

function parseCsv(value: string | undefined | null, fallbackCsv: string): string[] {
  const raw = (value ?? fallbackCsv).trim();
  return raw.split(',').map(v => v.trim()).filter(Boolean);
}

function parseBool(value: string | undefined | null, fallback: boolean): boolean {
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Read LLM config from DB (SystemSettings singleton).
 * If no record exists, creates one from env vars (upsert).
 */
export async function getLlmConfig(): Promise<LlmConfig> {
  const settings = await prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    update: {} as any,
    create: {
      id: 'singleton',
      llmProvider: process.env.LLM_PROVIDER || 'openrouter',
      ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
      ollamaModel: process.env.OLLAMA_MODEL || 'qwen2.5-coder:32b',
      openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
      openrouterModel: process.env.OPENROUTER_MODEL || 'qwen/qwen3-coder-next',
      openrouterProviderOrder: process.env.OPENROUTER_PROVIDER_ORDER || '',
      openrouterProviderIgnore: process.env.OPENROUTER_PROVIDER_IGNORE || '',
      openrouterAllowFallbacks: parseBool(process.env.OPENROUTER_ALLOW_FALLBACKS, true),
      openrouterRequireParameters: parseBool(process.env.OPENROUTER_REQUIRE_PARAMETERS, true),
      openrouterInputPrice: 0.12,
      openrouterOutputPrice: 0.75,
      demoLiveMode: false,
    } as any,
  });

  const settingsAny = settings as typeof settings & {
    openrouterProviderOrder?: string;
    openrouterProviderIgnore?: string;
    openrouterAllowFallbacks?: boolean;
    openrouterRequireParameters?: boolean;
  };

  const provider = settings.llmProvider as LlmProvider;

  if (provider !== 'ollama' && provider !== 'openrouter') {
    throw new Error(
      `Invalid llmProvider "${provider}". Must be "ollama" or "openrouter".`
    );
  }

  // Fallback to env var if DB has empty API key
  const openrouterApiKey = settings.openrouterApiKey || process.env.OPENROUTER_API_KEY || '';

  const config: LlmConfig = {
    provider,
    ollama: {
      url: settings.ollamaUrl,
      model: settings.ollamaModel,
    },
    openrouter: {
      apiKey: openrouterApiKey,
      model: settings.openrouterModel,
      inputPrice: Number(settings.openrouterInputPrice),
      outputPrice: Number(settings.openrouterOutputPrice),
      providerOrder: parseCsv(
        settingsAny.openrouterProviderOrder,
        process.env.OPENROUTER_PROVIDER_ORDER || '',
      ),
      providerIgnore: parseCsv(
        settingsAny.openrouterProviderIgnore,
        process.env.OPENROUTER_PROVIDER_IGNORE || '',
      ),
      allowFallbacks: settingsAny.openrouterAllowFallbacks ??
        parseBool(process.env.OPENROUTER_ALLOW_FALLBACKS, true),
      requireParameters: settingsAny.openrouterRequireParameters ??
        parseBool(process.env.OPENROUTER_REQUIRE_PARAMETERS, true),
    },
  };

  if (provider === 'openrouter' && !config.openrouter.apiKey) {
    throw new Error(
      'LLM provider is "openrouter" but API key is not configured. ' +
      'Set it in Admin Settings or via OPENROUTER_API_KEY env var.'
    );
  }

  return config;
}

/**
 * Synchronous fallback — reads only from env vars.
 * Use only when async is not possible (e.g. module-level init).
 */
export function getLlmConfigSync(): LlmConfig {
  const provider = (process.env.LLM_PROVIDER || 'openrouter') as LlmProvider;

  if (provider !== 'ollama' && provider !== 'openrouter') {
    throw new Error(
      `Invalid LLM_PROVIDER "${provider}". Must be "ollama" or "openrouter".`
    );
  }

  return {
    provider,
    ollama: {
      url: process.env.OLLAMA_URL || 'http://localhost:11434',
      model: process.env.OLLAMA_MODEL || 'qwen2.5-coder:32b',
    },
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY || '',
      model: process.env.OPENROUTER_MODEL || 'qwen/qwen3-coder-next',
      inputPrice: 0.12,
      outputPrice: 0.75,
      providerOrder: parseCsv(process.env.OPENROUTER_PROVIDER_ORDER, ''),
      providerIgnore: parseCsv(process.env.OPENROUTER_PROVIDER_IGNORE, ''),
      allowFallbacks: parseBool(process.env.OPENROUTER_ALLOW_FALLBACKS, true),
      requireParameters: parseBool(process.env.OPENROUTER_REQUIRE_PARAMETERS, true),
    },
  };
}
