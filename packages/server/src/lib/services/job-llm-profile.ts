import type { LlmConfig } from '@/lib/llm-config';

type Provider = 'openrouter' | 'ollama';

export interface AnalysisJobLlmProfileFields {
  llmProvider: string | null;
  llmModel: string | null;
  smallLlmProvider: string | null;
  smallLlmModel: string | null;
  largeLlmProvider: string | null;
  largeLlmModel: string | null;
  fdV3Enabled: boolean;
}

function normalizeProvider(value: unknown): Provider | null {
  return value === 'openrouter' || value === 'ollama' ? value : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function envFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function readFdSplitEnv(): {
  fdV3Enabled: boolean;
  largeLlmProvider: string | null;
  largeLlmModel: string | null;
} {
  return {
    fdV3Enabled: envFlag('FD_V3_ENABLED'),
    largeLlmProvider: normalizeString(process.env.FD_LARGE_LLM_PROVIDER)?.toLowerCase() ?? null,
    largeLlmModel: normalizeString(process.env.FD_LARGE_LLM_MODEL),
  };
}

export function buildAnalysisJobLlmProfile(input: {
  smallLlmProvider: string | null;
  smallLlmModel: string | null;
  fdV3Enabled?: boolean | null;
  largeLlmProvider?: string | null;
  largeLlmModel?: string | null;
}): AnalysisJobLlmProfileFields {
  const envProfile = readFdSplitEnv();
  const fdV3Enabled = input.fdV3Enabled ?? envProfile.fdV3Enabled;
  const largeLlmProvider = input.largeLlmProvider === undefined
    ? envProfile.largeLlmProvider
    : normalizeString(input.largeLlmProvider)?.toLowerCase() ?? null;
  const largeLlmModel = input.largeLlmModel === undefined
    ? envProfile.largeLlmModel
    : normalizeString(input.largeLlmModel);

  return {
    llmProvider: input.smallLlmProvider,
    llmModel: input.smallLlmModel,
    smallLlmProvider: input.smallLlmProvider,
    smallLlmModel: input.smallLlmModel,
    largeLlmProvider,
    largeLlmModel,
    fdV3Enabled,
  };
}

export function buildAnalysisJobLlmProfileFromConfig(llmConfig: LlmConfig): AnalysisJobLlmProfileFields {
  const smallLlmProvider = llmConfig.provider;
  const smallLlmModel = llmConfig.provider === 'openrouter'
    ? llmConfig.openrouter.model
    : llmConfig.ollama.model;

  return buildAnalysisJobLlmProfile({
    smallLlmProvider,
    smallLlmModel,
  });
}

export function buildAnalysisJobLlmProfileFromSnapshot(snapshot: unknown): AnalysisJobLlmProfileFields {
  const snap = snapshot && typeof snapshot === 'object'
    ? snapshot as Record<string, unknown>
    : {};
  const smallLlmProvider = normalizeProvider(snap.provider);
  const openrouter = (snap.openrouter ?? {}) as Record<string, unknown>;
  const ollama = (snap.ollama ?? {}) as Record<string, unknown>;
  const smallLlmModel = smallLlmProvider === 'openrouter'
    ? normalizeString(openrouter.model)
    : normalizeString(ollama.model);
  const fdV3Enabled = typeof snap.fdV3Enabled === 'boolean' ? snap.fdV3Enabled : undefined;
  const largeLlmProvider = normalizeString(snap.fdLargeProvider);
  const largeLlmModel = normalizeString(snap.fdLargeModel);

  return buildAnalysisJobLlmProfile({
    smallLlmProvider,
    smallLlmModel,
    fdV3Enabled,
    largeLlmProvider,
    largeLlmModel,
  });
}

export function withSplitModelSnapshot<T extends Record<string, unknown>>(snapshot: T): T & {
  fdV3Enabled: boolean;
  fdLargeProvider: string | null;
  fdLargeModel: string | null;
} {
  const envProfile = readFdSplitEnv();
  return {
    ...snapshot,
    fdV3Enabled: typeof snapshot.fdV3Enabled === 'boolean' ? snapshot.fdV3Enabled : envProfile.fdV3Enabled,
    fdLargeProvider: normalizeString(snapshot.fdLargeProvider) ?? envProfile.largeLlmProvider,
    fdLargeModel: normalizeString(snapshot.fdLargeModel) ?? envProfile.largeLlmModel,
  };
}
