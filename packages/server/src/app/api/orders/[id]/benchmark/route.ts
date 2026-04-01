import crypto from 'crypto';
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, parseBody, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { checkOllamaHealth } from '@/lib/services/pipeline-bridge';
import { getLlmConfig, getConcurrencySnapshot } from '@/lib/llm-config';
import type { LlmConfig } from '@/lib/llm-config';
import { analysisLogger } from '@/lib/logger';
import { benchmarkSchema } from '@/lib/schemas';
import { DEFAULT_CTX, clampContext, resolveModelContext, computeEffectiveContext } from '@/lib/services/model-context';
import { resolveBenchmarkProfile } from '@/lib/services/benchmark-profile';

// POST /api/orders/[id]/benchmark — trigger a benchmark run
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, benchmarkSchema);
  if (!parsed.success) return parsed.error;
  const body = parsed.data;

  const order = await prisma.order.findFirst({
    where: { id },
  });
  if (!order) return apiError('Order not found', 404);

  if (order.status !== 'COMPLETED') {
    return apiError('Order must be COMPLETED to benchmark', 400);
  }

  // Guard against ANY concurrent job (analysis or benchmark)
  const runningJob = await prisma.analysisJob.findFirst({
    where: { orderId: id, type: { in: ['analysis', 'benchmark'] }, status: { in: ['PENDING', 'RUNNING'] } },
  });
  if (runningJob) {
    return apiError('A job is already in progress', 409);
  }

  // Branch: profile-based (rollout candidate) vs model-based (ad-hoc experiment)
  const isProfileMode = 'profile' in body;

  let provider: 'ollama' | 'openrouter';
  let model: string;
  let promptRepeat: boolean;
  let fdV3Enabled: boolean;
  let fdLargeModel: string | null;
  let fdLargeProvider: string | null;
  let benchmarkProfile: string | null = null;
  let benchmarkProfileLabel: string | null = null;

  if (isProfileMode) {
    const profile = resolveBenchmarkProfile(body.profile);
    provider = profile.provider;
    model = profile.model;
    promptRepeat = profile.promptRepeat;
    fdV3Enabled = profile.fdV3Enabled;
    fdLargeModel = profile.fdLargeModel;
    fdLargeProvider = profile.fdLargeProvider;
    benchmarkProfile = profile.id;
    benchmarkProfileLabel = profile.label;
  } else {
    provider = body.provider;
    model = body.model;
    promptRepeat = !!body.promptRepeat;
    // Ad-hoc mode: inherit FD config from current env
    fdV3Enabled = process.env.FD_V3_ENABLED?.toLowerCase() === 'true' || process.env.FD_V3_ENABLED === '1';
    fdLargeModel = process.env.FD_LARGE_LLM_MODEL?.trim() || null;
    fdLargeProvider = process.env.FD_LARGE_LLM_PROVIDER?.trim().toLowerCase() || null;
  }

  // Health check adapts to provider
  const llmConfig = await getLlmConfig();
  let serverContextLength: number | null = null;

  if (provider === 'ollama') {
    const ollamaUrl = llmConfig.ollama.url;
    const healthy = await checkOllamaHealth(ollamaUrl);
    if (!healthy) {
      return apiError(`Ollama is not reachable at ${ollamaUrl}`, 503);
    }

    const baseUrl = ollamaUrl.replace(/\/+$/, '');

    // Verify model exists via /api/tags
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const tagsRes = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timeout);

      if (!tagsRes.ok) {
        return apiError(`Failed to list Ollama models (HTTP ${tagsRes.status})`, 503);
      }
      const tagsData = await tagsRes.json() as { models?: Array<{ name: string }> };
      const modelNames = (tagsData.models ?? []).map(m => m.name);
      if (!modelNames.some(n => n === model || n.startsWith(`${model}:`))) {
        return apiError(
          `Model "${model}" not found in Ollama. Available: ${modelNames.join(', ')}`,
          400,
        );
      }
    } catch (err) {
      if (err instanceof Response) throw err;
      return apiError(`Failed to verify Ollama model: ${err}`, 503);
    }

    // Fetch actual context_length from model metadata
    serverContextLength = await resolveModelContext({
      ...llmConfig,
      provider: 'ollama',
      ollama: { ...llmConfig.ollama, model },
    });
  } else {
    // OpenRouter — two-step validation
    const apiKey = llmConfig.openrouter.apiKey;
    if (!apiKey) {
      return apiError('OpenRouter API key is not configured', 400);
    }

    // Step 1: verify API key + extract model context from catalog
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const modelsRes = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!modelsRes.ok) {
        return apiError(`OpenRouter API key validation failed (HTTP ${modelsRes.status})`, 503);
      }
      const modelsData = await modelsRes.json();
      const catalogEntry = (modelsData.data || []).find((m: any) => m.id === model);
      if (catalogEntry?.context_length) {
        serverContextLength = catalogEntry.context_length;
      }
    } catch (err) {
      return apiError(`OpenRouter is not reachable: ${err}`, 503);
    }

    // Step 2: lightweight preflight — verify model works with strict JSON mode
    // No provider routing — benchmark tests arbitrary models,
    // system routing rules are tuned for the default model and may reject others.
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const preflightRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Respond with json {}' }],
          max_tokens: 10,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'test',
              strict: true,
              schema: {
                type: 'object',
                properties: { ok: { type: 'boolean' } },
                required: ['ok'],
                additionalProperties: false,
              },
            },
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!preflightRes.ok) {
        const errBody = await preflightRes.text().catch(() => '');
        return apiError(
          `OpenRouter preflight failed for model "${model}" (HTTP ${preflightRes.status}): ${errBody.slice(0, 300)}`,
          400,
        );
      }
    } catch (err) {
      return apiError(`OpenRouter preflight request failed: ${err}`, 503);
    }
  }

  // Build resolved config with selected provider+model
  const resolvedConfig: LlmConfig = {
    ...llmConfig,
    provider,
  };
  if (provider === 'ollama') {
    resolvedConfig.ollama = { ...llmConfig.ollama, model };
  } else {
    resolvedConfig.openrouter = {
      ...llmConfig.openrouter,
      model,
      providerOrder: [],
      providerIgnore: [],
      allowFallbacks: false,
      requireParameters: true,
    };
  }

  // Context window — server-validated value preferred, client/default as fallback
  const clientCtx = !isProfileMode && typeof body.contextLength === 'number' && body.contextLength > 0
    ? body.contextLength
    : DEFAULT_CTX;
  const rawContextLength = clampContext(serverContextLength ?? clientCtx);
  const effectiveContextLength = computeEffectiveContext(rawContextLength, provider);

  // Snapshot: full config minus secrets
  const snapshot = {
    ...resolvedConfig,
    openrouter: { ...resolvedConfig.openrouter, apiKey: '[REDACTED]' },
    contextLength: rawContextLength,
    effectiveContextLength,
    promptRepeat,
    fdV3Enabled,
    fdLargeModel,
    fdLargeProvider,
    benchmarkProfile,
    benchmarkProfileLabel,
    concurrency: getConcurrencySnapshot(),
  };

  // Fingerprint: hash of config-relevant fields
  const fpData = JSON.stringify({
    ...(benchmarkProfile ? { benchmarkProfile } : {}),
    provider, model,
    contextLength: effectiveContextLength,
    fdV3Enabled,
    fdLargeModel,
    fdLargeProvider,
    promptRepeat,
    ...(provider === 'openrouter' && !isProfileMode ? {
      providerOrder: resolvedConfig.openrouter.providerOrder,
      providerIgnore: resolvedConfig.openrouter.providerIgnore,
      allowFallbacks: resolvedConfig.openrouter.allowFallbacks,
      requireParameters: resolvedConfig.openrouter.requireParameters,
    } : {}),
  });
  const fingerprint = crypto.createHash('sha256').update(fpData).digest('hex').slice(0, 16);

  // Find latest completed analysis job as base
  const baseJob = await prisma.analysisJob.findFirst({
    where: { orderId: id, type: 'analysis', status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
  });
  if (!baseJob) {
    return apiError('No completed analysis found to benchmark against', 400);
  }

  const job = await prisma.analysisJob.create({
    data: {
      orderId: id,
      status: 'PENDING',
      type: 'benchmark',
      baseJobId: baseJob.id,
      llmProvider: provider,
      llmModel: model,
      llmConfigSnapshot: snapshot,
      llmConfigFingerprint: fingerprint,
    },
  });

  const pipelineMode = process.env.PIPELINE_MODE || 'local';

  if (pipelineMode === 'modal') {
    // Save pipeline flags for Modal worker to read
    await prisma.analysisJob.update({
      where: { id: job.id },
      data: {
        executionMode: 'modal',
        cacheMode: 'off',
        skipBilling: true,
      },
    });

    // Trigger Modal — if fails, job stays PENDING, watchdog retries
    try {
      const resp = await fetch(process.env.MODAL_ENDPOINT_URL!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: job.id,
          auth_token: process.env.MODAL_WEBHOOK_SECRET,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        await prisma.analysisJob.update({
          where: { id: job.id },
          data: { modalCallId: data.modal_call_id },
        });
      } else {
        analysisLogger.warn(
          { status: resp.status, jobId: job.id },
          'Modal benchmark trigger failed — job stays PENDING for watchdog retry',
        );
      }
    } catch (err) {
      analysisLogger.warn(
        { err, jobId: job.id },
        'Modal benchmark trigger network error — job stays PENDING for watchdog retry',
      );
    }
  } else {
    // Local mode — fire-and-forget, client polls /progress
    processAnalysisJob(job.id, {
      isBenchmark: true,
      llmConfigOverride: resolvedConfig,
      noLlmCache: true,
      contextLength: effectiveContextLength,
      failFast: true,
      promptRepeat,
    }).catch((err) => {
      analysisLogger.error({ err, jobId: job.id, orderId: id }, 'Benchmark failed');
    });
  }

  return apiResponse({ jobId: job.id, status: 'PENDING' });
}

// GET /api/orders/[id]/benchmark — list benchmark runs
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const order = await prisma.order.findFirst({
    where: { id },
    select: { id: true },
  });
  if (!order) return apiError('Order not found', 404);

  const benchmarks = await prisma.analysisJob.findMany({
    where: { orderId: id, type: 'benchmark' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      llmProvider: true,
      llmModel: true,
      totalLlmCalls: true,
      totalPromptTokens: true,
      totalCompletionTokens: true,
      progress: true,
      currentStep: true,
      currentCommit: true,
      totalCommits: true,
      error: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
    },
  });

  return apiResponse(benchmarks);
}
