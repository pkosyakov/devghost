import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import fs from 'fs/promises';
import path from 'path';

const CACHE_DIR = process.env.PIPELINE_CACHE_DIR || path.resolve(process.cwd(), 'scripts', '.cache');
const CLONE_DIR = process.env.CLONE_BASE_PATH || path.resolve(process.cwd(), 'clones');
const MODAL_PROBE_TIMEOUT_MS = 5_000;

type HealthStatus = 'pass' | 'warn' | 'fail';

interface ModalEndpointProbe {
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  httpStatus: number | null;
  latencyMs: number | null;
  error: string | null;
}

interface AtomicStepState {
  id: string;
  status: 'pass' | 'warn' | 'pending' | 'missing';
  occurredAt: Date | null;
  code: string | null;
}

interface AtomicStepDefinition {
  id: string;
  codes: string[];
  warnCodes?: string[];
}

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

const ATOMIC_CODES = Array.from(
  new Set(
    ATOMIC_STEPS.flatMap((step) => [
      ...step.codes,
      ...(step.warnCodes ?? []),
    ]),
  ),
);

async function dirSize(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        count += 1;
        const stat = await fs.stat(path.join(entry.parentPath || dir, entry.name));
        bytes += stat.size;
      }
    }
  } catch {
    // directory may not exist
  }
  return { count, bytes };
}

/** Count cloned repos (owner/repo subdirs) and total size. */
async function cloneStats(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  try {
    const owners = await fs.readdir(dir, { withFileTypes: true });
    for (const owner of owners) {
      if (!owner.isDirectory()) continue;
      const repos = await fs.readdir(path.join(dir, owner.name), { withFileTypes: true });
      for (const repo of repos) {
        if (!repo.isDirectory()) continue;
        count += 1;
        const stats = await dirSize(path.join(dir, owner.name, repo.name));
        bytes += stats.bytes;
      }
    }
  } catch {
    // directory may not exist
  }
  return { count, bytes };
}

function secondsSince(date: Date | null | undefined, nowMs: number): number | null {
  if (!date) return null;
  return Math.max(0, Math.floor((nowMs - date.getTime()) / 1000));
}

function parseEndpointHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url.trim()).host;
  } catch {
    return null;
  }
}

async function probeModalEndpoint(url: string | null): Promise<ModalEndpointProbe> {
  if (!url) {
    return {
      status: 'skipped',
      httpStatus: null,
      latencyMs: null,
      error: 'MODAL_ENDPOINT_URL is not configured',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODAL_PROBE_TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - started;
    const httpStatus = response.status;
    const healthyStatus = httpStatus === 400 || httpStatus === 401 || response.ok;

    return {
      status: healthyStatus ? 'pass' : (httpStatus >= 500 ? 'fail' : 'warn'),
      httpStatus,
      latencyMs,
      error: null,
    };
  } catch (err) {
    return {
      status: 'fail',
      httpStatus: null,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function evaluateAtomicSteps(
  events: Array<{ code: string | null; createdAt: Date }>,
  ageSec: number,
): { steps: AtomicStepState[]; missingIds: string[] } {
  const states: AtomicStepState[] = ATOMIC_STEPS.map((definition) => {
    const passHit = events.find(
      (event) => event.code && definition.codes.includes(event.code),
    );
    if (passHit) {
      return {
        id: definition.id,
        status: 'pass',
        occurredAt: passHit.createdAt,
        code: passHit.code,
      };
    }

    const warnHit = definition.warnCodes?.length
      ? events.find(
          (event) => event.code && definition.warnCodes!.includes(event.code),
        )
      : undefined;

    if (!warnHit) {
      return {
        id: definition.id,
        status: 'pending',
        occurredAt: null,
        code: null,
      };
    }

    return {
      id: definition.id,
      status: 'warn',
      occurredAt: warnHit.createdAt,
      code: warnHit.code,
    };
  });

  // If job is old enough and the expected next step is still absent, mark as missing.
  const highestCompletedIndex = states
    .map((state, index) => ({ state, index }))
    .filter(({ state }) => state.status === 'pass' || state.status === 'warn')
    .reduce((max, entry) => Math.max(max, entry.index), -1);

  const missingIds: string[] = [];
  if (ageSec >= 180) {
    for (let i = 0; i < states.length; i++) {
      if (states[i]!.status !== 'pending') continue;
      if (i <= highestCompletedIndex + 1) {
        states[i]!.status = 'missing';
        missingIds.push(states[i]!.id);
      }
    }
  }

  return { steps: states, missingIds };
}

function makeCheck(
  id: string,
  status: HealthStatus,
  summary: string,
  details?: string,
) {
  return { id, status, summary, details: details ?? null };
}

function countByStatus(checks: Array<{ status: HealthStatus }>) {
  return checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
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

export async function GET(request: NextRequest) {
  const auth = await requireAdminOrCron(request);
  if (auth instanceof NextResponse) return auth;

  const now = new Date();
  const nowMs = now.getTime();

  const pipelineMode = process.env.PIPELINE_MODE ?? 'local';
  const endpointRaw = process.env.MODAL_ENDPOINT_URL ?? '';
  const endpointTrimmed = endpointRaw.trim();
  const endpointConfigured = endpointTrimmed.length > 0;
  const endpointHasWhitespace = endpointConfigured && endpointRaw !== endpointTrimmed;
  const webhookSecretConfigured = Boolean(process.env.MODAL_WEBHOOK_SECRET);
  const cronSecretConfigured = Boolean(process.env.CRON_SECRET);
  const isLocalPipeline = pipelineMode !== 'modal' && !process.env.VERCEL;

  const [
    activeJobs,
    recentFailed,
    failedRetryableCount,
    watchdogLastEvent,
    endpointProbe,
    repos,
    diffs,
    llm,
  ] = await Promise.all([
    prisma.analysisJob.findMany({
      where: { status: { in: ['PENDING', 'RUNNING', 'LLM_COMPLETE'] } },
      select: {
        id: true,
        status: true,
        progress: true,
        currentStep: true,
        startedAt: true,
        createdAt: true,
        updatedAt: true,
        heartbeatAt: true,
        retryCount: true,
        maxRetries: true,
        executionMode: true,
        modalCallId: true,
        order: { select: { id: true, name: true, user: { select: { email: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    prisma.analysisJob.findMany({
      where: { status: { in: ['FAILED', 'FAILED_FATAL', 'FAILED_RETRYABLE'] } },
      select: {
        id: true,
        error: true,
        completedAt: true,
        order: { select: { id: true, name: true, user: { select: { email: true } } } },
      },
      orderBy: { completedAt: 'desc' },
      take: 10,
    }),
    prisma.analysisJob.count({ where: { status: 'FAILED_RETRYABLE', executionMode: 'modal' } }),
    prisma.analysisJobEvent.findFirst({
      where: { phase: 'watchdog' },
      orderBy: { id: 'desc' },
      select: { createdAt: true, code: true, level: true },
    }),
    probeModalEndpoint(endpointConfigured ? endpointTrimmed : null),
    ...(isLocalPipeline
      ? [
          cloneStats(CLONE_DIR),
          dirSize(path.join(CACHE_DIR, 'diffs')),
          dirSize(path.join(CACHE_DIR, 'llm')),
        ]
      : [
          Promise.resolve({ count: 0, bytes: 0 }),
          Promise.resolve({ count: 0, bytes: 0 }),
          Promise.resolve({ count: 0, bytes: 0 }),
        ]),
  ]);

  const modalJobs = activeJobs.filter((job) => job.executionMode === 'modal');
  const modalJobIds = modalJobs.map((job) => job.id);

  const [recentModalEvents, atomicModalEvents] = modalJobIds.length > 0
    ? await Promise.all([
        prisma.analysisJobEvent.findMany({
          where: { jobId: { in: modalJobIds } },
          select: {
            id: true,
            jobId: true,
            createdAt: true,
            level: true,
            code: true,
            message: true,
          },
          orderBy: [{ id: 'desc' }],
          take: Math.max(1500, modalJobIds.length * 250),
        }),
        prisma.analysisJobEvent.findMany({
          where: {
            jobId: { in: modalJobIds },
            code: { in: ATOMIC_CODES },
          },
          select: {
            jobId: true,
            createdAt: true,
            code: true,
          },
          orderBy: [{ id: 'asc' }],
        }),
      ])
    : [[], []];

  const recentEventsByJobId = new Map<
    string,
    Array<{
      createdAt: Date;
      level: string;
      code: string | null;
      message: string;
    }>
  >();

  for (const event of recentModalEvents) {
    const bucket = recentEventsByJobId.get(event.jobId) ?? [];
    if (bucket.length >= 250) continue;
    bucket.push({
      createdAt: event.createdAt,
      level: event.level,
      code: event.code,
      message: event.message,
    });
    recentEventsByJobId.set(event.jobId, bucket);
  }

  for (const bucket of recentEventsByJobId.values()) {
    bucket.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  const atomicEventsByJobId = new Map<
    string,
    Array<{
      createdAt: Date;
      code: string | null;
    }>
  >();
  for (const event of atomicModalEvents) {
    const bucket = atomicEventsByJobId.get(event.jobId) ?? [];
    bucket.push({
      createdAt: event.createdAt,
      code: event.code,
    });
    atomicEventsByJobId.set(event.jobId, bucket);
  }

  let pendingTooLongCount = 0;
  let runningHeartbeatStaleCount = 0;
  let llmCompleteStaleCount = 0;
  let triggerAcceptedNoWorkerCount = 0;

  const stuckJobs = modalJobs
    .map((job) => {
      const recentEvents = recentEventsByJobId.get(job.id) ?? [];
      const atomicEvents = atomicEventsByJobId.get(job.id) ?? [];
      const ageSec = secondsSince(job.createdAt, nowMs) ?? 0;
      const sinceUpdateSec = secondsSince(job.updatedAt, nowMs) ?? ageSec;
      const heartbeatLagSec = secondsSince(job.heartbeatAt, nowMs);
      const lastEvent = recentEvents.length > 0 ? recentEvents[recentEvents.length - 1]! : null;
      const atomic = evaluateAtomicSteps(atomicEvents, ageSec);

      const hasAtomicStep = (stepId: string) =>
        atomic.steps.some(
          (step) =>
            step.id === stepId &&
            (step.status === 'pass' || step.status === 'warn'),
        );

      const hasTriggerAccepted = hasAtomicStep('modal_trigger_accepted');
      const hasWorkerAcquired = hasAtomicStep('worker_acquired');
      const pendingTooLong = job.status === 'PENDING' && sinceUpdateSec > 120;
      const triggerAcceptedNoWorker = hasTriggerAccepted && !hasWorkerAcquired && sinceUpdateSec > 120;
      const runningHeartbeatStale = job.status === 'RUNNING' && (heartbeatLagSec ?? ageSec) > 600;
      const llmCompleteStale = job.status === 'LLM_COMPLETE' && sinceUpdateSec > 300;
      const hasErrorEvent = lastEvent?.level === 'error';
      const hasMissingAtomicStep = atomic.missingIds.length > 0;

      if (pendingTooLong) pendingTooLongCount += 1;
      if (triggerAcceptedNoWorker) triggerAcceptedNoWorkerCount += 1;
      if (runningHeartbeatStale) runningHeartbeatStaleCount += 1;
      if (llmCompleteStale) llmCompleteStaleCount += 1;

      const isStuck =
        pendingTooLong ||
        triggerAcceptedNoWorker ||
        runningHeartbeatStale ||
        llmCompleteStale ||
        hasErrorEvent ||
        hasMissingAtomicStep;

      return {
        isStuck,
        id: job.id,
        orderId: job.order.id,
        orderName: job.order.name,
        ownerEmail: job.order.user.email,
        status: job.status,
        progress: job.progress,
        currentStep: job.currentStep,
        retryCount: job.retryCount,
        maxRetries: job.maxRetries,
        modalCallId: job.modalCallId,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        heartbeatAt: job.heartbeatAt,
        ageSec,
        sinceUpdateSec,
        heartbeatLagSec,
        lastEventCode: lastEvent?.code ?? null,
        lastEventLevel: lastEvent?.level ?? null,
        lastEventMessage: lastEvent?.message ?? null,
        lastEventAt: lastEvent?.createdAt ?? null,
        pendingTooLong,
        triggerAcceptedNoWorker,
        runningHeartbeatStale,
        llmCompleteStale,
        atomicSteps: atomic.steps,
        missingAtomicSteps: atomic.missingIds,
      };
    })
    .filter((job) => job.isStuck)
    .sort((a, b) => b.ageSec - a.ageSec);

  const watchdogLagSec = secondsSince(watchdogLastEvent?.createdAt, nowMs);
  const watchdogHasWorkload = modalJobs.length > 0 || failedRetryableCount > 0;
  const watchdogStatus: HealthStatus =
    !watchdogHasWorkload
      ? 'pass'
      : watchdogLagSec === null
        ? 'warn'
        : watchdogLagSec <= 900
          ? 'pass'
          : watchdogLagSec <= 3600
            ? 'warn'
            : 'fail';

  const checks = [
    makeCheck(
      'pipeline_mode',
      pipelineMode === 'modal' ? 'pass' : 'warn',
      `PIPELINE_MODE is ${pipelineMode}`,
      pipelineMode === 'modal'
        ? 'Modal execution mode is enabled.'
        : 'Pipeline is not in modal mode; modal diagnostics are partially irrelevant.',
    ),
    makeCheck(
      'modal_endpoint',
      endpointConfigured ? (endpointHasWhitespace ? 'warn' : 'pass') : 'fail',
      endpointConfigured ? 'MODAL_ENDPOINT_URL is configured' : 'MODAL_ENDPOINT_URL is missing',
      endpointConfigured
        ? `Host: ${parseEndpointHost(endpointTrimmed) ?? 'invalid URL'}${endpointHasWhitespace ? ' (contains leading/trailing whitespace)' : ''}`
        : 'Set MODAL_ENDPOINT_URL to the trigger endpoint URL.',
    ),
    makeCheck(
      'modal_webhook_secret',
      webhookSecretConfigured ? 'pass' : 'fail',
      webhookSecretConfigured ? 'MODAL_WEBHOOK_SECRET is configured' : 'MODAL_WEBHOOK_SECRET is missing',
      webhookSecretConfigured
        ? 'Trigger authentication should work.'
        : 'Modal trigger auth_token validation will fail without this secret.',
    ),
    makeCheck(
      'cron_secret',
      cronSecretConfigured ? 'pass' : 'fail',
      cronSecretConfigured ? 'CRON_SECRET is configured' : 'CRON_SECRET is missing',
      cronSecretConfigured
        ? 'Watchdog endpoint can be called securely.'
        : 'Watchdog cron calls will be rejected with 401.',
    ),
    makeCheck(
      'modal_endpoint_probe',
      endpointProbe.status === 'skipped'
        ? 'warn'
        : endpointProbe.status === 'pass'
          ? 'pass'
          : endpointProbe.status === 'warn'
            ? 'warn'
            : 'fail',
      endpointProbe.status === 'skipped'
        ? 'Endpoint probe was skipped'
        : endpointProbe.error
          ? `Endpoint probe failed: ${endpointProbe.error}`
          : `Endpoint probe HTTP ${endpointProbe.httpStatus} in ${endpointProbe.latencyMs} ms`,
      endpointProbe.status === 'pass'
        ? 'Expected 400/401 for anonymous probe means trigger container is alive.'
        : 'Unexpected response or timeout suggests trigger startup/availability issues.',
    ),
    makeCheck(
      'watchdog_activity',
      watchdogStatus,
      !watchdogHasWorkload
        ? 'No active/retryable modal jobs; watchdog idle is expected'
        : watchdogLagSec === null
          ? 'No watchdog events found yet'
          : `Last watchdog event ${watchdogLagSec}s ago`,
      !watchdogHasWorkload
        ? 'There is nothing to recover right now, so watchdog may legitimately produce no events.'
        : watchdogLagSec === null
          ? 'No phase=watchdog events in AnalysisJobEvent.'
          : `Code: ${watchdogLastEvent?.code ?? 'n/a'}, level: ${watchdogLastEvent?.level ?? 'n/a'}`,
    ),
    makeCheck(
      'pending_too_long',
      pendingTooLongCount === 0 ? 'pass' : 'fail',
      pendingTooLongCount === 0
        ? 'No PENDING modal jobs older than 2 minutes'
        : `${pendingTooLongCount} modal job(s) stuck in PENDING > 2 minutes`,
      'Usually points to trigger/worker pickup problems.',
    ),
    makeCheck(
      'trigger_accepted_without_worker',
      triggerAcceptedNoWorkerCount === 0 ? 'pass' : 'fail',
      triggerAcceptedNoWorkerCount === 0
        ? 'No jobs with trigger accepted but worker not acquired'
        : `${triggerAcceptedNoWorkerCount} job(s) have MODAL_TRIGGER_ACCEPTED but no WORKER_ACQUIRED`,
      'This pinpoints a handoff issue between trigger and worker.',
    ),
    makeCheck(
      'running_heartbeat_stale',
      runningHeartbeatStaleCount === 0 ? 'pass' : 'fail',
      runningHeartbeatStaleCount === 0
        ? 'No RUNNING jobs with stale heartbeat'
        : `${runningHeartbeatStaleCount} RUNNING job(s) have stale heartbeat`,
      'Heartbeat > 10 minutes indicates worker stall or dead container.',
    ),
    makeCheck(
      'llm_complete_stale',
      llmCompleteStaleCount === 0 ? 'pass' : 'warn',
      llmCompleteStaleCount === 0
        ? 'No LLM_COMPLETE jobs stalled in post-processing'
        : `${llmCompleteStaleCount} LLM_COMPLETE job(s) are stale`,
      'Post-processing should be picked up by watchdog quickly.',
    ),
    makeCheck(
      'failed_retryable_backlog',
      failedRetryableCount === 0 ? 'pass' : (failedRetryableCount <= 3 ? 'warn' : 'fail'),
      failedRetryableCount === 0
        ? 'No FAILED_RETRYABLE backlog'
        : `${failedRetryableCount} FAILED_RETRYABLE job(s) waiting for retry`,
      'Growing backlog means watchdog is not clearing retryable failures fast enough.',
    ),
  ];

  const cacheTotalMb = isLocalPipeline
    ? Math.round((repos.bytes + diffs.bytes + llm.bytes) / 1024 / 1024 * 10) / 10
    : 0;

  return apiResponse({
    access: auth.mode,
    activeJobs: activeJobs.map((job) => ({
      id: job.id,
      status: job.status,
      progress: job.progress,
      currentStep: job.currentStep,
      startedAt: job.startedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      heartbeatAt: job.heartbeatAt,
      executionMode: job.executionMode,
      modalCallId: job.modalCallId,
      retryCount: job.retryCount,
      maxRetries: job.maxRetries,
      orderId: job.order.id,
      orderName: job.order.name,
      ownerEmail: job.order.user.email,
    })),
    recentFailed: recentFailed.map((job) => ({
      id: job.id,
      error: job.error,
      completedAt: job.completedAt,
      orderId: job.order.id,
      orderName: job.order.name,
      ownerEmail: job.order.user.email,
    })),
    cache: {
      totalMb: cacheTotalMb,
      repos: repos.count,
      diffs: diffs.count,
      llm: llm.count,
      available: isLocalPipeline,
    },
    pipeline: {
      checkedAt: now.toISOString(),
      mode: pipelineMode,
      endpointHost: parseEndpointHost(endpointTrimmed),
      watchdogLastEventAt: watchdogLastEvent?.createdAt ?? null,
      watchdogLastEventCode: watchdogLastEvent?.code ?? null,
      checks,
      counts: countByStatus(checks),
      stuckJobs,
    },
  });
}
