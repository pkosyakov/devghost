import { NextRequest } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { logger } from '@/lib/logger';
import { auditLog } from '@/lib/audit';

const updateSchema = z.object({
  llmProvider: z.enum(['ollama', 'openrouter']).optional(),
  ollamaUrl: z.string().url().optional(),
  ollamaModel: z.string().min(1).optional(),
  openrouterApiKey: z.string().optional(),
  openrouterModel: z.string().min(1).optional(),
  openrouterProviderOrder: z.string().optional(),
  openrouterProviderIgnore: z.string().optional(),
  openrouterAllowFallbacks: z.boolean().optional(),
  openrouterRequireParameters: z.boolean().optional(),
  openrouterInputPrice: z.number().min(0).optional(),
  openrouterOutputPrice: z.number().min(0).optional(),
  demoLiveMode: z.boolean().optional(),
  demoLiveChunkSize: z.number().int().min(1).max(200).optional(),
  llmConcurrency: z.number().int().min(1).max(100).nullable().optional(),
  fdLlmConcurrency: z.number().int().min(1).max(100).nullable().optional(),
  fdLlmConcurrencyCap: z.number().int().min(1).max(64).nullable().optional(),
});

function normalizeCsv(value: string): string {
  return value
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .join(',');
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function parsePositiveInt(v: string | undefined): number | null {
  const n = parseInt(v ?? '', 10);
  return n > 0 ? n : null;
}

function concurrencySource(dbValue: number | null | undefined, envName: string): 'db' | 'env' | 'auto' {
  if (dbValue != null) return 'db';
  if (process.env[envName]) return 'env';
  return 'auto';
}

/** Read-only FD v3 large-path diagnostics from env. */
function getFdV3Diagnostics() {
  const enabled = (process.env.FD_V3_ENABLED ?? '').toLowerCase();
  return {
    fdV3Enabled: ['1', 'true', 'yes'].includes(enabled),
    fdLargeLlmProvider: process.env.FD_LARGE_LLM_PROVIDER || '',
    fdLargeLlmModel: process.env.FD_LARGE_LLM_MODEL || '',
  };
}

function formatSettings(settings: {
  llmProvider: string;
  ollamaUrl: string;
  ollamaModel: string;
  openrouterApiKey: string;
  openrouterModel: string;
  openrouterProviderOrder?: string;
  openrouterProviderIgnore?: string;
  openrouterAllowFallbacks?: boolean;
  openrouterRequireParameters?: boolean;
  openrouterInputPrice: unknown;
  openrouterOutputPrice: unknown;
  demoLiveMode?: boolean;
  demoLiveChunkSize?: number;
  llmConcurrency?: number | null;
  fdLlmConcurrency?: number | null;
  fdLlmConcurrencyCap?: number | null;
}) {
  const hasEnvKey = !!process.env.OPENROUTER_API_KEY;
  const hasDbKey = !!settings.openrouterApiKey;
  let keyDisplay = '';
  let keySource: 'db' | 'env' | 'none' = 'none';
  if (hasDbKey) { keyDisplay = '***'; keySource = 'db'; }
  else if (hasEnvKey) { keyDisplay = '(env)'; keySource = 'env'; }

  return {
    llmProvider: settings.llmProvider,
    ollamaUrl: settings.ollamaUrl,
    ollamaModel: settings.ollamaModel,
    openrouterApiKey: keyDisplay,
    openrouterModel: settings.openrouterModel,
    openrouterKeySource: keySource,
    openrouterProviderOrder: settings.openrouterProviderOrder ?? process.env.OPENROUTER_PROVIDER_ORDER ?? '',
    openrouterProviderIgnore: settings.openrouterProviderIgnore ?? process.env.OPENROUTER_PROVIDER_IGNORE ?? '',
    openrouterAllowFallbacks: settings.openrouterAllowFallbacks ?? true,
    openrouterRequireParameters: settings.openrouterRequireParameters ?? true,
    openrouterInputPrice: Number(settings.openrouterInputPrice),
    openrouterOutputPrice: Number(settings.openrouterOutputPrice),
    demoLiveMode: settings.demoLiveMode ?? false,
    demoLiveChunkSize: settings.demoLiveChunkSize ?? 10,
    // Concurrency: raw DB values (null = auto) + effective (resolved) + source
    // FD effective mirrors Python fallback: FD_LLM_CONCURRENCY → LLM_CONCURRENCY → auto
    // FD cap defaults to 32 in Python when not set
    llmConcurrency: settings.llmConcurrency ?? null,
    llmConcurrencyEffective: settings.llmConcurrency ?? parsePositiveInt(process.env.LLM_CONCURRENCY) ?? null,
    llmConcurrencySource: concurrencySource(settings.llmConcurrency, 'LLM_CONCURRENCY'),
    fdLlmConcurrency: settings.fdLlmConcurrency ?? null,
    fdLlmConcurrencyEffective: settings.fdLlmConcurrency
      ?? parsePositiveInt(process.env.FD_LLM_CONCURRENCY)
      ?? settings.llmConcurrency
      ?? parsePositiveInt(process.env.LLM_CONCURRENCY)
      ?? null,
    fdLlmConcurrencySource: concurrencySource(settings.fdLlmConcurrency, 'FD_LLM_CONCURRENCY'),
    fdLlmConcurrencyCap: settings.fdLlmConcurrencyCap ?? null,
    fdLlmConcurrencyCapEffective: settings.fdLlmConcurrencyCap
      ?? parsePositiveInt(process.env.FD_LLM_CONCURRENCY_CAP)
      ?? 32,
    fdLlmConcurrencyCapSource: concurrencySource(settings.fdLlmConcurrencyCap, 'FD_LLM_CONCURRENCY_CAP'),
    ...getFdV3Diagnostics(),
  };
}

export async function GET() {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  const settings = await prisma.systemSettings.findUnique({
    where: { id: 'singleton' },
  });

  if (!settings) {
    return apiResponse({
      llmProvider: 'openrouter',
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'qwen2.5-coder:32b',
      openrouterApiKey: !!process.env.OPENROUTER_API_KEY ? '(env)' : '',
      openrouterModel: 'qwen/qwen3-coder-next',
      openrouterKeySource: process.env.OPENROUTER_API_KEY ? 'env' : 'none',
      openrouterProviderOrder: process.env.OPENROUTER_PROVIDER_ORDER || '',
      openrouterProviderIgnore: process.env.OPENROUTER_PROVIDER_IGNORE || '',
      openrouterAllowFallbacks: envBool('OPENROUTER_ALLOW_FALLBACKS', true),
      openrouterRequireParameters: envBool('OPENROUTER_REQUIRE_PARAMETERS', true),
      openrouterInputPrice: 0.12,
      openrouterOutputPrice: 0.75,
      demoLiveMode: false,
      demoLiveChunkSize: 10,
      llmConcurrency: null,
      llmConcurrencyEffective: parsePositiveInt(process.env.LLM_CONCURRENCY) ?? null,
      llmConcurrencySource: concurrencySource(null, 'LLM_CONCURRENCY'),
      fdLlmConcurrency: null,
      fdLlmConcurrencyEffective: parsePositiveInt(process.env.FD_LLM_CONCURRENCY)
        ?? parsePositiveInt(process.env.LLM_CONCURRENCY)
        ?? null,
      fdLlmConcurrencySource: concurrencySource(null, 'FD_LLM_CONCURRENCY'),
      fdLlmConcurrencyCap: null,
      fdLlmConcurrencyCapEffective: parsePositiveInt(process.env.FD_LLM_CONCURRENCY_CAP) ?? 32,
      fdLlmConcurrencyCapSource: concurrencySource(null, 'FD_LLM_CONCURRENCY_CAP'),
      ...getFdV3Diagnostics(),
    });
  }

  return apiResponse(formatSettings(settings as any));
}

export async function PATCH(request: NextRequest) {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  try {
    const body = await request.json();
    const parsed = updateSchema.safeParse(body);

    if (!parsed.success) {
      return apiError(parsed.error.errors[0].message, 400);
    }

    const data = parsed.data;

    // Strip masked/placeholder values — don't overwrite real key with display values
    if (data.openrouterApiKey === '***' || data.openrouterApiKey === '(env)') {
      delete data.openrouterApiKey;
    }
    if (data.openrouterProviderOrder !== undefined) {
      data.openrouterProviderOrder = normalizeCsv(data.openrouterProviderOrder);
    }
    if (data.openrouterProviderIgnore !== undefined) {
      data.openrouterProviderIgnore = normalizeCsv(data.openrouterProviderIgnore);
    }

    // If switching to openrouter, require an API key (either new, existing in DB, or env var)
    if (data.llmProvider === 'openrouter' && !data.openrouterApiKey) {
      const existing = await prisma.systemSettings.findUnique({
        where: { id: 'singleton' },
        select: { openrouterApiKey: true },
      });
      const hasDbKey = !!existing?.openrouterApiKey;
      const hasEnvKey = !!process.env.OPENROUTER_API_KEY;
      if (!hasDbKey && !hasEnvKey) {
        return apiError('OpenRouter API key is required (set in settings or OPENROUTER_API_KEY env var)', 400);
      }
    }

    const settings = await prisma.systemSettings.upsert({
      where: { id: 'singleton' },
      update: data as any,
      create: {
        id: 'singleton',
        ...data,
        openrouterProviderOrder: data.openrouterProviderOrder ?? process.env.OPENROUTER_PROVIDER_ORDER ?? '',
        openrouterProviderIgnore: data.openrouterProviderIgnore ?? process.env.OPENROUTER_PROVIDER_IGNORE ?? '',
        openrouterAllowFallbacks: data.openrouterAllowFallbacks ?? envBool('OPENROUTER_ALLOW_FALLBACKS', true),
        openrouterRequireParameters: data.openrouterRequireParameters ?? envBool('OPENROUTER_REQUIRE_PARAMETERS', true),
        demoLiveMode: data.demoLiveMode ?? false,
        demoLiveChunkSize: data.demoLiveChunkSize ?? 10,
      } as any,
    });

    // Strip read-only FD v3 fields — never persist to DB via PATCH
    // (they come from env and are returned read-only by formatSettings)

    const auditDetails = { ...data };
    if (auditDetails.openrouterApiKey) {
      auditDetails.openrouterApiKey = '***';
    }

    await auditLog({
      userId: result.user.id,
      action: 'admin.settings.update',
      targetType: 'SystemSettings',
      targetId: 'singleton',
      details: auditDetails,
    });

    return apiResponse(formatSettings(settings as any));
  } catch (error) {
    logger.error({ err: error }, 'Failed to update LLM settings');
    return apiError('Failed to update settings', 500);
  }
}
