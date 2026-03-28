/**
 * Model Context Resolution — shared helper for resolving real model context length.
 *
 * Used by benchmark, analyze, update-analysis, and admin rerun routes to compute
 * the effective context length for the Python pipeline's FD threshold calculation.
 */
import type { LlmConfig } from '@/lib/llm-config';
import { analysisLogger } from '@/lib/logger';

// Context window boundaries — mirrors Python pipeline constants in run_v16_pipeline.py
export const DEFAULT_CTX = 32768;
export const MIN_CONTEXT = 4096;
export const MAX_CONTEXT = 262144;

/** OpenRouter safety factor — 25% reserved for provider routing overhead. */
const OPENROUTER_SAFETY_FACTOR = 0.75;

/** Clamp a raw context value to [MIN_CONTEXT, MAX_CONTEXT]. */
export function clampContext(raw: number): number {
  return Math.max(MIN_CONTEXT, Math.min(MAX_CONTEXT, raw));
}

/**
 * Resolve raw model context length from the active provider's metadata.
 *
 * - Ollama: fetches `/api/show` for the model and reads `*.context_length` from model_info.
 * - OpenRouter: fetches `/api/v1/models` catalog and reads `context_length` for the model.
 *
 * Returns null if resolution fails (caller should fall back to DEFAULT_CTX).
 * This function does NOT perform health checks or preflight validation.
 */
export async function resolveModelContext(
  config: LlmConfig,
): Promise<number | null> {
  const log = analysisLogger.child({ fn: 'resolveModelContext' });

  try {
    if (config.provider === 'ollama') {
      return await resolveOllamaContext(config.ollama.url, config.ollama.model);
    } else {
      return await resolveOpenRouterContext(config.openrouter.apiKey, config.openrouter.model);
    }
  } catch (err) {
    log.warn({ err, provider: config.provider }, 'Context resolution failed, will use default');
    return null;
  }
}

/**
 * Compute the effective context length that the pipeline should use.
 *
 * - Applies 0.75x safety factor for OpenRouter (provider routing overhead).
 * - Ollama uses the raw value as-is.
 * - Result is clamped to [MIN_CONTEXT, MAX_CONTEXT].
 */
export function computeEffectiveContext(
  rawContextLength: number,
  provider: 'ollama' | 'openrouter',
): number {
  const adjusted = provider === 'openrouter'
    ? Math.floor(rawContextLength * OPENROUTER_SAFETY_FACTOR)
    : rawContextLength;
  return clampContext(adjusted);
}

/**
 * Full context resolution pipeline: resolve raw context → compute effective context.
 *
 * Returns { rawContextLength, effectiveContextLength } for snapshot storage.
 */
export async function resolveEffectiveContext(
  config: LlmConfig,
): Promise<{ rawContextLength: number; effectiveContextLength: number }> {
  const serverCtx = await resolveModelContext(config);
  const rawContextLength = clampContext(serverCtx ?? DEFAULT_CTX);
  const effectiveContextLength = computeEffectiveContext(rawContextLength, config.provider);
  return { rawContextLength, effectiveContextLength };
}

/**
 * Reconstruct a minimal LlmConfig from a persisted llmConfigSnapshot.
 *
 * Used by rerun/update-analysis paths to resolve context against the snapshot's
 * provider/model rather than the current global settings (which may have changed).
 * Returns null if the snapshot doesn't contain enough info to identify a provider+model.
 */
export function configFromSnapshot(
  snapshot: Record<string, unknown>,
): LlmConfig | null {
  const provider = snapshot.provider;
  if (provider !== 'ollama' && provider !== 'openrouter') return null;

  const ollama = (snapshot.ollama ?? {}) as Record<string, unknown>;
  const openrouter = (snapshot.openrouter ?? {}) as Record<string, unknown>;

  const model = provider === 'openrouter'
    ? (typeof openrouter.model === 'string' ? openrouter.model : null)
    : (typeof ollama.model === 'string' ? ollama.model : null);
  if (!model) return null;

  return {
    provider,
    ollama: {
      url: typeof ollama.url === 'string' ? ollama.url : 'http://localhost:11434',
      model: typeof ollama.model === 'string' ? ollama.model : '',
    },
    openrouter: {
      apiKey: typeof openrouter.apiKey === 'string' ? openrouter.apiKey : (process.env.OPENROUTER_API_KEY ?? ''),
      model: typeof openrouter.model === 'string' ? openrouter.model : '',
      inputPrice: 0,
      outputPrice: 0,
      providerOrder: [],
      providerIgnore: [],
      allowFallbacks: true,
      requireParameters: true,
    },
  };
}

// ── Internal helpers ──

async function resolveOllamaContext(
  ollamaUrl: string,
  model: string,
): Promise<number | null> {
  const baseUrl = ollamaUrl.replace(/\/+$/, '');
  const resp = await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model }),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return null;

  const info = await resp.json();
  const ctxEntry = Object.entries(info.model_info || {})
    .find(([k]) => k.endsWith('.context_length'));
  return ctxEntry ? Number(ctxEntry[1]) : null;
}

async function resolveOpenRouterContext(
  apiKey: string,
  model: string,
): Promise<number | null> {
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return null;

    const data = await resp.json();
    const entry = (data.data || []).find((m: any) => m.id === model);
    return entry?.context_length ? Number(entry.context_length) : null;
  } finally {
    clearTimeout(timeout);
  }
}
