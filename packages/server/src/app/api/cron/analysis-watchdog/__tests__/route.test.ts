import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──

const mockJobFindMany = vi.fn();
const mockJobFindUnique = vi.fn();
const mockJobUpdate = vi.fn();
const mockJobUpdateMany = vi.fn();
const mockOrderFindUnique = vi.fn();
const mockOrderUpdate = vi.fn();
const mockOrderMetricDeleteMany = vi.fn();
const mockDailyEffortDeleteMany = vi.fn();
const mockCommitAnalysisCount = vi.fn();
const mockExecuteRaw = vi.fn();
const mockQueryRaw = vi.fn();
const mockTransaction = vi.fn();
const mockCalculateAndSaveBatch = vi.fn();
const mockSystemSettingsUpsert = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    analysisJob: {
      findMany: (...a: unknown[]) => mockJobFindMany(...a),
      findUnique: (...a: unknown[]) => mockJobFindUnique(...a),
      update: (...a: unknown[]) => mockJobUpdate(...a),
      updateMany: (...a: unknown[]) => mockJobUpdateMany(...a),
    },
    order: {
      findUnique: (...a: unknown[]) => mockOrderFindUnique(...a),
      update: (...a: unknown[]) => mockOrderUpdate(...a),
    },
    orderMetric: { deleteMany: (...a: unknown[]) => mockOrderMetricDeleteMany(...a) },
    dailyEffort: { deleteMany: (...a: unknown[]) => mockDailyEffortDeleteMany(...a) },
    commitAnalysis: { count: (...a: unknown[]) => mockCommitAnalysisCount(...a) },
    systemSettings: { upsert: (...a: unknown[]) => mockSystemSettingsUpsert(...a) },
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
    calculateAndSaveBatch: (...a: unknown[]) => mockCalculateAndSaveBatch(...a),
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
    mockSystemSettingsUpsert.mockResolvedValue({});
    mockJobUpdateMany.mockResolvedValue({ count: 1 });
    mockTransaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]));
    mockCalculateAndSaveBatch.mockResolvedValue({
      metrics: [],
      totalDevelopers: 0,
      processedDevelopers: 0,
      nextOffset: 0,
      done: true,
    });
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
    expect(mockJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-4', status: 'LLM_COMPLETE' },
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

  // ── Resumable post_processing ──

  it('resumes stale post_processing checkpoint without reset', async () => {
    const resumableJob = {
      id: 'job-6',
      orderId: 'order-6',
      status: 'LLM_COMPLETE',
      currentStep: 'post_processing:active:metrics:10',
      creditsReleased: 0,
      totalPromptTokens: null,
      totalCompletionTokens: null,
      llmConfigSnapshot: null,
      order: {
        id: 'order-6',
        userId: 'user-6',
        analysisPeriodMode: 'ALL_TIME',
        analysisYears: [],
        analysisStartDate: null,
        analysisEndDate: null,
        analysisCommitLimit: null,
        user: { id: 'user-6', role: 'USER' },
      },
    };

    mockQueryRaw
      .mockResolvedValueOnce([])                  // reconciliation query
      .mockResolvedValueOnce([{ id: 'job-6' }])   // claim
      .mockResolvedValueOnce([]);                 // no more claims

    mockJobFindUnique.mockResolvedValue(resumableJob);
    mockCalculateAndSaveBatch.mockResolvedValue({
      metrics: [],
      totalDevelopers: 40,
      processedDevelopers: 10,
      nextOffset: 20,
      done: false,
    });

    const res = await GET(makeRequest('test-cron-secret'));
    const json = await res.json();

    expect(json.processed).toBe(1);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
    expect(mockCalculateAndSaveBatch).toHaveBeenCalledWith(
      'order-6',
      'user-6',
      expect.objectContaining({
        offset: 10,
        limit: expect.any(Number),
      }),
    );
    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-6' },
        data: expect.objectContaining({
          currentStep: 'post_processing:metrics:20',
          progress: 95,
        }),
      }),
    );
  });

  it('completes post-processing across multiple checkpoint iterations', async () => {
    const order = {
      id: 'order-7',
      userId: 'user-7',
      analysisPeriodMode: 'ALL_TIME',
      analysisYears: [],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
      user: { id: 'user-7', role: 'USER' },
    };

    mockQueryRaw
      .mockResolvedValueOnce([])                  // reconciliation query
      .mockResolvedValueOnce([{ id: 'job-7' }])   // claim #1
      .mockResolvedValueOnce([{ id: 'job-7' }])   // claim #2
      .mockResolvedValueOnce([]);                 // no more claims

    mockJobFindUnique
      .mockResolvedValueOnce({
        id: 'job-7',
        orderId: 'order-7',
        status: 'LLM_COMPLETE',
        currentStep: 'post_processing:active:metrics:0',
        creditsReleased: 0,
        totalPromptTokens: null,
        totalCompletionTokens: null,
        llmConfigSnapshot: null,
        order,
      })
      .mockResolvedValueOnce({
        id: 'job-7',
        orderId: 'order-7',
        status: 'LLM_COMPLETE',
        currentStep: 'post_processing:active:metrics:10',
        creditsReleased: 0,
        totalPromptTokens: null,
        totalCompletionTokens: null,
        llmConfigSnapshot: null,
        order,
      });

    mockCalculateAndSaveBatch
      .mockResolvedValueOnce({
        metrics: [],
        totalDevelopers: 20,
        processedDevelopers: 10,
        nextOffset: 10,
        done: false,
      })
      .mockResolvedValueOnce({
        metrics: [],
        totalDevelopers: 20,
        processedDevelopers: 10,
        nextOffset: 20,
        done: true,
      });

    const res = await GET(makeRequest('test-cron-secret'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.processed).toBe(2);
    expect(mockCalculateAndSaveBatch).toHaveBeenCalledTimes(2);
    expect(mockCalculateAndSaveBatch).toHaveBeenNthCalledWith(
      1,
      'order-7',
      'user-7',
      expect.objectContaining({ offset: 0 }),
    );
    expect(mockCalculateAndSaveBatch).toHaveBeenNthCalledWith(
      2,
      'order-7',
      'user-7',
      expect.objectContaining({ offset: 10 }),
    );
    expect(mockJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-7', status: 'LLM_COMPLETE' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          progress: 100,
          currentStep: 'done',
        }),
      }),
    );
  });
});
