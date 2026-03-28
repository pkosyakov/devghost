import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { Prisma } from '@prisma/client';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { auditLog } from '@/lib/audit';
import { analysisLogger } from '@/lib/logger';
import { getLlmConfig } from '@/lib/llm-config';
import { appendJobEvent } from '@/lib/services/job-event-service';
import { resolveEffectiveContext, configFromSnapshot } from '@/lib/services/model-context';

type CacheMode = 'any' | 'model' | 'off';

function normalizeCacheMode(value: string | null | undefined): CacheMode {
  if (value === 'any' || value === 'off') return value;
  return 'model';
}

function sanitizeSnapshot(snapshot: unknown): Prisma.InputJsonValue | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const cloned = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
  const openrouter = cloned.openrouter;
  if (openrouter && typeof openrouter === 'object') {
    (openrouter as Record<string, unknown>).apiKey = undefined;
  }
  return cloned as Prisma.InputJsonValue;
}

function snapshotProviderAndModel(snapshot: Prisma.InputJsonValue): { provider: string | null; model: string | null } {
  const snap = snapshot as Record<string, unknown>;
  const provider = typeof snap.provider === 'string' ? snap.provider : null;
  const openrouter = (snap.openrouter ?? {}) as Record<string, unknown>;
  const ollama = (snap.ollama ?? {}) as Record<string, unknown>;
  const model = provider === 'openrouter'
    ? (typeof openrouter.model === 'string' ? openrouter.model : null)
    : (typeof ollama.model === 'string' ? ollama.model : null);
  return { provider, model };
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) return apiError('Order not found', 404);

  const pipelineMode = process.env.PIPELINE_MODE ?? 'local';
  if (pipelineMode === 'modal' && (!process.env.MODAL_ENDPOINT_URL || !process.env.MODAL_WEBHOOK_SECRET)) {
    return apiError('Modal trigger is not configured', 500);
  }

  // Inherit cache mode / snapshot from recent analysis jobs to preserve run semantics.
  const recentJobs = await prisma.analysisJob.findMany({
    where: { orderId: id, type: 'analysis' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { cacheMode: true, llmConfigSnapshot: true },
  });
  const cacheMode = normalizeCacheMode(recentJobs.find(j => !!j.cacheMode)?.cacheMode);

  let snapshotConfig = sanitizeSnapshot(
    recentJobs.find(j => j.llmConfigSnapshot != null)?.llmConfigSnapshot,
  );
  if (!snapshotConfig) {
    try {
      const llmConfig = await getLlmConfig();
      snapshotConfig = {
        ...llmConfig,
        openrouter: {
          ...llmConfig.openrouter,
          apiKey: undefined,
        },
      } as unknown as Prisma.InputJsonValue;
    } catch (err) {
      analysisLogger.error({ err, orderId: id }, 'Admin rerun failed to build llm snapshot');
      return apiError('Failed to load LLM config for rerun', 500);
    }
  }

  // Extract or resolve effective context from snapshot.
  // When context is missing, resolve against the snapshot's own provider/model
  // (not current global settings) to preserve FD routing consistency for reruns.
  let effectiveContextLength: number | undefined;
  const snap = snapshotConfig as Record<string, unknown>;
  if (snap?.effectiveContextLength != null) {
    effectiveContextLength = Number(snap.effectiveContextLength);
  } else {
    try {
      const snapshotLlmConfig = configFromSnapshot(snap);
      const resolveConfig = snapshotLlmConfig ?? await getLlmConfig();
      const ctx = await resolveEffectiveContext(resolveConfig);
      effectiveContextLength = ctx.effectiveContextLength;
      snap.contextLength = ctx.rawContextLength;
      snap.effectiveContextLength = ctx.effectiveContextLength;
      analysisLogger.info(
        { orderId: id, effectiveContextLength },
        'Admin rerun: resolved context from snapshot model',
      );
    } catch (err) {
      analysisLogger.warn({ err, orderId: id }, 'Admin rerun: failed to resolve context');
    }
  }

  // Atomically: check status + create job + mark order PROCESSING.
  const job = await prisma.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id }, select: { status: true } });
    if (current?.status === 'PROCESSING') {
      throw new Error('ALREADY_PROCESSING');
    }

    const activeJob = await tx.analysisJob.findFirst({
      where: { orderId: id, status: { in: ['PENDING', 'RUNNING'] } },
      select: { id: true },
    });
    if (activeJob) {
      throw new Error('ALREADY_PROCESSING');
    }

    const newJob = await tx.analysisJob.create({
      data: {
        orderId: id,
        status: 'PENDING',
        executionMode: pipelineMode === 'modal' ? 'modal' : 'local',
        cacheMode,
        skipBilling: true,
        forceRecalculate: false,
        llmConfigSnapshot: snapshotConfig,
      },
    });

    await tx.order.update({
      where: { id },
      data: {
        status: 'PROCESSING',
        repositoriesProcessed: 0,
        repositoriesFailed: 0,
        errorMessage: null,
      },
    });

    return newJob;
  }).catch((err) => {
    if (err.message === 'ALREADY_PROCESSING') return null;
    throw err;
  });

  if (!job) {
    return apiError('Analysis already in progress', 409);
  }

  const { provider, model } = snapshotProviderAndModel(snapshotConfig);
  await appendJobEvent({
    jobId: job.id,
    phase: 'launch',
    code: 'JOB_CREATED',
    message: 'Admin rerun job created',
    payload: {
      source: 'admin_ui_rerun',
      pipelineMode,
      cacheMode,
      skipBilling: true,
      forceRecalculate: false,
      resumeFromExisting: true,
    },
  });
  await appendJobEvent({
    jobId: job.id,
    phase: 'launch',
    code: 'LLM_SNAPSHOT_SAVED',
    message: 'LLM config snapshot saved for admin rerun',
    payload: { provider, model },
  });

  await auditLog({
    userId: session.user.id,
    action: 'admin.order.rerun',
    targetType: 'Order',
    targetId: id,
    details: { jobId: job.id, cacheMode, resumeFromExisting: true },
  });

  if (pipelineMode === 'modal') {
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
        await appendJobEvent({
          jobId: job.id,
          phase: 'launch',
          code: 'MODAL_TRIGGER_ACCEPTED',
          message: 'Modal accepted admin rerun job',
          payload: { modalCallId: data.modal_call_id, source: 'admin_ui_rerun' },
        });
      } else {
        await appendJobEvent({
          jobId: job.id,
          level: 'warn',
          phase: 'launch',
          code: 'MODAL_TRIGGER_HTTP_FAIL',
          message: 'Modal trigger failed for admin rerun; watchdog will retry',
          payload: { httpStatus: resp.status, source: 'admin_ui_rerun' },
        });
      }
    } catch (err) {
      await appendJobEvent({
        jobId: job.id,
        level: 'warn',
        phase: 'launch',
        code: 'MODAL_TRIGGER_NETWORK_FAIL',
        message: 'Modal trigger network error for admin rerun; watchdog will retry',
        payload: { error: String(err), source: 'admin_ui_rerun' },
      });
    }
  } else {
    processAnalysisJob(job.id, {
      cacheMode,
      forceRecalculate: false,
      skipBillingOverride: true,
      ...(effectiveContextLength != null && { contextLength: effectiveContextLength }),
    }).catch((err) => {
      analysisLogger.error({ err, jobId: job.id }, 'Admin rerun failed');
    });
  }

  return apiResponse({ jobId: job.id, status: 'PROCESSING' });
}
