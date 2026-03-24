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

  // No browser caching — this endpoint is polled for real-time progress
  return NextResponse.json(
    {
      success: true,
      data: {
        jobId: job.id,
        type: job.type ?? 'analysis',
        status: job.status,
        // For live jobs, prefer in-memory values (instant) over DB (fire-and-forget, may lag)
        progress: (isLive ? meta?.progress : undefined) ?? job.progress,
        currentStep: (isLive ? meta?.currentStep : undefined) ?? job.currentStep,
        currentCommit: (isLive ? meta?.currentCommit : undefined) ?? job.currentCommit,
        totalCommits: job.totalCommits,
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
        llmConcurrency: parseInt(process.env.LLM_CONCURRENCY || '1', 10),
        executionMode: job.executionMode,
        modalCallId: job.modalCallId,
        heartbeatAt: job.heartbeatAt,
        updatedAt: job.updatedAt,
        createdAt: job.createdAt,
        retryCount: job.retryCount,
        maxRetries: job.maxRetries,
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
