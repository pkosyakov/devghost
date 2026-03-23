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

const log = analysisLogger.child({ component: 'watchdog' });

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

  // 3.5. Recovery: stuck post_processing → reset for re-claim
  const stuckPostProcessing = await prisma.$executeRaw`
    UPDATE "AnalysisJob"
    SET "currentStep" = NULL, "updatedAt" = NOW()
    WHERE status = 'LLM_COMPLETE'
      AND "currentStep" = 'post_processing'
      AND "updatedAt" < ${new Date(Date.now() - POST_PROCESSING_TIMEOUT_MS)}
  `;
  if (stuckPostProcessing > 0) {
    log.warn({ count: stuckPostProcessing }, 'Reset stuck post_processing jobs');
    processed += stuckPostProcessing;
  }

  // 4. Post-process: LLM_COMPLETE → Ghost% + billing → COMPLETED
  while (true) {
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      log.info({ processed }, 'Time budget exceeded, deferring to next cron run');
      break;
    }
    // Atomic claim: only one cron run can grab each job.
    // Must set updatedAt explicitly — @updatedAt only works with Prisma Client.
    const claimed = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "AnalysisJob"
      SET "currentStep" = 'post_processing', "updatedAt" = NOW()
      WHERE id = (
        SELECT id FROM "AnalysisJob"
        WHERE status = 'LLM_COMPLETE' AND ("currentStep" IS NULL OR "currentStep" != 'post_processing')
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
        message: 'Watchdog started post-processing for LLM_COMPLETE job',
      });
      await postProcessJob(job);
      await appendJobEvent({
        jobId: job.id,
        phase: 'post_processing',
        code: 'POST_PROCESSING_DONE',
        message: 'Watchdog completed post-processing',
      });
      log.info({ jobId: job.id }, 'Post-processing completed');
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

  return Response.json({ ok: true, processed });
}


async function postProcessJob(job: any) {
  const order = job.order;
  const userId = order.userId;
  const skipBilling = !isBillingEnabled() || order.user.role === 'ADMIN';

  // 1. Count processed commits and debit.
  // Idempotent: debitCredit() increments creditsConsumed internally (CAS guard),
  // so re-claim after recovery (step 3.5) won't double-debit — the loop
  // subtracts already-consumed credits before starting.
  const processedCount = await prisma.commitAnalysis.count({
    where: { orderId: order.id, jobId: null, method: { not: 'error' } },
  });

  if (!skipBilling) {
    const cachedReleased = job.creditsReleased || 0;
    const alreadyConsumed = job.creditsConsumed || 0;
    const toDebit = Math.max(0, processedCount - cachedReleased - alreadyConsumed);
    for (let i = 0; i < toDebit; i++) {
      const result = await debitCredit(userId, job.id, order.id);
      if (!result) {
        log.warn({ userId, jobId: job.id }, 'Credits exhausted during post-processing');
        break;
      }
      // Refresh updatedAt every 50 debits to extend the post_processing lease.
      // Without this, step 3.5 resets the job after 5 min even if we're still alive.
      if ((i + 1) % 50 === 0) {
        await prisma.analysisJob.update({
          where: { id: job.id },
          data: { updatedAt: new Date() },
        });
      }
    }
  }

  // 2. Calculate Ghost% metrics (can be slow for large orders — refresh lease first)
  await prisma.analysisJob.update({
    where: { id: job.id },
    data: { updatedAt: new Date() },
  });
  const ghostService = getGhostMetricsService();
  await prisma.orderMetric.deleteMany({ where: { orderId: order.id } });
  await prisma.dailyEffort.deleteMany({ where: { orderId: order.id } });
  const metrics = await ghostService.calculateAndSave(order.id, userId);
  log.info({ jobId: job.id, developers: metrics.length }, 'Ghost metrics calculated');

  // 3. Aggregate LLM usage and compute cost
  const llmConfig = job.llmConfigSnapshot
    ? JSON.parse(JSON.stringify(job.llmConfigSnapshot))
    : await getLlmConfig();
  const actualCost = llmConfig.provider === 'openrouter'
    ? ((job.totalPromptTokens ?? 0) / 1e6 * (llmConfig.openrouter?.inputPrice ?? 0) +
       (job.totalCompletionTokens ?? 0) / 1e6 * (llmConfig.openrouter?.outputPrice ?? 0))
    : 0;

  // 4. Count in-scope commits
  const scopeConfig: ScopeConfig = {
    analysisPeriodMode: order.analysisPeriodMode,
    analysisYears: order.analysisYears,
    analysisStartDate: order.analysisStartDate,
    analysisEndDate: order.analysisEndDate,
    analysisCommitLimit: order.analysisCommitLimit,
  };
  const inScopeCount = await countInScopeCommits(order.id, scopeConfig);

  // 5. Finalize job and order
  await prisma.analysisJob.update({
    where: { id: job.id },
    data: {
      status: 'COMPLETED',
      progress: 100,
      currentStep: 'done',
      completedAt: new Date(),
      totalCostUsd: actualCost,
    },
  });

  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: 'COMPLETED',
      analyzedAt: new Date(),
      totalCommits: inScopeCount,
    },
  });

  // 6. Release unused credits
  if (!skipBilling) {
    await releaseReservedCredits(userId, job.id, order.id);
  }
}


async function handleJobFailure(job: any) {
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
