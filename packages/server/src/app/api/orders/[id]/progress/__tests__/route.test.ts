import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockJobFindFirst = vi.fn();
const mockEventFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    analysisJob: {
      findFirst: (...args: unknown[]) => mockJobFindFirst(...args),
    },
    analysisJobEvent: {
      findMany: (...args: unknown[]) => mockEventFindMany(...args),
    },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn(),
  isErrorResponse: vi.fn((value: unknown) => value instanceof Response),
  apiError: vi.fn((message: string, status: number) =>
    new Response(JSON.stringify({ success: false, error: message }), { status })),
}));

const mockGetPipelineLogs = vi.fn();
const mockGetJobMeta = vi.fn();

vi.mock('@/lib/services/pipeline-log-store', () => ({
  getPipelineLogs: (...args: unknown[]) => mockGetPipelineLogs(...args),
  getJobMeta: (...args: unknown[]) => mockGetJobMeta(...args),
}));

import { requireUserSession } from '@/lib/api-utils';
import { GET } from '../route';

function makeRequest(query = ''): NextRequest {
  const url = query
    ? `http://localhost/api/orders/order-1/progress?${query}`
    : 'http://localhost/api/orders/order-1/progress';
  return new NextRequest(new URL(url), { method: 'GET' });
}

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    type: 'analysis',
    status: 'RUNNING',
    progress: 10,
    currentStep: 'cloning',
    currentCommit: 1,
    totalCommits: 10,
    startedAt: new Date('2026-03-23T10:00:00.000Z'),
    completedAt: null,
    error: null,
    llmProvider: 'openrouter',
    llmModel: 'qwen-test',
    totalPromptTokens: 100,
    totalCompletionTokens: 20,
    totalLlmCalls: 5,
    totalCostUsd: null,
    executionMode: 'modal',
    modalCallId: 'mc-1',
    heartbeatAt: new Date('2026-03-23T10:01:00.000Z'),
    updatedAt: new Date('2026-03-23T10:01:00.000Z'),
    createdAt: new Date('2026-03-23T10:00:00.000Z'),
    retryCount: 0,
    maxRetries: 3,
    pipelineLog: [],
    order: {
      currentRepoName: 'owner/repo',
      status: 'PROCESSING',
    },
    ...overrides,
  };
}

describe('GET /api/orders/[id]/progress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', role: 'USER' },
    } as never);
    mockGetJobMeta.mockReturnValue(null);
    mockEventFindMany.mockResolvedValue([]);
  });

  it('returns 404 when no job exists for order/user', async () => {
    mockJobFindFirst.mockResolvedValue(null);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });

    expect(res.status).toBe(404);
  });

  it('allows admin to read progress for another user order', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never);
    mockJobFindFirst.mockResolvedValue(makeJob());

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockJobFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { order: { id: 'order-1' } },
      }),
    );
    expect(json.data.jobId).toBe('job-1');
  });

  it('returns incremental diagnostics events and cursor when sinceEventId is provided', async () => {
    mockJobFindFirst.mockResolvedValue(makeJob());
    mockEventFindMany.mockResolvedValue([
      {
        id: BigInt(101),
        createdAt: new Date('2026-03-23T10:01:01.000Z'),
        level: 'info',
        phase: 'clone',
        code: 'REPO_CLONE_DONE',
        message: 'Repository clone done',
        repo: 'owner/repo',
        sha: null,
        payload: { durationSec: 12.3 },
      },
      {
        id: BigInt(102),
        createdAt: new Date('2026-03-23T10:01:09.000Z'),
        level: 'warn',
        phase: 'watchdog',
        code: 'HEARTBEAT_TIMEOUT_RETRYABLE',
        message: 'Heartbeat delayed',
        repo: null,
        sha: null,
        payload: null,
      },
    ]);

    const res = await GET(
      makeRequest('sinceEventId=100'),
      { params: Promise.resolve({ id: 'order-1' }) },
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockEventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId: 'job-1', id: { gt: BigInt(100) } },
        orderBy: { id: 'asc' },
        take: 500,
      }),
    );
    expect(json.data.events).toHaveLength(2);
    expect(json.data.events[0].id).toBe('101');
    expect(json.data.events[1].id).toBe('102');
    expect(json.data.eventCursor).toBe('102');
  });

  it('returns full diagnostics history on initial request (without sinceEventId)', async () => {
    mockJobFindFirst.mockResolvedValue(makeJob());
    mockEventFindMany.mockResolvedValue([
      {
        id: BigInt(1),
        createdAt: new Date('2026-03-23T10:00:01.000Z'),
        level: 'info',
        phase: 'launch',
        code: 'JOB_CREATED',
        message: 'Job created',
        repo: null,
        sha: null,
        payload: null,
      },
      {
        id: BigInt(2),
        createdAt: new Date('2026-03-23T10:00:02.000Z'),
        level: 'info',
        phase: 'launch',
        code: 'MODAL_TRIGGER_ACCEPTED',
        message: 'Modal accepted job',
        repo: null,
        sha: null,
        payload: null,
      },
    ]);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockEventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId: 'job-1' },
        orderBy: { id: 'asc' },
      }),
    );
    expect(json.data.events).toHaveLength(2);
    expect(json.data.events[0].id).toBe('1');
    expect(json.data.events[1].id).toBe('2');
    expect(json.data.eventCursor).toBe('2');
  });

  it('returns full persisted pipeline log for terminal modal statuses', async () => {
    const persistedLog = [{ ts: 1000, sha: 'abc123', status: 'ok', method: 'llm' }];
    const terminalStatuses = ['FAILED_RETRYABLE', 'FAILED_FATAL', 'LLM_COMPLETE'] as const;

    for (const status of terminalStatuses) {
      mockJobFindFirst.mockResolvedValueOnce(makeJob({
        status,
        executionMode: 'modal',
        pipelineLog: persistedLog,
      }));

      const res = await GET(
        makeRequest('since=999'),
        { params: Promise.resolve({ id: 'order-1' }) },
      );
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.data.status).toBe(status);
      expect(json.data.log).toEqual(persistedLog);
    }
  });

  it('uses in-memory live log for local RUNNING jobs', async () => {
    mockJobFindFirst.mockResolvedValue(makeJob({
      status: 'RUNNING',
      executionMode: 'local',
    }));
    mockGetPipelineLogs.mockReturnValue([{ ts: 2000, sha: 'def456', status: 'ok' }]);
    mockGetJobMeta.mockReturnValue({ progress: 33, currentStep: 'analyzing', currentCommit: 3 });

    const res = await GET(
      makeRequest('since=1000'),
      { params: Promise.resolve({ id: 'order-1' }) },
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockGetPipelineLogs).toHaveBeenCalledWith('job-1', 1000);
    expect(json.data.progress).toBe(33);
    expect(json.data.currentStep).toBe('analyzing');
    expect(json.data.currentCommit).toBe(3);
    expect(json.data.log).toEqual([{ ts: 2000, sha: 'def456', status: 'ok' }]);
  });
});
