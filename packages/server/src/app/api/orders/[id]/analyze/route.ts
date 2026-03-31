import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { Prisma } from '@prisma/client';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { getAvailableBalance, isBillingEnabled, runExpiryGuard } from '@/lib/services/credit-service';
import { getLlmConfig } from '@/lib/llm-config';
import { appendJobEvent } from '@/lib/services/job-event-service';
import { resolveEffectiveContext } from '@/lib/services/model-context';
import { analysisLogger, billingLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rate-limit';
import { analyzeOrderSchema } from '@/lib/schemas';
import { z } from 'zod';

type AnalyzeRequestBody = z.infer<typeof analyzeOrderSchema>;

type EffectiveScope = {
  mode: 'ALL_TIME' | 'SELECTED_YEARS' | 'DATE_RANGE' | 'LAST_N_COMMITS';
  years: number[];
  startDate: Date | null;
  endDate: Date | null;
  commitLimit: number | null;
};

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseRepoNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const fullName = obj.fullName ?? obj.full_name;
    if (typeof fullName === 'string' && fullName.trim()) {
      names.add(fullName.trim());
    }
  }
  return [...names];
}

function parseYears(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const years = new Set<number>();
  for (const item of raw) {
    const n = toFiniteNumber(item);
    if (n == null) continue;
    const year = Math.trunc(n);
    if (year > 0) years.add(year);
  }
  return [...years].sort((a, b) => a - b);
}

function toDateOrNull(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

async function estimateReusableCachedCommits(params: {
  userId: string;
  currentOrderId: string;
  selectedRepos: unknown;
  excludedEmails: string[];
  cacheMode: 'any' | 'model' | 'off';
  llmModel: string | null;
  scope: EffectiveScope;
}): Promise<number> {
  const {
    userId,
    currentOrderId,
    selectedRepos,
    excludedEmails,
    cacheMode,
    llmModel,
    scope,
  } = params;

  if (cacheMode === 'off') return 0;

  const repoNames = parseRepoNames(selectedRepos);
  if (repoNames.length === 0) return 0;

  const scopeFilter = (() => {
    if (scope.mode === 'DATE_RANGE' && scope.startDate && scope.endDate) {
      return Prisma.sql`AND ca."authorDate" >= ${scope.startDate} AND ca."authorDate" <= ${scope.endDate}`;
    }
    if (scope.mode === 'SELECTED_YEARS' && scope.years.length > 0) {
      const yearPredicates = scope.years.map((year) => Prisma.sql`
        (ca."authorDate" >= ${new Date(`${year}-01-01T00:00:00.000Z`)}
         AND ca."authorDate" < ${new Date(`${year + 1}-01-01T00:00:00.000Z`)})
      `);
      return Prisma.sql`AND (${Prisma.join(yearPredicates, ' OR ')})`;
    }
    return Prisma.empty;
  })();

  const excludedEmailsFilter = excludedEmails.length > 0
    ? Prisma.sql`AND ca."authorEmail" NOT IN (${Prisma.join(excludedEmails)})`
    : Prisma.empty;

  const crossOrderModelFilter = cacheMode === 'model'
    ? (
        llmModel
          ? Prisma.sql`AND (ca."orderId" = ${currentOrderId} OR ca."llmModel" = ${llmModel} OR ca."llmModel" IS NULL)`
          : Prisma.sql`AND ca."orderId" = ${currentOrderId}`
      )
    : Prisma.empty;

  const baseWhere = Prisma.sql`
    ca."jobId" IS NULL
    AND ca.method != 'error'
    AND ca.repository IN (${Prisma.join(repoNames)})
    AND (
      ca."orderId" = ${currentOrderId}
      OR (
        ca."orderId" != ${currentOrderId}
        AND o."userId" = ${userId}
        AND o.status = 'COMPLETED'
      )
    )
    ${crossOrderModelFilter}
    ${scopeFilter}
    ${excludedEmailsFilter}
  `;

  if (scope.mode === 'LAST_N_COMMITS' && scope.commitLimit && scope.commitLimit > 0) {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      WITH candidate AS (
        SELECT ca."commitHash", MAX(ca."authorDate") AS "authorDate"
        FROM "CommitAnalysis" ca
        JOIN "Order" o ON o.id = ca."orderId"
        WHERE ${baseWhere}
        GROUP BY ca."commitHash"
      ),
      ranked AS (
        SELECT "commitHash"
        FROM candidate
        ORDER BY "authorDate" DESC
        LIMIT ${scope.commitLimit}
      )
      SELECT COUNT(*)::int AS count FROM ranked
    `;
    return rows[0]?.count ?? 0;
  }

  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(DISTINCT ca."commitHash")::int AS count
    FROM "CommitAnalysis" ca
    JOIN "Order" o ON o.id = ca."orderId"
    WHERE ${baseWhere}
  `;
  return rows[0]?.count ?? 0;
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
  if (body.excludedDevelopers) {
    await prisma.order.update({
      where: { id },
      data: { excludedDevelopers: body.excludedDevelopers },
    });
  }

  // ── Credit estimation: estimate billable commits before reserving ──
  // Read excludedDevelopers: prefer request body, fall back to persisted order value
  const excludedEmails = new Set(
    (body.excludedDevelopers ?? (order.excludedDevelopers as string[]) ?? [])
  );
  const developers = (order.selectedDevelopers ?? []) as Array<{
    email?: string;
    commitCount?: number;
    commit_count?: number;
  }>;
  const totalEstimate = developers
    .filter(d => d.email && !excludedEmails.has(d.email))
    .reduce((sum, d) => sum + (d.commitCount ?? d.commit_count ?? 0), 0);

  const effectivePeriodMode = (body.analysisPeriodMode ?? order.analysisPeriodMode) as EffectiveScope['mode'];
  const effectiveScope: EffectiveScope = {
    mode: effectivePeriodMode,
    years: parseYears(body.analysisYears ?? order.analysisYears ?? []),
    startDate: toDateOrNull(body.analysisStartDate ?? order.analysisStartDate),
    endDate: toDateOrNull(body.analysisEndDate ?? order.analysisEndDate),
    commitLimit: toFiniteNumber(body.analysisCommitLimit ?? order.analysisCommitLimit),
  };

  // Subtract known cache hits estimate (same order + eligible cross-order cache).
  // Skip subtraction when cache is disabled or force-recalculate is requested.
  const estimateUsesCache = cacheMode !== 'off' && body.forceRecalculate !== true;
  let cachedCount = 0;
  if (estimateUsesCache) {
    let llmModel: string | null = null;
    if (cacheMode === 'model') {
      try {
        const llmConfig = await getLlmConfig();
        llmModel = llmConfig.provider === 'openrouter'
          ? llmConfig.openrouter.model
          : llmConfig.ollama.model;
      } catch (err) {
        analysisLogger.warn({ err, orderId: id }, 'Failed to load llm config for cache-aware estimate');
      }
    }

    cachedCount = await estimateReusableCachedCommits({
      userId: session.user.id,
      currentOrderId: order.id,
      selectedRepos: order.selectedRepos,
      excludedEmails: [...excludedEmails],
      cacheMode,
      llmModel,
      scope: effectiveScope,
    });
  }

  let estimatedCredits = Math.max(1, totalEstimate - cachedCount);

  // Cap at commit limit for LAST_N mode to avoid over-estimation
  const effectiveCommitLimit = effectiveScope.commitLimit;
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
