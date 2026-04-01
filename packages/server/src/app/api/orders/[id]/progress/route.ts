import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { getPipelineLogs, getJobMeta } from '@/lib/services/pipeline-log-store';

function toPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function cloneSizeKbFromPayload(payload: unknown): number {
  if (!payload || typeof payload !== 'object') return 0;
  const row = payload as Record<string, unknown>;
  const value =
    toPositiveNumber(row.cloneSizeKb)
    ?? toPositiveNumber(row.sizeKb)
    ?? toPositiveNumber(row.repoSizeKb)
    ?? 0;
  return Math.floor(value);
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// GET /api/orders/[id]/progress - Poll analysis job progress
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const jobIdParam = request.nextUrl.searchParams.get('jobId');
  const orderWhere: Prisma.OrderWhereInput =
    session.user.role === 'ADMIN'
      ? { id }
      : { id, userId: session.user.id };

  const job = jobIdParam
    ? await prisma.analysisJob.findFirst({
        where: { id: jobIdParam, order: orderWhere },
        include: {
          order: {
            select: {
              currentRepoName: true,
              status: true,
            },
          },
        },
      })
    : await prisma.analysisJob.findFirst({
        where: { order: orderWhere },
        orderBy: { createdAt: 'desc' },
        include: {
          order: {
            select: {
              currentRepoName: true,
              status: true,
            },
          },
        },
      });

  if (!job) return apiError('No analysis job found', 404);

  // Get pipeline log: from memory during PENDING/RUNNING, from DB after completion
  const sinceParam = request.nextUrl.searchParams.get('since');
  const since = sinceParam ? parseInt(sinceParam, 10) : undefined;
  const sinceEventIdParam = request.nextUrl.searchParams.get('sinceEventId');
  let sinceEventId: bigint | undefined;
  if (sinceEventIdParam) {
    try {
      sinceEventId = BigInt(sinceEventIdParam);
    } catch {
      sinceEventId = undefined;
    }
  }
  const isLiveStatus = job.status === 'RUNNING' || job.status === 'PENDING';
  const usesInMemoryLiveLog = isLiveStatus && job.executionMode !== 'modal';

  let logEntries: unknown[];
  if (usesInMemoryLiveLog) {
    logEntries = getPipelineLogs(job.id, since);
  } else if (job.executionMode === 'modal' && isLiveStatus) {
    // Modal mode can stream progress via DB snapshots (if worker persists pipelineLog incrementally)
    const persisted = (job.pipelineLog as unknown[]) ?? [];
    if (since) {
      logEntries = persisted.filter((entry) => {
        if (!entry || typeof entry !== 'object' || !('ts' in entry)) return false;
        const ts = (entry as { ts?: unknown }).ts;
        return typeof ts === 'number' && ts > since;
      });
    } else {
      logEntries = persisted;
    }
  } else if (
    job.status === 'COMPLETED' ||
    job.status === 'FAILED' ||
    job.status === 'FAILED_FATAL' ||
    job.status === 'FAILED_RETRYABLE' ||
    job.status === 'CANCELLED' ||
    job.status === 'LLM_COMPLETE'
  ) {
    // Always return full persisted log — `since` filtering only applies to in-memory live logs
    logEntries = (job.pipelineLog as unknown[]) ?? [];
  } else {
    logEntries = [];
  }

  // Get in-memory job metadata (clone sizes, live progress counters)
  const meta = getJobMeta(job.id);
  const isLive = isLiveStatus;

  // Diagnostics events stream (DB-backed, works in modal and local)
  const eventsQuery: Prisma.AnalysisJobEventFindManyArgs = {
    where:
      sinceEventId !== undefined
        ? {
            jobId: job.id,
            id: { gt: sinceEventId },
          }
        : {
            jobId: job.id,
          },
    // Initial request returns full history (chronological),
    // so the page can reconstruct complete diagnostics timeline.
    orderBy: { id: 'asc' },
  };
  if (sinceEventId !== undefined) {
    eventsQuery.take = 500;
  }

  const events = await prisma.analysisJobEvent.findMany(eventsQuery);

  // Determine failure class for paused/failed jobs
  let failureClass: string | null = null;
  if (job.status === 'FAILED_RETRYABLE' || job.status === 'FAILED_FATAL' || job.status === 'FAILED') {
    const latestFailureEvent = await prisma.analysisJobEvent.findFirst({
      where: { jobId: job.id, code: { startsWith: 'FAILURE_CLASS_' } },
      orderBy: { id: 'desc' },
      select: { code: true },
    });
    failureClass = latestFailureEvent?.code?.replace('FAILURE_CLASS_', '') ?? null;
  }
  const isPaused = job.status === 'FAILED_RETRYABLE' && failureClass === 'EXTERNAL_QUOTA';

  let cloneSizeKb = meta?.totalCloneSizeKb ?? 0;
  if (cloneSizeKb <= 0) {
    const cloneEvents = await prisma.analysisJobEvent.findMany({
      where: { jobId: job.id, code: 'REPO_CLONE_DONE' },
      select: { payload: true },
    });
    cloneSizeKb = cloneEvents.reduce(
      (sum, event) => sum + cloneSizeKbFromPayload(event.payload),
      0,
    );
  }
  const cloneSizeMb = cloneSizeKb > 0 ? +(cloneSizeKb / 1024).toFixed(1) : null;

  const eventCursor =
    events.length > 0
      ? events[events.length - 1]!.id.toString()
      : null;

  // In modal mode, retries can continue from previously saved CommitAnalysis rows.
  // Use persisted successful analyses as effective "current commit" so UI progress
  // reflects resumed work instead of showing a restart from zero.
  let persistedSuccessfulCount: number | null = null;
  if (isLiveStatus && job.executionMode === 'modal') {
    // For benchmarks, count commits written by THIS job (not the original analysis).
    // Original analysis commits have jobId=null; benchmark commits have jobId=job.id.
    const countJobId = job.type === 'benchmark' ? job.id : null;
    persistedSuccessfulCount = await prisma.commitAnalysis.count({
      where: {
        orderId: id,
        jobId: countJobId,
        method: { not: 'error' },
      },
    });
  }

  const rawProgress = (isLive ? meta?.progress : undefined) ?? job.progress;
  const rawCurrentCommit = (isLive ? meta?.currentCommit : undefined) ?? job.currentCommit;
  const rawTotalCommits = job.totalCommits;
  const effectiveCurrentCommit = persistedSuccessfulCount ?? rawCurrentCommit;
  const effectiveTotalCommits =
    persistedSuccessfulCount != null
      ? Math.max(rawTotalCommits ?? 0, persistedSuccessfulCount)
      : rawTotalCommits;
  const progressFromCommits =
    effectiveCurrentCommit != null && effectiveTotalCommits != null && effectiveTotalCommits > 0
      ? Math.min(99, Math.floor((effectiveCurrentCommit / effectiveTotalCommits) * 90))
      : 0;
  const effectiveProgress = Math.max(rawProgress ?? 0, progressFromCommits);
  // Prefer snapshot concurrency (persisted at analysis time), fall back to env
  const snapConcurrency = (job.llmConfigSnapshot as Record<string, unknown> | null)?.concurrency as Record<string, unknown> | undefined;
  const llmConcurrency = toPositiveNumber(snapConcurrency?.llm) ?? envPositiveInt('LLM_CONCURRENCY', 1);
  const fdLlmConcurrency = toPositiveNumber(snapConcurrency?.fd) ?? envPositiveInt('FD_LLM_CONCURRENCY', llmConcurrency);

  // No browser caching — this endpoint is polled for real-time progress
  return NextResponse.json(
    {
      success: true,
      data: {
        jobId: job.id,
        type: job.type ?? 'analysis',
        status: job.status,
        // For live jobs, prefer in-memory values (instant) over DB (fire-and-forget, may lag)
        progress: effectiveProgress,
        currentStep: (isLive ? meta?.currentStep : undefined) ?? job.currentStep,
        currentCommit: effectiveCurrentCommit,
        totalCommits: effectiveTotalCommits,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        llmProvider: job.llmProvider,
        llmModel: job.llmModel,
        totalPromptTokens: job.totalPromptTokens,
        totalCompletionTokens: job.totalCompletionTokens,
        totalLlmCalls: job.totalLlmCalls,
        totalCostUsd: job.totalCostUsd ? Number(job.totalCostUsd) : null,
        cloneSizeMb,
        llmConcurrency,
        fdLlmConcurrency,
        executionMode: job.executionMode,
        modalCallId: job.modalCallId,
        heartbeatAt: job.heartbeatAt,
        updatedAt: job.updatedAt,
        createdAt: job.createdAt,
        retryCount: job.retryCount,
        maxRetries: job.maxRetries,
        failureClass,
        isPaused,
        pauseReason: isPaused ? 'EXTERNAL_QUOTA' : null,
        currentRepoName: job.order.currentRepoName,
        orderStatus: job.order.status,
        log: logEntries,
        events: events.map((event) => ({
          id: event.id.toString(),
          createdAt: event.createdAt,
          level: event.level,
          phase: event.phase,
          code: event.code,
          message: event.message,
          repo: event.repo,
          sha: event.sha,
          payload: event.payload,
        })),
        eventCursor,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
