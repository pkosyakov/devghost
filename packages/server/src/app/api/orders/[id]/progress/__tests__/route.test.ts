import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockMapToClientEvents = vi.fn().mockReturnValue([]);
const mockHashEmail = vi.fn((email: string) => `h_${email}`);
const mockCommitAnalysisGroupBy = vi.fn().mockResolvedValue([]);
const mockCommitAnalysisFindMany = vi.fn().mockResolvedValue([]);
const mockOrderFindUnique = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/services/client-event-mapper', () => ({
  mapToClientEvents: (...args: unknown[]) => mockMapToClientEvents(...args),
  hashEmail: (email: string) => mockHashEmail(email),
}));

const mockJobFindFirst = vi.fn();
const mockEventFindMany = vi.fn();
const mockCommitAnalysisCount = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    analysisJob: {
      findFirst: (...args: unknown[]) => mockJobFindFirst(...args),
    },
    analysisJobEvent: {
      findMany: (...args: unknown[]) => mockEventFindMany(...args),
    },
    commitAnalysis: {
      count: (...args: unknown[]) => mockCommitAnalysisCount(...args),
      groupBy: (...args: unknown[]) => mockCommitAnalysisGroupBy(...args),
      findMany: (...args: unknown[]) => mockCommitAnalysisFindMany(...args),
    },
    order: {
      findUnique: (...args: unknown[]) => mockOrderFindUnique(...args),
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
    failureClass: null,
    pauseReason: null,
    smallLlmProvider: null,
    smallLlmModel: null,
    largeLlmProvider: null,
    largeLlmModel: null,
    fdV3Enabled: false,
    llmConfigSnapshot: null,
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
    mockCommitAnalysisCount.mockResolvedValue(0);
    mockCommitAnalysisGroupBy.mockResolvedValue([]);
    mockCommitAnalysisFindMany.mockResolvedValue([]);
    mockOrderFindUnique.mockResolvedValue(null);
    mockMapToClientEvents.mockReturnValue([]);
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
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never);
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
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never);
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
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never);
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
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never);
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
    expect(mockCommitAnalysisCount).not.toHaveBeenCalled();
  });

  it('uses persisted successful analyses as currentCommit for live modal jobs', async () => {
    mockJobFindFirst.mockResolvedValue(makeJob({
      status: 'RUNNING',
      executionMode: 'modal',
      currentCommit: 160,
      totalCommits: 1250,
    }));
    mockCommitAnalysisCount.mockResolvedValue(860);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockCommitAnalysisCount).toHaveBeenCalledWith({
      where: {
        orderId: 'order-1',
        jobId: null,
        method: { not: 'error' },
      },
    });
    expect(json.data.currentCommit).toBe(860);
    expect(json.data.totalCommits).toBe(1250);
  });

  describe('role-based response filtering', () => {
    it('non-admin response excludes internal fields and includes clientEvents', async () => {
      (requireUserSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        user: { id: 'user-1', role: 'USER' },
      });
      mockJobFindFirst.mockResolvedValue(makeJob());
      mockEventFindMany.mockResolvedValue([]);
      mockGetPipelineLogs.mockReturnValue([]);
      mockGetJobMeta.mockReturnValue(null);

      mockMapToClientEvents.mockReturnValue([
        { id: 'ce-1', ts: 1000, tier: 'major', category: 'commit',
          text: 'clientProgress.commitAnalyzed', params: { subject: 'test' } },
      ]);

      const res = await GET(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
      const json = await res.json();
      const data = json.data;

      // Must include client events
      expect(data.clientEvents).toHaveLength(1);
      expect(data.leaderboard).toBeDefined();

      // Must NOT include internal fields
      expect(data.events).toBeUndefined();
      expect(data.log).toBeUndefined();
      expect(data.modalCallId).toBeUndefined();
      expect(data.heartbeatAt).toBeUndefined();
      expect(data.llmProvider).toBeUndefined();
      expect(data.llmModel).toBeUndefined();
      expect(data.llmConcurrency).toBeUndefined();
      expect(data.totalPromptTokens).toBeUndefined();
      expect(data.totalCostUsd).toBeUndefined();
      expect(data.retryCount).toBeUndefined();
      expect(data.executionMode).toBeUndefined();
      expect(data.cloneSizeMb).toBeUndefined();
    });

    it('admin response includes both internal fields and clientEvents', async () => {
      (requireUserSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        user: { id: 'admin-1', role: 'ADMIN' },
      });
      mockJobFindFirst.mockResolvedValue(makeJob());
      mockEventFindMany.mockResolvedValue([]);
      mockGetPipelineLogs.mockReturnValue([]);
      mockGetJobMeta.mockReturnValue(null);

      const res = await GET(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
      const json = await res.json();
      const data = json.data;

      // Admin gets both
      expect(data.clientEvents).toBeDefined();
      expect(data.leaderboard).toBeDefined();
      expect(data.events).toBeDefined();
      expect(data.log).toBeDefined();
      expect(data.llmProvider).toBeDefined();
    });
  });
});
