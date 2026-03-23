import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──

const mockJobFindMany = vi.fn();
const mockJobFindUnique = vi.fn();
const mockJobUpdate = vi.fn();
const mockOrderFindUnique = vi.fn();
const mockOrderUpdate = vi.fn();
const mockOrderMetricDeleteMany = vi.fn();
const mockDailyEffortDeleteMany = vi.fn();
const mockCommitAnalysisCount = vi.fn();
const mockExecuteRaw = vi.fn();
const mockQueryRaw = vi.fn();
const mockTransaction = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    analysisJob: {
      findMany: (...a: unknown[]) => mockJobFindMany(...a),
      findUnique: (...a: unknown[]) => mockJobFindUnique(...a),
      update: (...a: unknown[]) => mockJobUpdate(...a),
    },
    order: {
      findUnique: (...a: unknown[]) => mockOrderFindUnique(...a),
      update: (...a: unknown[]) => mockOrderUpdate(...a),
    },
    orderMetric: { deleteMany: (...a: unknown[]) => mockOrderMetricDeleteMany(...a) },
    dailyEffort: { deleteMany: (...a: unknown[]) => mockDailyEffortDeleteMany(...a) },
    commitAnalysis: { count: (...a: unknown[]) => mockCommitAnalysisCount(...a) },
    $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a),
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { analysisLogger: mockLogger, billingLogger: mockLogger, logger: mockLogger, default: mockLogger };
});

vi.mock('@/lib/services/ghost-metrics-service', () => ({
  getGhostMetricsService: vi.fn().mockReturnValue({
    calculateAndSave: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock('@/lib/services/credit-service', () => ({
  isBillingEnabled: vi.fn().mockReturnValue(false),
  releaseReservedCredits: vi.fn().mockResolvedValue(0),
  debitCredit: vi.fn().mockResolvedValue({ wallet: 'PERMANENT', balanceAfter: 99 }),
}));

vi.mock('@/lib/services/scope-filter', () => ({
  countInScopeCommits: vi.fn().mockResolvedValue(10),
}));

vi.mock('@/lib/llm-config', () => ({
  getLlmConfig: vi.fn().mockResolvedValue({
    provider: 'openrouter',
    openrouter: { inputPrice: 0.03, outputPrice: 0.11 },
  }),
}));

import { isBillingEnabled, debitCredit } from '@/lib/services/credit-service';
import { GET } from '../route';

// ── Helpers ──

function makeRequest(cronSecret?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cronSecret) headers['authorization'] = `Bearer ${cronSecret}`;
  return new NextRequest(new URL('http://localhost/api/cron/analysis-watchdog'), {
    method: 'GET',
    headers,
  });
}

// ── Tests ──

describe('GET /api/cron/analysis-watchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = 'test-cron-secret';
    delete process.env.MODAL_ENDPOINT_URL;
    // Default: no jobs found anywhere
    mockJobFindMany.mockResolvedValue([]);
    mockExecuteRaw.mockResolvedValue(0);
    mockQueryRaw.mockResolvedValue([]);
    mockTransaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
  });

  // ── Auth ──

  it('rejects request without auth header — 401', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it('rejects request with wrong secret — 401', async () => {
    const res = await GET(makeRequest('wrong-secret'));
    expect(res.status).toBe(401);
  });

  it('rejects when CRON_SECRET not configured — 401', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest('any-secret'));
    expect(res.status).toBe(401);
  });

  it('accepts valid CRON_SECRET — 200', async () => {
    const res = await GET(makeRequest('test-cron-secret'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.processed).toBe(0);
  });

  // ── Reaper ──

  it('marks stale RUNNING job as FAILED_RETRYABLE', async () => {
    const staleJob = {
      id: 'job-1',
      orderId: 'order-1',
      status: 'RUNNING',
      executionMode: 'modal',
      retryCount: 0,
      maxRetries: 3,
      heartbeatAt: new Date(Date.now() - 15 * 60 * 1000), // 15 min ago
    };

    // First findMany call = stale jobs, second = retries, third = orphans
    mockJobFindMany
      .mockResolvedValueOnce([staleJob])   // stale RUNNING
      .mockResolvedValueOnce([])            // FAILED_RETRYABLE (none — we just created it)
      .mockResolvedValueOnce([]);           // orphan PENDING

    const res = await GET(makeRequest('test-cron-secret'));
    const json = await res.json();

    expect(json.processed).toBe(1);
    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1' },
        data: expect.objectContaining({ status: 'FAILED_RETRYABLE' }),
      }),
    );
  });

  it('marks stale job as FAILED_FATAL when retries exhausted', async () => {
    const exhaustedJob = {
      id: 'job-2',
      orderId: 'order-2',
      status: 'RUNNING',
      executionMode: 'modal',
      retryCount: 3,
      maxRetries: 3,
      heartbeatAt: new Date(Date.now() - 15 * 60 * 1000),
    };

    mockJobFindMany
      .mockResolvedValueOnce([exhaustedJob])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    mockOrderFindUnique.mockResolvedValue({ id: 'order-2', userId: 'user-1' });

    const res = await GET(makeRequest('test-cron-secret'));
    const json = await res.json();

    expect(json.processed).toBe(1);
    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-2' },
        data: expect.objectContaining({ status: 'FAILED_FATAL' }),
      }),
    );
    // Should also update order to FAILED
    expect(mockOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-2' },
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });

  // ── Retry ──

  it('retries FAILED_RETRYABLE job — resets to PENDING + triggers Modal', async () => {
    process.env.MODAL_ENDPOINT_URL = 'https://modal.test/run';

    const retryableJob = {
      id: 'job-3',
      orderId: 'order-3',
      status: 'FAILED_RETRYABLE',
      executionMode: 'modal',
      retryCount: 1,
      maxRetries: 3,
    };

    mockJobFindMany
      .mockResolvedValueOnce([])              // stale
      .mockResolvedValueOnce([retryableJob])  // retryable
      .mockResolvedValueOnce([]);             // orphans

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ modal_call_id: 'mc-retry' }),
    }));

    const res = await GET(makeRequest('test-cron-secret'));
    const json = await res.json();

    expect(json.processed).toBe(1);

    // Should reset job to PENDING
    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-3' },
        data: expect.objectContaining({
          status: 'PENDING',
          retryCount: { increment: 1 },
          lockedBy: null,
          modalCallId: null,
        }),
      }),
    );

    // Should trigger Modal
    expect(fetch).toHaveBeenCalledWith('https://modal.test/run', expect.anything());

    vi.unstubAllGlobals();
  });

  // ── Post-processing ──

  it('post-processes LLM_COMPLETE job to COMPLETED', async () => {
    const llmCompleteJob = {
      id: 'job-4',
      orderId: 'order-4',
      status: 'LLM_COMPLETE',
      creditsReleased: 0,
      totalPromptTokens: null,
      totalCompletionTokens: null,
      llmConfigSnapshot: null,
      order: {
        id: 'order-4',
        userId: 'user-1',
        analysisPeriodMode: 'ALL_TIME',
        analysisYears: [],
        analysisStartDate: null,
        analysisEndDate: null,
        analysisCommitLimit: null,
        user: { id: 'user-1', role: 'USER' },
      },
    };

    // Atomic claim returns the job id
    mockQueryRaw
      .mockResolvedValueOnce([])                 // reconciliation query
      .mockResolvedValueOnce([{ id: 'job-4' }])  // first claim
      .mockResolvedValueOnce([]);                // no more

    mockJobFindUnique.mockResolvedValue(llmCompleteJob);
    mockCommitAnalysisCount.mockResolvedValue(10);
    mockOrderMetricDeleteMany.mockResolvedValue({ count: 0 });
    mockDailyEffortDeleteMany.mockResolvedValue({ count: 0 });

    const res = await GET(makeRequest('test-cron-secret'));
    const json = await res.json();

    expect(json.processed).toBe(1);

    // Job should be marked COMPLETED
    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-4' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          progress: 100,
          currentStep: 'done',
        }),
      }),
    );

    // Order should be marked COMPLETED
    expect(mockOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-4' },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });

  it('post-processing skips already-consumed credits (recovery idempotency)', async () => {
    // Scenario: job was partially debited (4 of 10), then recovered.
    // debitCredit should only be called 6 more times, not 10.
    vi.mocked(isBillingEnabled).mockReturnValue(true);

    const partialJob = {
      id: 'job-5',
      orderId: 'order-5',
      status: 'LLM_COMPLETE',
      creditsReleased: 0,
      creditsConsumed: 4,  // 4 already debited before crash
      totalPromptTokens: null,
      totalCompletionTokens: null,
      llmConfigSnapshot: null,
      order: {
        id: 'order-5',
        userId: 'user-2',
        analysisPeriodMode: 'ALL_TIME',
        analysisYears: [],
        analysisStartDate: null,
        analysisEndDate: null,
        analysisCommitLimit: null,
        user: { id: 'user-2', role: 'USER' },
      },
    };

    mockQueryRaw
      .mockResolvedValueOnce([])                 // reconciliation query
      .mockResolvedValueOnce([{ id: 'job-5' }])  // first claim
      .mockResolvedValueOnce([]);                // no more

    mockJobFindUnique.mockResolvedValue(partialJob);
    mockCommitAnalysisCount.mockResolvedValue(10); // 10 total processed
    mockOrderMetricDeleteMany.mockResolvedValue({ count: 0 });
    mockDailyEffortDeleteMany.mockResolvedValue({ count: 0 });

    const res = await GET(makeRequest('test-cron-secret'));
    expect(res.status).toBe(200);

    // debitCredit should be called exactly 6 times (10 - 0 cached - 4 consumed)
    expect(debitCredit).toHaveBeenCalledTimes(6);

    // Reset mock for other tests
    vi.mocked(isBillingEnabled).mockReturnValue(false);
  });

  // ── Stuck post_processing recovery ──

  it('resets stuck post_processing jobs', async () => {
    mockExecuteRaw.mockResolvedValue(2); // 2 stuck jobs reset

    const res = await GET(makeRequest('test-cron-secret'));
    const json = await res.json();

    expect(json.processed).toBe(2);
  });
});
