import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import {
  apiError,
  apiResponse,
  isErrorResponse,
  requireAdmin,
} from '@/lib/api-utils';
import { getJobMeta, getPipelineLogs } from '@/lib/services/pipeline-log-store';

type AtomicStepStatus = 'pass' | 'warn' | 'pending' | 'missing';

interface AtomicStepDefinition {
  id: string;
  codes: string[];
  warnCodes?: string[];
}

interface DiagnosticEvent {
  id: string;
  createdAt: Date;
  level: string;
  phase: string | null;
  code: string | null;
  message: string;
  repo: string | null;
  sha: string | null;
  payload: unknown;
}

interface AtomicStepState {
  id: string;
  status: AtomicStepStatus;
  occurredAt: Date | null;
  code: string | null;
}

const PENDING_STALE_MS = 2 * 60 * 1000;
const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
const HEARTBEAT_CRITICAL_MS = 10 * 60 * 1000;
const POST_PROCESSING_STALE_MS = 5 * 60 * 1000;
const DEFAULT_EVENTS_LIMIT = 500;
const MAX_EVENTS_LIMIT = 2000;

const ATOMIC_STEPS: AtomicStepDefinition[] = [
  { id: 'job_created', codes: ['JOB_CREATED'] },
  { id: 'modal_flags_saved', codes: ['MODAL_FLAGS_SAVED'] },
  { id: 'llm_snapshot_saved', codes: ['LLM_SNAPSHOT_SAVED'], warnCodes: ['LLM_SNAPSHOT_FAILED'] },
  { id: 'modal_trigger_accepted', codes: ['MODAL_TRIGGER_ACCEPTED'] },
  { id: 'worker_acquired', codes: ['WORKER_ACQUIRED'] },
  { id: 'heartbeat_thread_started', codes: ['HEARTBEAT_THREAD_STARTED'] },
  { id: 'repo_start', codes: ['REPO_START'] },
  { id: 'worker_llm_complete', codes: ['WORKER_LLM_COMPLETE'] },
  { id: 'post_processing_start', codes: ['POST_PROCESSING_START'] },
  { id: 'post_processing_done', codes: ['POST_PROCESSING_DONE'] },
];

function secondsSince(date: Date | null | undefined, nowMs: number): number | null {
  if (!date) return null;
  return Math.max(0, Math.floor((nowMs - date.getTime()) / 1000));
}

function parsePositiveInt(
  value: string | null,
  fallback: number,
  max: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseSince(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseSinceEventId(value: string | null): bigint | undefined {
  if (!value) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

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

function evaluateAtomicSteps(
  events: Array<{ code: string | null; createdAt: Date }>,
  ageSec: number,
): { steps: AtomicStepState[]; missingIds: string[] } {
  const steps: AtomicStepState[] = ATOMIC_STEPS.map((definition) => {
    const passEvent = events.find((event) => event.code && definition.codes.includes(event.code));
    if (passEvent) {
      return {
        id: definition.id,
        status: 'pass',
        occurredAt: passEvent.createdAt,
        code: passEvent.code,
      };
    }

    const warnEvent = events.find((event) => event.code && definition.warnCodes?.includes(event.code));
    if (warnEvent) {
      return {
        id: definition.id,
        status: 'warn',
        occurredAt: warnEvent.createdAt,
        code: warnEvent.code,
      };
    }

    return {
      id: definition.id,
      status: 'pending',
      occurredAt: null,
      code: null,
    };
  });

  const highestCompletedIndex = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step }) => step.status === 'pass' || step.status === 'warn')
    .reduce((max, entry) => Math.max(max, entry.index), -1);

  const missingIds: string[] = [];
  if (ageSec >= 180) {
    for (let i = 0; i < steps.length; i += 1) {
      if (steps[i]!.status !== 'pending') continue;
      if (i <= highestCompletedIndex + 1) {
        steps[i]!.status = 'missing';
        missingIds.push(steps[i]!.id);
      }
    }
  }

  return { steps, missingIds };
}

async function requireAdminOrCron(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
    return { mode: 'cron' as const };
  }

  const admin = await requireAdmin();
  if (isErrorResponse(admin)) return admin;
  return { mode: 'admin' as const, userId: admin.user.id };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdminOrCron(request);
  if (auth instanceof NextResponse) return auth;

  const { id: orderId } = await params;
  const jobIdParam = request.nextUrl.searchParams.get('jobId');
  const since = parseSince(request.nextUrl.searchParams.get('since'));
  const sinceEventId = parseSinceEventId(request.nextUrl.searchParams.get('sinceEventId'));
  const includeLog = request.nextUrl.searchParams.get('includeLog') !== '0';
  const eventsLimit = parsePositiveInt(
    request.nextUrl.searchParams.get('eventsLimit'),
    DEFAULT_EVENTS_LIMIT,
    MAX_EVENTS_LIMIT,
  );

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      name: true,
      status: true,
      errorMessage: true,
      userId: true,
      selectedRepos: true,
      selectedDevelopers: true,
      excludedDevelopers: true,
      analysisPeriodMode: true,
      analysisYears: true,
      analysisStartDate: true,
      analysisEndDate: true,
      analysisCommitLimit: true,
      availableStartDate: true,
      availableEndDate: true,
      repositoriesTotal: true,
      repositoriesProcessed: true,
      repositoriesFailed: true,
      currentRepoName: true,
      totalCommits: true,
      analyzedAt: true,
      completedAt: true,
      createdAt: true,
      updatedAt: true,
      user: {
        select: {
          id: true,
          email: true,
          role: true,
        },
      },
    },
  });

  if (!order) return apiError('Order not found', 404);

  const job = jobIdParam
    ? await prisma.analysisJob.findFirst({
        where: { id: jobIdParam, orderId },
      })
    : await prisma.analysisJob.findFirst({
        where: { orderId },
        orderBy: { createdAt: 'desc' },
      });

  if (!job) {
    return apiResponse({
      order,
      job: null,
      diagnostics: null,
      access: auth.mode,
    });
  }

  const isLiveStatus = job.status === 'RUNNING' || job.status === 'PENDING';
  const usesInMemoryLiveLog = isLiveStatus && job.executionMode !== 'modal';
  const meta = getJobMeta(job.id);

  let logEntries: unknown[] = [];
  let logSource: 'none' | 'memory' | 'db_pipeline_log' = 'none';

  if (includeLog) {
    if (usesInMemoryLiveLog) {
      logEntries = getPipelineLogs(job.id, since);
      logSource = 'memory';
    } else if (job.executionMode === 'modal' && isLiveStatus) {
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
      logSource = 'db_pipeline_log';
    } else {
      logEntries = (job.pipelineLog as unknown[]) ?? [];
      logSource = 'db_pipeline_log';
    }
  }

  const eventsRaw = await prisma.analysisJobEvent.findMany({
    where: {
      jobId: job.id,
      ...(sinceEventId !== undefined ? { id: { gt: sinceEventId } } : {}),
    },
    orderBy: sinceEventId !== undefined ? { id: 'asc' } : { id: 'desc' },
    take: eventsLimit,
  });

  if (sinceEventId === undefined) {
    eventsRaw.reverse();
  }

  const events: DiagnosticEvent[] = eventsRaw.map((event) => ({
    id: event.id.toString(),
    createdAt: event.createdAt,
    level: event.level,
    phase: event.phase,
    code: event.code,
    message: event.message,
    repo: event.repo,
    sha: event.sha,
    payload: event.payload,
  }));

  const eventCursor = events.length > 0 ? events[events.length - 1]!.id : null;
  const nowMs = Date.now();
  const ageSec = secondsSince(job.createdAt, nowMs);
  const updateAgeSec = secondsSince(job.updatedAt, nowMs);
  const heartbeatAgeSec = secondsSince(job.heartbeatAt, nowMs);

  const hasTriggerAccepted = events.some((event) => event.code === 'MODAL_TRIGGER_ACCEPTED');
  const hasWorkerAcquired = events.some((event) => event.code === 'WORKER_ACQUIRED');
  const triggerAcceptedWithoutWorker = hasTriggerAccepted && !hasWorkerAcquired && (ageSec ?? 0) > 120;

  const pendingTooLong = job.status === 'PENDING' && (updateAgeSec ?? 0) * 1000 > PENDING_STALE_MS;
  const heartbeatStale = job.status === 'RUNNING' && (heartbeatAgeSec ?? 0) * 1000 > HEARTBEAT_STALE_MS;
  const heartbeatCritical = job.status === 'RUNNING' && (heartbeatAgeSec ?? 0) * 1000 > HEARTBEAT_CRITICAL_MS;
  const postProcessingStale = job.status === 'LLM_COMPLETE' && (updateAgeSec ?? 0) * 1000 > POST_PROCESSING_STALE_MS;

  const atomic = evaluateAtomicSteps(
    events.map((event) => ({ code: event.code, createdAt: event.createdAt })),
    ageSec ?? 0,
  );

  const latestEvent = events.length > 0 ? events[events.length - 1] : null;
  const eventCounts = events.reduce(
    (acc, event) => {
      if (event.level === 'warn') acc.warn += 1;
      else if (event.level === 'error') acc.error += 1;
      else acc.info += 1;
      return acc;
    },
    { info: 0, warn: 0, error: 0 },
  );

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

  return apiResponse({
    access: auth.mode,
    order,
    job: {
      id: job.id,
      type: job.type ?? 'analysis',
      status: job.status,
      executionMode: job.executionMode,
      progress: (isLiveStatus ? meta?.progress : undefined) ?? job.progress,
      currentStep: (isLiveStatus ? meta?.currentStep : undefined) ?? job.currentStep,
      currentCommit: (isLiveStatus ? meta?.currentCommit : undefined) ?? job.currentCommit,
      totalCommits: job.totalCommits,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      heartbeatAt: job.heartbeatAt,
      retryCount: job.retryCount,
      maxRetries: job.maxRetries,
      modalCallId: job.modalCallId,
      error: job.error,
      llmProvider: job.llmProvider,
      llmModel: job.llmModel,
      totalPromptTokens: job.totalPromptTokens,
      totalCompletionTokens: job.totalCompletionTokens,
      totalLlmCalls: job.totalLlmCalls,
      totalCostUsd: job.totalCostUsd != null ? Number(job.totalCostUsd) : null,
      cloneSizeMb,
      llmConcurrency: envPositiveInt('LLM_CONCURRENCY', 1),
      fdLlmConcurrency: envPositiveInt(
        'FD_LLM_CONCURRENCY',
        envPositiveInt('LLM_CONCURRENCY', 1),
      ),
      logSource,
      log: logEntries,
      events,
      eventCursor,
      eventCounts,
      latestEvent,
    },
    diagnostics: {
      checkedAt: new Date(nowMs).toISOString(),
      ageSec,
      updateAgeSec,
      heartbeatAgeSec,
      pendingTooLong,
      triggerAcceptedWithoutWorker,
      heartbeatStale,
      heartbeatCritical,
      postProcessingStale,
      atomicSteps: atomic.steps,
      missingAtomicSteps: atomic.missingIds,
    },
  });
}

