import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { getAvailableBalance, isBillingEnabled, runExpiryGuard } from '@/lib/services/credit-service';
import { getLlmConfig } from '@/lib/llm-config';
import { appendJobEvent } from '@/lib/services/job-event-service';
import { analysisLogger, billingLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rate-limit';
import { analyzeOrderSchema } from '@/lib/schemas';
import { z } from 'zod';

type AnalyzeRequestBody = z.infer<typeof analyzeOrderSchema>;

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

  // ── Credit estimation: estimate billable commits before reserving ──
  const excludedEmails = new Set((order.excludedDevelopers ?? []) as string[]);
  const developers = (order.selectedDevelopers ?? []) as Array<{ email?: string; commit_count?: number }>;
  const totalEstimate = developers
    .filter(d => !d.email || !excludedEmails.has(d.email))
    .reduce((sum, d) => sum + (d.commit_count ?? 0), 0);

  // Subtract known cache hits (commits already analyzed for this order)
  const cachedCount = await prisma.commitAnalysis.count({
    where: { orderId: order.id },
  });

  let estimatedCredits = Math.max(1, totalEstimate - cachedCount);

  // Cap at commit limit for LAST_N mode to avoid over-estimation
  const effectiveCommitLimit = body.analysisCommitLimit ?? order.analysisCommitLimit;
  const effectivePeriodMode = body.analysisPeriodMode ?? order.analysisPeriodMode;
  if (effectivePeriodMode === 'LAST_N_COMMITS' && effectiveCommitLimit) {
    estimatedCredits = Math.min(estimatedCredits, effectiveCommitLimit);
  }

  const shouldBill = isBillingEnabled() && session.user.role !== 'ADMIN';

  // ── Pre-check: does user have enough available credits? ──
  if (shouldBill) {
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

      if (shouldBill) {
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
    // Local mode — unchanged subprocess flow
    await appendJobEvent({
      jobId: job.id,
      phase: 'launch',
      code: 'LOCAL_WORKER_START',
      message: 'Starting local analysis worker',
      payload: { cacheMode, forceRecalculate: body.forceRecalculate === true },
    });
    processAnalysisJob(job.id, {
      cacheMode,
      forceRecalculate: body.forceRecalculate === true,
    }).catch((error) => {
      analysisLogger.error({ err: error, jobId: job.id, orderId: id }, 'Pipeline failed');
    });
  }

  return apiResponse({ jobId: job.id, status: 'PROCESSING' });
}
