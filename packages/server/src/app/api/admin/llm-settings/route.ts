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
    openrouterProviderOrder: settings.openrouterProviderOrder ?? process.env.OPENROUTER_PROVIDER_ORDER ?? 'Chutes',
    openrouterProviderIgnore: settings.openrouterProviderIgnore ?? process.env.OPENROUTER_PROVIDER_IGNORE ?? 'Cloudflare',
    openrouterAllowFallbacks: settings.openrouterAllowFallbacks ?? true,
    openrouterRequireParameters: settings.openrouterRequireParameters ?? true,
    openrouterInputPrice: Number(settings.openrouterInputPrice),
    openrouterOutputPrice: Number(settings.openrouterOutputPrice),
    demoLiveMode: settings.demoLiveMode ?? false,
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
      llmProvider: 'ollama',
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'qwen2.5-coder:32b',
      openrouterApiKey: !!process.env.OPENROUTER_API_KEY ? '(env)' : '',
      openrouterModel: 'qwen/qwen-2.5-coder-32b-instruct',
      openrouterKeySource: process.env.OPENROUTER_API_KEY ? 'env' : 'none',
      openrouterProviderOrder: process.env.OPENROUTER_PROVIDER_ORDER || 'Chutes',
      openrouterProviderIgnore: process.env.OPENROUTER_PROVIDER_IGNORE || 'Cloudflare',
      openrouterAllowFallbacks: envBool('OPENROUTER_ALLOW_FALLBACKS', true),
      openrouterRequireParameters: envBool('OPENROUTER_REQUIRE_PARAMETERS', true),
      openrouterInputPrice: 0.03,
      openrouterOutputPrice: 0.11,
      demoLiveMode: false,
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
        openrouterProviderOrder: data.openrouterProviderOrder ?? process.env.OPENROUTER_PROVIDER_ORDER ?? 'Chutes',
        openrouterProviderIgnore: data.openrouterProviderIgnore ?? process.env.OPENROUTER_PROVIDER_IGNORE ?? 'Cloudflare',
        openrouterAllowFallbacks: data.openrouterAllowFallbacks ?? envBool('OPENROUTER_ALLOW_FALLBACKS', true),
        openrouterRequireParameters: data.openrouterRequireParameters ?? envBool('OPENROUTER_REQUIRE_PARAMETERS', true),
        demoLiveMode: data.demoLiveMode ?? false,
      } as any,
    });

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
