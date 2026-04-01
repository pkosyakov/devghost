import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { Prisma } from '@prisma/client';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { getAvailableBalance, isBillingEnabled, runExpiryGuard } from '@/lib/services/credit-service';
import { getLlmConfig, getConcurrencySnapshot } from '@/lib/llm-config';
import { appendJobEvent } from '@/lib/services/job-event-service';
import { resolveEffectiveContext } from '@/lib/services/model-context';
import { computeBillingPreview, type BillingPreviewScope } from '@/lib/services/analysis-billing-preview';
import { analysisLogger, billingLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rate-limit';
import { analyzeOrderSchema } from '@/lib/schemas';
import { z } from 'zod';

type AnalyzeRequestBody = z.infer<typeof analyzeOrderSchema>;

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

// POST /api/orders/[id]/analyze — Create analysis job and run pipeline
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const rateLimited = await checkRateLimit(request, 'analysis', session.user.id);
  if (rateLimited) return rateLimited;

  const order = await prisma.order.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!order) return apiError('Order not found', 404);

  // Guard against concurrent analysis
  if (order.status === 'PROCESSING') {
    return apiError('Analysis already in progress', 409);
  }

  // Parse body — allow empty body (all fields optional)
  let body: AnalyzeRequestBody;
  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = analyzeOrderSchema.safeParse(raw);
    if (!parsed.success) {
      return apiError(parsed.error.errors.map(e => e.message).join(', '), 400);
    }
    body = parsed.data;
  } catch {
    body = {} as AnalyzeRequestBody;
  }
  const cacheMode = body.cacheMode ?? 'model';

  // Semantic date range validation
  if (body.analysisPeriodMode === 'DATE_RANGE' && body.analysisStartDate && body.analysisEndDate) {
    const startDate = new Date(body.analysisStartDate);
    const endDate = new Date(body.analysisEndDate);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return apiError('Invalid date format', 400);
    }
    if (startDate > endDate) {
      return apiError('Start date must be before end date', 400);
    }
  }

  const hasScopeUpdate = body.analysisPeriodMode !== undefined;

  // If excludedDevelopers provided in request body, persist to order
  if (body.excludedDevelopers !== undefined) {
    await prisma.order.update({
      where: { id },
      data: { excludedDevelopers: body.excludedDevelopers },
    });
  }

  // ── Credit estimation via shared billing preview service ──
  const excludedEmails = [
    ...new Set(body.excludedDevelopers ?? (order.excludedDevelopers as string[]) ?? []),
  ];

  const effectivePeriodMode = (body.analysisPeriodMode ?? order.analysisPeriodMode ?? 'ALL_TIME') as BillingPreviewScope['mode'];
  const effectiveScope: BillingPreviewScope = {
    mode: effectivePeriodMode,
    years: (() => {
      const raw = body.analysisYears ?? order.analysisYears ?? [];
      if (!Array.isArray(raw)) return [];
      return raw.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    })(),
    startDate: (() => {
      const v = body.analysisStartDate ?? order.analysisStartDate;
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d;
    })(),
    endDate: (() => {
      const v = body.analysisEndDate ?? order.analysisEndDate;
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d;
    })(),
    commitLimit: toFiniteNumber(body.analysisCommitLimit ?? order.analysisCommitLimit),
  };

  const billingPreview = await computeBillingPreview({
    userId: session.user.id,
    orderId: order.id,
    selectedRepos: (order.selectedRepos ?? []) as Array<Record<string, unknown>>,
    selectedDevelopers: (order.selectedDevelopers ?? []) as Array<Record<string, unknown>>,
    excludedEmails,
    cacheMode: body.forceRecalculate ? 'off' : cacheMode,
    scope: effectiveScope,
  });

  const estimatedCredits = billingPreview.estimatedCredits;

  const shouldBill = isBillingEnabled() && session.user.role !== 'ADMIN';

  // ── Pre-check: does user have enough available credits? ──
  if (shouldBill && estimatedCredits > 0) {
    const balance = await getAvailableBalance(session.user.id);
    if (balance.available < estimatedCredits) {
      billingLogger.warn(
        { userId: session.user.id, orderId: id, available: balance.available, estimated: estimatedCredits },
        'Insufficient credits for analysis',
      );
      return apiError(
        `Insufficient credits: ${balance.available} available, ${estimatedCredits} estimated needed`,
        402,
      );
    }
  }

  const pipelineMode = process.env.PIPELINE_MODE ?? 'local';

  // Atomically: update scope → check active jobs → create job → (optionally reserve credits) → set PROCESSING
  let job;
  try {
    job = await prisma.$transaction(async (tx) => {
      if (hasScopeUpdate) {
        const scopeData: Record<string, unknown> = {};
        if (body.analysisPeriodMode !== undefined) scopeData.analysisPeriodMode = body.analysisPeriodMode;
        if (body.analysisStartDate !== undefined) scopeData.analysisStartDate = new Date(body.analysisStartDate);
        if (body.analysisEndDate !== undefined) scopeData.analysisEndDate = new Date(body.analysisEndDate);
        if (body.analysisCommitLimit !== undefined) scopeData.analysisCommitLimit = body.analysisCommitLimit;
        if (body.analysisYears !== undefined) scopeData.analysisYears = body.analysisYears;
        await tx.order.update({ where: { id }, data: scopeData });
      }

      // Block if user already has a RUNNING/PENDING job (one analysis at a time)
      const activeJob = await tx.analysisJob.findFirst({
        where: { order: { userId: session.user.id }, status: { in: ['PENDING', 'RUNNING'] } },
      });
      if (activeJob) throw new Error('ANALYSIS_ALREADY_RUNNING');

      const newJob = await tx.analysisJob.create({
        data: {
          orderId: id,
          status: 'PENDING',
          executionMode: pipelineMode === 'modal' ? 'modal' : 'local',
        },
      });

      if (shouldBill && estimatedCredits > 0) {
        // Expire stale subscription credits before reservation check
        await runExpiryGuard(tx, session.user.id);

        // Reserve credits atomically — CAS on available balance
        const reserved = await tx.$executeRaw`
          UPDATE "User" SET "reservedCredits" = "reservedCredits" + ${estimatedCredits}
          WHERE id = ${session.user.id}
            AND ("permanentCredits" + "subscriptionCredits" - "reservedCredits") >= ${estimatedCredits}
        `;
        if (reserved === 0) throw new Error('INSUFFICIENT_CREDITS');

        // Record reservation on the job
        await tx.analysisJob.update({
          where: { id: newJob.id },
          data: { creditsReserved: estimatedCredits },
        });

        // Record in the credit ledger for auditability
        const updatedUser = await tx.user.findUnique({
          where: { id: session.user.id },
          select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
        });
        await tx.creditTransaction.create({
          data: {
            userId: session.user.id,
            type: 'ANALYSIS_RESERVE',
            amount: -estimatedCredits,
            wallet: 'PERMANENT',
            balanceAfter: updatedUser
              ? updatedUser.permanentCredits + updatedUser.subscriptionCredits - updatedUser.reservedCredits
              : 0,
            relatedOrderId: id,
            description: `Reserved ${estimatedCredits} credits for analysis`,
          },
        });

        billingLogger.info(
          { userId: session.user.id, jobId: newJob.id, orderId: id, estimatedCredits },
          'Credits reserved for analysis',
        );
      }

      await tx.order.update({ where: { id }, data: { status: 'PROCESSING' } });

      return newJob;
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '';
    if (message === 'ANALYSIS_ALREADY_RUNNING') {
      return apiError('Analysis already in progress', 409);
    }
    if (message === 'INSUFFICIENT_CREDITS') {
      return apiError('Insufficient credits', 402);
    }
    throw err;
  }

  // ── Resolve model context length ──
  // Same logic as benchmark mode: real context from provider metadata, fallback to 32768.
  let effectiveContextLength: number | undefined;
  let rawContextLength: number | undefined;
  try {
    const llmConfig = await getLlmConfig();
    const ctx = await resolveEffectiveContext(llmConfig);
    rawContextLength = ctx.rawContextLength;
    effectiveContextLength = ctx.effectiveContextLength;
    analysisLogger.info(
      { jobId: job.id, rawContextLength, effectiveContextLength, provider: llmConfig.provider },
      'Resolved model context for analysis',
    );
  } catch (err) {
    analysisLogger.warn({ err, jobId: job.id }, 'Failed to resolve model context, using pipeline default');
  }

  // ── Trigger pipeline based on PIPELINE_MODE ──

  await appendJobEvent({
    jobId: job.id,
    phase: 'launch',
    code: 'JOB_CREATED',
    message: 'Analysis job created',
    payload: {
      pipelineMode,
      shouldBill,
      estimatedCredits,
      cacheMode,
      forceRecalculate: body.forceRecalculate === true,
      rawContextLength,
      effectiveContextLength,
    },
  });

  if (pipelineMode === 'modal') {
    // Save pipeline flags first — these must persist even if getLlmConfig() fails.
    await prisma.analysisJob.update({
      where: { id: job.id },
      data: {
        cacheMode,
        skipBilling: !shouldBill,
        forceRecalculate: body.forceRecalculate === true,
      },
    });
    await appendJobEvent({
      jobId: job.id,
      phase: 'launch',
      code: 'MODAL_FLAGS_SAVED',
      message: 'Modal pipeline flags saved',
      payload: {
        cacheMode,
        skipBilling: !shouldBill,
        forceRecalculate: body.forceRecalculate === true,
      },
    });

    // Save LLM config snapshot on the job for Modal to read.
    // SECURITY: Strip API key before persisting — Modal reads it from its own Secret.
    try {
      const llmConfig = await getLlmConfig();
      const snapshotConfig = {
        ...llmConfig,
        openrouter: {
          ...llmConfig.openrouter,
          apiKey: undefined,  // Never persist API key in DB
        },
        ...(rawContextLength != null && { contextLength: rawContextLength }),
        ...(effectiveContextLength != null && { effectiveContextLength }),
        concurrency: getConcurrencySnapshot(),
      };
      await prisma.analysisJob.update({
        where: { id: job.id },
        data: {
          llmConfigSnapshot: snapshotConfig as unknown as Prisma.InputJsonValue,
        },
      });
      await appendJobEvent({
        jobId: job.id,
        phase: 'launch',
        code: 'LLM_SNAPSHOT_SAVED',
        message: 'LLM config snapshot saved for modal worker',
        payload: {
          provider: snapshotConfig.provider,
          model:
            snapshotConfig.provider === 'openrouter'
              ? snapshotConfig.openrouter.model
              : snapshotConfig.ollama.model,
        },
      });
    } catch (err) {
      // Non-fatal: executionMode='modal' + pipeline flags are already saved.
      // Watchdog will pick up the orphaned PENDING job and retry.
      // Modal worker falls back to reading LLM config from its own Secret env vars.
      analysisLogger.warn(
        { err, jobId: job.id },
        'Failed to save LLM config snapshot — watchdog will retry',
      );
      await appendJobEvent({
        jobId: job.id,
        level: 'warn',
        phase: 'launch',
        code: 'LLM_SNAPSHOT_FAILED',
        message: 'Failed to save LLM config snapshot',
        payload: { error: String(err) },
      });
    }

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
        await appendJobEvent({
          jobId: job.id,
          phase: 'launch',
          code: 'MODAL_TRIGGER_ACCEPTED',
          message: 'Modal accepted analysis job',
          payload: { modalCallId: data.modal_call_id },
        });
      } else {
        analysisLogger.warn(
          { status: resp.status, jobId: job.id },
          'Modal trigger failed — job stays PENDING for watchdog retry',
        );
        await appendJobEvent({
          jobId: job.id,
          level: 'warn',
          phase: 'launch',
          code: 'MODAL_TRIGGER_HTTP_FAIL',
          message: 'Modal trigger failed; watchdog will retry',
          payload: { httpStatus: resp.status },
        });
      }
    } catch (err) {
      analysisLogger.warn(
        { err, jobId: job.id },
        'Modal trigger network error — job stays PENDING for watchdog retry',
      );
      await appendJobEvent({
        jobId: job.id,
        level: 'warn',
        phase: 'launch',
        code: 'MODAL_TRIGGER_NETWORK_FAIL',
        message: 'Modal trigger network error; watchdog will retry',
        payload: { error: String(err) },
      });
    }
  } else {
    // Local mode — save snapshot for rerun/update-analysis to inherit context
    try {
      const llmConfigLocal = await getLlmConfig();
      const localSnapshot = {
        ...llmConfigLocal,
        openrouter: { ...llmConfigLocal.openrouter, apiKey: undefined },
        ...(rawContextLength != null && { contextLength: rawContextLength }),
        ...(effectiveContextLength != null && { effectiveContextLength }),
        concurrency: getConcurrencySnapshot(),
      };
      await prisma.analysisJob.update({
        where: { id: job.id },
        data: { llmConfigSnapshot: localSnapshot as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      analysisLogger.warn({ err, jobId: job.id }, 'Failed to save local snapshot');
    }

    await appendJobEvent({
      jobId: job.id,
      phase: 'launch',
      code: 'LOCAL_WORKER_START',
      message: 'Starting local analysis worker',
      payload: { cacheMode, forceRecalculate: body.forceRecalculate === true, effectiveContextLength },
    });
    processAnalysisJob(job.id, {
      cacheMode,
      forceRecalculate: body.forceRecalculate === true,
      ...(effectiveContextLength != null && { contextLength: effectiveContextLength }),
    }).catch((error) => {
      analysisLogger.error({ err: error, jobId: job.id, orderId: id }, 'Pipeline failed');
    });
  }

  return apiResponse({ jobId: job.id, status: 'PROCESSING' });
}
