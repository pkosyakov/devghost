import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { analysisLogger, billingLogger } from '@/lib/logger';
import { getGhostMetricsService } from '@/lib/services/ghost-metrics-service';
import { releaseReservedCredits, debitCredit, isBillingEnabled } from '@/lib/services/credit-service';
import { countInScopeCommits, type ScopeConfig } from '@/lib/services/scope-filter';
import { getLlmConfig } from '@/lib/llm-config';
import { appendJobEvent } from '@/lib/services/job-event-service';

export const maxDuration = 60;

const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const POST_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const ORPHAN_PENDING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const TIME_BUDGET_MS = 45_000; // 45s — leave 15s buffer before 60s maxDuration
const POST_PROCESSING_MIN_REMAINING_MS = 12_000;
const POST_PROCESSING_LEASE_HEARTBEAT_MS = 15_000;
const POST_PROCESSING_DEBIT_BATCH = envPositiveInt('POST_PROCESSING_DEBIT_BATCH', 250);
const POST_PROCESSING_METRICS_BATCH = envPositiveInt('POST_PROCESSING_METRICS_BATCH', 10);
const POST_PROCESSING_STEP_PREFIX = 'post_processing:';
const POST_PROCESSING_ACTIVE_PREFIX = 'post_processing:active:';
const POST_PROCESSING_DEBIT_STEP = 'post_processing:debit';
const POST_PROCESSING_FINALIZE_STEP = 'post_processing:finalize';

const log = analysisLogger.child({ component: 'watchdog' });

type PostProcessingStage = 'debit' | 'metrics' | 'finalize';

interface PostProcessingState {
  stage: PostProcessingStage;
  metricsOffset: number;
}

interface PostProcessingOutcome {
  done: boolean;
  step: string;
  reason: 'completed' | 'partial';
}

export async function GET(request: NextRequest) {
  // Vercel Cron sends Authorization: Bearer <CRON_SECRET> header.
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let processed = 0;
  const startTime = Date.now();

  // 1. Reaper: RUNNING + stale heartbeat → FAILED_RETRYABLE or FAILED_FATAL
  const staleJobs = await prisma.analysisJob.findMany({
    where: {
      status: 'RUNNING',
      executionMode: 'modal',
      heartbeatAt: { lt: new Date(Date.now() - HEARTBEAT_TIMEOUT_MS) },
    },
  });

  for (const job of staleJobs) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      log.info({ processed }, 'Time budget exceeded in stale jobs loop');
      return Response.json({ ok: true, processed, partial: true });
    }
    if (job.retryCount >= job.maxRetries) {
      await prisma.analysisJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED_FATAL',
          error: `Heartbeat timeout after ${job.retryCount} retries`,
          completedAt: new Date(),
        },
      });
      await appendJobEvent({
        jobId: job.id,
        level: 'error',
        phase: 'watchdog',
        code: 'HEARTBEAT_TIMEOUT_FATAL',
        message: 'Job heartbeat timed out; marked FAILED_FATAL',
        payload: { retryCount: job.retryCount, maxRetries: job.maxRetries },
      });
      await handleJobFailure(job);
      log.warn({ jobId: job.id, retries: job.retryCount }, 'Job marked FAILED_FATAL');
    } else {
      await prisma.analysisJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED_RETRYABLE',
          error: 'Heartbeat timeout',
        },
      });
      await appendJobEvent({
        jobId: job.id,
        level: 'warn',
        phase: 'watchdog',
        code: 'HEARTBEAT_TIMEOUT_RETRYABLE',
        message: 'Job heartbeat timed out; marked FAILED_RETRYABLE',
        payload: { retryCount: job.retryCount, maxRetries: job.maxRetries },
      });
      log.warn({ jobId: job.id }, 'Job marked FAILED_RETRYABLE');
    }
    processed++;
  }

  // 2. Retry: FAILED_RETRYABLE → PENDING → re-trigger
  const retryJobs = await prisma.analysisJob.findMany({
    where: { status: 'FAILED_RETRYABLE', executionMode: 'modal' },
  });

  for (const job of retryJobs) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      log.info({ processed }, 'Time budget exceeded in retry loop');
      return Response.json({ ok: true, processed, partial: true });
    }
    await prisma.analysisJob.update({
      where: { id: job.id },
      data: {
        status: 'PENDING',
        retryCount: { increment: 1 },
        lockedBy: null,
        heartbeatAt: null,
        modalCallId: null,
        error: null,
      },
    });
    await appendJobEvent({
      jobId: job.id,
      phase: 'watchdog',
      code: 'RETRY_SCHEDULED',
      message: 'Watchdog reset retryable job to PENDING and re-triggered modal',
      payload: { retryCount: job.retryCount + 1 },
    });

    await triggerModal(job.id);
    log.info({ jobId: job.id, retry: job.retryCount + 1 }, 'Job retried');
    processed++;
  }

  // 3. Stale PENDING: jobs that were not picked up after trigger.
  // Includes:
  // - orphan jobs (no modalCallId)
  // - accepted-but-not-acquired jobs (modalCallId exists, no worker acquisition followed)
  const stalePending = await prisma.analysisJob.findMany({
    where: {
      status: 'PENDING',
      executionMode: 'modal',
      updatedAt: { lt: new Date(Date.now() - ORPHAN_PENDING_TIMEOUT_MS) },
    },
  });

  for (const job of stalePending) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      log.info({ processed }, 'Time budget exceeded in orphan loop');
      return Response.json({ ok: true, processed, partial: true });
    }
    const previousModalCallId = job.modalCallId;
    if (previousModalCallId) {
      // Force a fresh call id so diagnostics clearly show latest trigger attempt.
      await prisma.analysisJob.update({
        where: { id: job.id },
        data: { modalCallId: null },
      });
    }
    await triggerModal(job.id);
    await appendJobEvent({
      jobId: job.id,
      level: 'warn',
      phase: 'watchdog',
      code: previousModalCallId ? 'PENDING_STALE_RETRIGGER' : 'ORPHAN_PENDING_RETRIGGER',
      message: previousModalCallId
        ? 'Watchdog re-triggered stale PENDING modal job (worker was not acquired)'
        : 'Watchdog re-triggered orphan PENDING modal job',
      payload: previousModalCallId
        ? { previousModalCallId }
        : undefined,
    });
    log.info(
      { jobId: job.id, previousModalCallId },
      'Re-triggered stale PENDING job',
    );
    processed++;
  }

  // 3.5. Recovery note:
  // LLM_COMPLETE jobs can keep resumable post_processing checkpoints in currentStep.
  // Re-claim logic below treats stale checkpoints as recoverable without resetting.

  // 3.6. Recovery: latest job is COMPLETED but order still PROCESSING.
  // This can happen after a partial finalization failure. Reconcile order state.
  const inconsistentCompleted = await prisma.$queryRaw<{ id: string; orderId: string }[]>`
    SELECT j.id, j."orderId"
    FROM "AnalysisJob" j
    JOIN "Order" o ON o.id = j."orderId"
    WHERE j.status = 'COMPLETED'
      AND o.status = 'PROCESSING'
      AND j."createdAt" = (
        SELECT MAX(j2."createdAt")
        FROM "AnalysisJob" j2
        WHERE j2."orderId" = j."orderId"
      )
  `;
  if (inconsistentCompleted.length > 0) {
    const now = new Date();
    const reconciledOrders = new Set<string>();
    for (const row of inconsistentCompleted) {
      if (reconciledOrders.has(row.orderId)) continue;
      await prisma.order.update({
        where: { id: row.orderId },
        data: {
          status: 'COMPLETED',
          analyzedAt: now,
          completedAt: now,
        },
      });
      reconciledOrders.add(row.orderId);
      await appendJobEvent({
        jobId: row.id,
        level: 'warn',
        phase: 'watchdog',
        code: 'ORDER_STATUS_RECONCILED',
        message: 'Watchdog reconciled order status to COMPLETED from latest completed job',
        payload: { orderId: row.orderId },
      });
    }
    processed += reconciledOrders.size;
    log.warn(
      { jobs: inconsistentCompleted.length, orders: reconciledOrders.size },
      'Reconciled inconsistent COMPLETED job / PROCESSING order states',
    );
  }

  // 4. Post-process: LLM_COMPLETE → Ghost% + billing → COMPLETED
  // Supports resumable checkpoints in currentStep (post_processing:...).
  while (true) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      log.info({ processed }, 'Time budget exceeded, deferring to next cron run');
      break;
    }
    // Atomic claim: only one cron run can grab each job.
    // Must set updatedAt explicitly — @updatedAt only works with Prisma Client.
    const postProcessingStaleCutoff = new Date(Date.now() - POST_PROCESSING_TIMEOUT_MS);
    const claimed = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "AnalysisJob"
      SET
        "currentStep" = CASE
          WHEN "currentStep" IS NULL
            OR "currentStep" = 'post_processing'
            OR "currentStep" NOT LIKE 'post_processing%'
            THEN ${toActiveStep(POST_PROCESSING_DEBIT_STEP)}
          WHEN "currentStep" LIKE 'post_processing:active:%'
            THEN "currentStep"
          ELSE ${POST_PROCESSING_ACTIVE_PREFIX}
            || REGEXP_REPLACE("currentStep", '^post_processing:', '')
        END,
        "updatedAt" = NOW()
      WHERE id = (
        SELECT id FROM "AnalysisJob"
        WHERE status = 'LLM_COMPLETE'
          AND (
            "currentStep" IS NULL
            OR "currentStep" = 'post_processing'
            OR "currentStep" NOT LIKE 'post_processing%'
            OR (
              "currentStep" LIKE 'post_processing:%'
              AND "currentStep" NOT LIKE 'post_processing:active:%'
            )
            OR (
              "currentStep" LIKE 'post_processing:active:%'
              AND "updatedAt" < ${postProcessingStaleCutoff}
            )
          )
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;

    if (claimed.length === 0) break;

    const jobId = claimed[0]!.id;
    const job = await prisma.analysisJob.findUnique({
      where: { id: jobId },
      include: { order: { include: { user: true } } },
    });

    if (!job) break;

    try {
      await appendJobEvent({
        jobId: job.id,
        phase: 'post_processing',
        code: 'POST_PROCESSING_START',
        message: 'Watchdog started or resumed post-processing for LLM_COMPLETE job',
      });
      const outcome = await postProcessJob(job, startTime + TIME_BUDGET_MS);
      if (outcome.done) {
        await appendJobEvent({
          jobId: job.id,
          phase: 'post_processing',
          code: 'POST_PROCESSING_DONE',
          message: 'Watchdog completed post-processing',
        });
        log.info({ jobId: job.id }, 'Post-processing completed');
      } else {
        log.info({ jobId: job.id, step: outcome.step }, 'Post-processing checkpoint saved');
      }
    } catch (err) {
      log.error({ err, jobId: job.id }, 'Post-processing failed');
      await appendJobEvent({
        jobId: job.id,
        level: 'error',
        phase: 'post_processing',
        code: 'POST_PROCESSING_FAILED',
        message: 'Watchdog post-processing failed',
        payload: { error: String(err) },
      });
      await prisma.analysisJob.update({
        where: { id: job.id },
        data: { status: 'FAILED_FATAL', error: `Post-processing: ${String(err).slice(0, 500)}` },
      });
      await handleJobFailure(job);
    }
    processed++;
  }

  const durationMs = Date.now() - startTime;
  const result = { ok: true, processed, durationMs };

  // Fire-and-forget cron heartbeat
  prisma.systemSettings.upsert({
    where: { id: 'singleton' },
    update: {
      watchdogLastRunAt: new Date(),
      watchdogLastRunResult: result,
    },
    create: {
      id: 'singleton',
      watchdogLastRunAt: new Date(),
      watchdogLastRunResult: result,
    },
  }).catch(() => {});

  return Response.json(result);
}


async function postProcessJob(job: any, deadlineMs: number): Promise<PostProcessingOutcome> {
  const order = job.order;
  const userId = order.userId;
  const skipBilling = !isBillingEnabled() || order.user.role === 'ADMIN';
  let state = parsePostProcessingState(job.currentStep);
  let lastLeaseRefreshMs = 0;
  const cancellationOutcome: PostProcessingOutcome = { done: false, step: 'cancelled', reason: 'partial' };

  const refreshLease = async (force = false) => {
    const nowMs = Date.now();
    if (!force && nowMs - lastLeaseRefreshMs < POST_PROCESSING_LEASE_HEARTBEAT_MS) return;
    await prisma.analysisJob.update({
      where: { id: job.id },
      data: { updatedAt: new Date(nowMs) },
    });
    lastLeaseRefreshMs = nowMs;
  };

  await refreshLease(true);

  // 1) Debit phase (resumable)
  if (state.stage === 'debit') {
    const processedCount = await prisma.commitAnalysis.count({
      where: {
        orderId: order.id,
        jobId: null,
        method: { not: 'error' },
        analyzedAt: { gte: job.createdAt },
      },
    });

    if (!skipBilling) {
      const cachedReleased = job.creditsReleased || 0;
      const alreadyConsumed = job.creditsConsumed || 0;
      const toDebit = Math.max(0, processedCount - cachedReleased - alreadyConsumed);
      let debitedNow = 0;
      let budgetExhausted = false;

      billingLogger.info(
        {
          userId,
          orderId: order.id,
          jobId: job.id,
          processedCount,
          cachedReleased,
          alreadyConsumed,
          toDebit,
        },
        'Post-processing debit plan computed',
      );

      for (let i = 0; i < toDebit; i++) {
        if (debitedNow >= POST_PROCESSING_DEBIT_BATCH) break;
        if (Date.now() >= deadlineMs - POST_PROCESSING_MIN_REMAINING_MS) break;

        const result = await debitCredit(userId, job.id, order.id);
        if (!result) {
          budgetExhausted = true;
          log.warn({ userId, jobId: job.id }, 'Credits exhausted during post-processing');
          break;
        }
        debitedNow++;

        if ((debitedNow % 50) === 0) {
          await prisma.analysisJob.update({
            where: { id: job.id },
            data: { updatedAt: new Date() },
          });
        }
      }

      if (!budgetExhausted && debitedNow < toDebit) {
        await prisma.analysisJob.update({
          where: { id: job.id },
          data: {
            currentStep: POST_PROCESSING_DEBIT_STEP,
            progress: 95,
            updatedAt: new Date(),
          },
        });
        await appendJobEvent({
          jobId: job.id,
          phase: 'post_processing',
          code: 'POST_PROCESSING_DEBIT_PROGRESS',
          message: 'Post-processing debit checkpoint saved',
          payload: { debitedNow, remaining: Math.max(0, toDebit - debitedNow) },
        });
        return { done: false, step: POST_PROCESSING_DEBIT_STEP, reason: 'partial' };
      }
    }

    state = { stage: 'metrics', metricsOffset: 0 };
    await prisma.analysisJob.update({
      where: { id: job.id },
      data: {
        currentStep: formatMetricsStep(0),
        progress: 95,
        updatedAt: new Date(),
      },
    });
    await appendJobEvent({
      jobId: job.id,
      phase: 'post_processing',
      code: 'POST_PROCESSING_DEBIT_DONE',
      message: 'Post-processing debit phase completed',
    });
  }

  // 2) Metrics phase (resumable chunked processing)
  if (state.stage === 'metrics') {
    if (Date.now() >= deadlineMs - POST_PROCESSING_MIN_REMAINING_MS) {
      const step = formatMetricsStep(state.metricsOffset);
      await prisma.analysisJob.update({
        where: { id: job.id },
        data: { currentStep: step, progress: 95, updatedAt: new Date() },
      });
      return { done: false, step, reason: 'partial' };
    }

    const ghostService = getGhostMetricsService();
    const batch = await ghostService.calculateAndSaveBatch(order.id, userId, {
      periodType: 'ALL_TIME',
      offset: state.metricsOffset,
      limit: POST_PROCESSING_METRICS_BATCH,
      resetExisting: state.metricsOffset === 0,
      onProgress: async () => {
        await refreshLease(false);
      },
    });

    if (!batch.done && batch.nextOffset <= state.metricsOffset) {
      throw new Error('POST_PROCESSING_NO_PROGRESS');
    }

    const nextStep = batch.done ? POST_PROCESSING_FINALIZE_STEP : formatMetricsStep(batch.nextOffset);
    await prisma.analysisJob.update({
      where: { id: job.id },
      data: {
        currentStep: nextStep,
        progress: batch.done ? 98 : 95,
        updatedAt: new Date(),
      },
    });

    await appendJobEvent({
      jobId: job.id,
      phase: 'post_processing',
      code: 'POST_PROCESSING_METRICS_BATCH',
      message: 'Post-processing metrics batch completed',
      payload: {
        offset: state.metricsOffset,
        nextOffset: batch.nextOffset,
        totalDevelopers: batch.totalDevelopers,
        processedDevelopers: batch.processedDevelopers,
        done: batch.done,
      },
    });

    log.info(
      {
        jobId: job.id,
        offset: state.metricsOffset,
        nextOffset: batch.nextOffset,
        totalDevelopers: batch.totalDevelopers,
        done: batch.done,
      },
      'Post-processing metrics batch complete',
    );

    if (!batch.done) {
      return { done: false, step: nextStep, reason: 'partial' };
    }

    state = { stage: 'finalize', metricsOffset: batch.nextOffset };
  }

  // 3) Finalize phase
  if (state.stage === 'finalize') {
    const llmConfig = job.llmConfigSnapshot
      ? JSON.parse(JSON.stringify(job.llmConfigSnapshot))
      : await getLlmConfig();
    const actualCost = llmConfig.provider === 'openrouter'
      ? ((job.totalPromptTokens ?? 0) / 1e6 * (llmConfig.openrouter?.inputPrice ?? 0) +
         (job.totalCompletionTokens ?? 0) / 1e6 * (llmConfig.openrouter?.outputPrice ?? 0))
      : 0;

    const scopeConfig: ScopeConfig = {
      analysisPeriodMode: order.analysisPeriodMode,
      analysisYears: order.analysisYears,
      analysisStartDate: order.analysisStartDate,
      analysisEndDate: order.analysisEndDate,
      analysisCommitLimit: order.analysisCommitLimit,
    };
    const inScopeCount = await countInScopeCommits(order.id, scopeConfig);

    const completedAt = new Date();
    const finalized = await prisma.analysisJob.updateMany({
      where: { id: job.id, status: 'LLM_COMPLETE' },
      data: {
        status: 'COMPLETED',
        progress: 100,
        currentStep: 'done',
        completedAt,
        totalCostUsd: actualCost,
      },
    });
    if (finalized.count === 0) {
      return cancellationOutcome;
    }
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'COMPLETED',
        analyzedAt: completedAt,
        completedAt,
        totalCommits: inScopeCount,
      },
    });

    if (!skipBilling) {
      await releaseReservedCredits(userId, job.id, order.id);
    }

    return { done: true, step: 'done', reason: 'completed' };
  }

  const fallbackStep = formatMetricsStep(state.metricsOffset);
  await prisma.analysisJob.update({
    where: { id: job.id },
    data: { currentStep: fallbackStep, progress: 95, updatedAt: new Date() },
  });
  return { done: false, step: fallbackStep, reason: 'partial' };
}


async function handleJobFailure(job: any) {
  // Benchmark failures must not affect the underlying order
  if (job.type === 'benchmark') return;

  const order = job.order ?? await prisma.order.findUnique({ where: { id: job.orderId } });
  if (!order) return;

  const userId = order.userId;
  const skipBilling = !isBillingEnabled();

  if (!skipBilling) {
    try {
      await releaseReservedCredits(userId, job.id, order.id);
    } catch (err) {
      billingLogger.error({ err, jobId: job.id }, 'Failed to release credits on failure');
    }
  }

  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'FAILED', errorMessage: job.error ?? 'Analysis failed' },
  });
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function formatMetricsStep(offset: number): string {
  return `${POST_PROCESSING_STEP_PREFIX}metrics:${Math.max(0, Math.floor(offset))}`;
}

function toActiveStep(step: string): string {
  const checkpoint = toCheckpointStep(step);
  return `${POST_PROCESSING_ACTIVE_PREFIX}${checkpoint.slice(POST_PROCESSING_STEP_PREFIX.length)}`;
}

function toCheckpointStep(step: string | null | undefined): string {
  if (!step || step === 'post_processing') {
    return POST_PROCESSING_DEBIT_STEP;
  }
  if (step.startsWith(POST_PROCESSING_ACTIVE_PREFIX)) {
    return `${POST_PROCESSING_STEP_PREFIX}${step.slice(POST_PROCESSING_ACTIVE_PREFIX.length)}`;
  }
  if (step.startsWith(POST_PROCESSING_STEP_PREFIX)) {
    return step;
  }
  return POST_PROCESSING_DEBIT_STEP;
}

function parsePostProcessingState(step: string | null | undefined): PostProcessingState {
  const checkpoint = toCheckpointStep(step);

  if (checkpoint === POST_PROCESSING_FINALIZE_STEP) {
    return { stage: 'finalize', metricsOffset: 0 };
  }

  if (checkpoint === POST_PROCESSING_DEBIT_STEP) {
    return { stage: 'debit', metricsOffset: 0 };
  }

  if (checkpoint.startsWith(`${POST_PROCESSING_STEP_PREFIX}metrics:`)) {
    const rawOffset = checkpoint.slice(`${POST_PROCESSING_STEP_PREFIX}metrics:`.length);
    const parsed = Number.parseInt(rawOffset, 10);
    return {
      stage: 'metrics',
      metricsOffset: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0,
    };
  }

  if (checkpoint.startsWith('post_processing')) {
    return { stage: 'debit', metricsOffset: 0 };
  }

  return { stage: 'debit', metricsOffset: 0 };
}


async function triggerModal(jobId: string) {
  const url = process.env.MODAL_ENDPOINT_URL;
  const secret = process.env.MODAL_WEBHOOK_SECRET;

  if (!url) {
    log.error({ jobId }, 'MODAL_ENDPOINT_URL not configured');
    return;
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, auth_token: secret }),
    });

    if (resp.ok) {
      const data = await resp.json();
      await prisma.analysisJob.update({
        where: { id: jobId },
        data: { modalCallId: data.modal_call_id },
      });
      await appendJobEvent({
        jobId,
        phase: 'watchdog',
        code: 'MODAL_TRIGGER_ACCEPTED',
        message: 'Watchdog triggered modal job',
        payload: { modalCallId: data.modal_call_id },
      });
    } else {
      await appendJobEvent({
        jobId,
        level: 'warn',
        phase: 'watchdog',
        code: 'MODAL_TRIGGER_HTTP_FAIL',
        message: 'Watchdog modal trigger failed (HTTP)',
        payload: { httpStatus: resp.status },
      });
      log.warn({ jobId, status: resp.status }, 'Modal trigger failed');
    }
  } catch (err) {
    await appendJobEvent({
      jobId,
      level: 'warn',
      phase: 'watchdog',
      code: 'MODAL_TRIGGER_NETWORK_FAIL',
      message: 'Watchdog modal trigger network error',
      payload: { error: String(err) },
    });
    log.warn({ err, jobId }, 'Modal trigger network error');
  }
}
