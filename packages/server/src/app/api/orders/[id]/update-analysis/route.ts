import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { Prisma } from '@prisma/client';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { getLlmConfig, getConcurrencyConfig } from '@/lib/llm-config';
import { resolveEffectiveContext, configFromSnapshot } from '@/lib/services/model-context';
import { buildAnalysisJobLlmProfileFromSnapshot, withSplitModelSnapshot } from '@/lib/services/job-llm-profile';
import { analysisLogger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const order = await prisma.order.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!order) return apiError('Order not found', 404);
  if (order.status !== 'COMPLETED') {
    return apiError('Order must be completed before updating', 400);
  }

  // Get last completed *analysis* job — exclude benchmarks to avoid inheriting
  // a benchmark model's context window into production incremental runs.
  const lastJob = await prisma.analysisJob.findFirst({
    where: { orderId: id, type: 'analysis', status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
    select: { lastAnalyzedShas: true, llmConfigSnapshot: true },
  });

  // Resolve effective context: prefer snapshot from previous analysis job.
  let effectiveContextLength: number | undefined;
  let rawContextLength: number | undefined;
  let snapshotConfig: Prisma.InputJsonValue | undefined;

  const prevSnapshot = lastJob?.llmConfigSnapshot as Record<string, unknown> | null;
  if (prevSnapshot?.effectiveContextLength != null) {
    // Snapshot already has context — reuse as-is for consistency
    effectiveContextLength = Number(prevSnapshot.effectiveContextLength);
    rawContextLength = prevSnapshot.contextLength != null ? Number(prevSnapshot.contextLength) : undefined;
    const cloned = JSON.parse(JSON.stringify(prevSnapshot)) as Record<string, unknown>;
    if (cloned.openrouter && typeof cloned.openrouter === 'object') {
      (cloned.openrouter as Record<string, unknown>).apiKey = undefined;
    }
    cloned.concurrency = await getConcurrencyConfig();
    snapshotConfig = cloned as Prisma.InputJsonValue;
  } else if (prevSnapshot) {
    // Snapshot exists but lacks context — resolve against the snapshot's model,
    // not current global settings, to preserve FD routing consistency.
    try {
      const snapshotLlmConfig = configFromSnapshot(prevSnapshot);
      const resolveConfig = snapshotLlmConfig ?? await getLlmConfig();
      const ctx = await resolveEffectiveContext(resolveConfig);
      rawContextLength = ctx.rawContextLength;
      effectiveContextLength = ctx.effectiveContextLength;
      // Enrich existing snapshot with context fields
      const enriched = JSON.parse(JSON.stringify(prevSnapshot)) as Record<string, unknown>;
      if (enriched.openrouter && typeof enriched.openrouter === 'object') {
        (enriched.openrouter as Record<string, unknown>).apiKey = undefined;
      }
      enriched.contextLength = rawContextLength;
      enriched.effectiveContextLength = effectiveContextLength;
      enriched.concurrency = await getConcurrencyConfig();
      snapshotConfig = enriched as Prisma.InputJsonValue;
    } catch (err) {
      analysisLogger.warn({ err, orderId: id }, 'Update-analysis: failed to resolve context from snapshot model');
    }
  } else {
    // No previous snapshot at all — resolve from current settings
    try {
      const llmConfig = await getLlmConfig();
      const ctx = await resolveEffectiveContext(llmConfig);
      rawContextLength = ctx.rawContextLength;
      effectiveContextLength = ctx.effectiveContextLength;
      snapshotConfig = {
        ...llmConfig,
        openrouter: { ...llmConfig.openrouter, apiKey: undefined },
        contextLength: rawContextLength,
        effectiveContextLength,
        concurrency: await getConcurrencyConfig(),
      } as unknown as Prisma.InputJsonValue;
      snapshotConfig = withSplitModelSnapshot(snapshotConfig as Record<string, unknown>) as Prisma.InputJsonValue;
    } catch (err) {
      analysisLogger.warn({ err, orderId: id }, 'Update-analysis: failed to resolve context');
    }
  }

  if (snapshotConfig) {
    snapshotConfig = withSplitModelSnapshot(snapshotConfig as Record<string, unknown>) as Prisma.InputJsonValue;
  }

  // Create new job with last analyzed SHAs for incremental analysis
  const job = await prisma.analysisJob.create({
    data: {
      orderId: id,
      status: 'PENDING',
      ...(lastJob?.lastAnalyzedShas && { lastAnalyzedShas: lastJob.lastAnalyzedShas }),
      ...(snapshotConfig && { llmConfigSnapshot: snapshotConfig }),
      ...(snapshotConfig && buildAnalysisJobLlmProfileFromSnapshot(snapshotConfig)),
    },
  });

  try {
    await processAnalysisJob(job.id, {
      ...(effectiveContextLength != null && { contextLength: effectiveContextLength }),
    });
    return apiResponse({ jobId: job.id, status: 'COMPLETED' });
  } catch (error) {
    return apiError('Update analysis failed', 500);
  }
}
