import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──

const mockTransaction = vi.fn();
const mockJobUpdate = vi.fn();
const mockJobCreate = vi.fn();
const mockJobFindFirst = vi.fn();
const mockOrderFindFirst = vi.fn();
const mockOrderUpdate = vi.fn();
const mockCommitAnalysisCount = vi.fn();
const mockCommitAnalysisFindMany = vi.fn();
const mockUserFindUnique = vi.fn();
const mockCreditTransactionCreate = vi.fn();
const mockExecuteRaw = vi.fn();
const mockAppendJobEvent = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockComputeBillingPreview = vi.fn();
const mockGetOrderWithAuth = vi.fn();
const mockOrderAuthError = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    order: { findFirst: (...a: unknown[]) => mockOrderFindFirst(...a), update: (...a: unknown[]) => mockOrderUpdate(...a) },
    analysisJob: {
      findFirst: (...a: unknown[]) => mockJobFindFirst(...a),
      create: (...a: unknown[]) => mockJobCreate(...a),
      update: (...a: unknown[]) => mockJobUpdate(...a),
    },
    commitAnalysis: {
      count: (...a: unknown[]) => mockCommitAnalysisCount(...a),
      findMany: (...a: unknown[]) => mockCommitAnalysisFindMany(...a),
    },
    user: { findUnique: (...a: unknown[]) => mockUserFindUnique(...a) },
    creditTransaction: { create: (...a: unknown[]) => mockCreditTransactionCreate(...a) },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
    $executeRaw: (...a: unknown[]) => mockExecuteRaw(...a),
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn(),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
  getOrderWithAuth: (...a: unknown[]) => mockGetOrderWithAuth(...a),
  orderAuthError: (...a: unknown[]) => mockOrderAuthError(...a),
  apiResponse: vi.fn((data: unknown, status = 200) =>
    new Response(JSON.stringify({ success: true, data }), { status }),
  ),
  apiError: vi.fn((msg: string, status: number) =>
    new Response(JSON.stringify({ success: false, error: msg }), { status }),
  ),
}));

vi.mock('@/lib/services/analysis-worker', () => ({
  processAnalysisJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/credit-service', () => ({
  isBillingEnabled: vi.fn().mockReturnValue(false),
  getAvailableBalance: vi.fn().mockResolvedValue({ available: 1000 }),
  runExpiryGuard: vi.fn().mockResolvedValue(0),
}));

vi.mock('@/lib/llm-config', () => ({
  getConcurrencyFromConfig: () => ({ llm: 5, fd: null, fdCap: null }),
  getLlmConfig: vi.fn().mockResolvedValue({
    provider: 'openrouter',
    ollama: { url: 'http://localhost:11434', model: 'qwen2.5-coder:32b' },
    openrouter: {
      apiKey: 'sk-secret-key',
      model: 'qwen/qwen-2.5-coder-32b-instruct',
      inputPrice: 0.03,
      outputPrice: 0.11,
      providerOrder: ['Chutes'],
      providerIgnore: ['Cloudflare'],
      allowFallbacks: true,
      requireParameters: true,
    },
    concurrency: { llm: 5, fd: null, fdCap: null },
  }),
}));

vi.mock('@/lib/services/model-context', () => ({
  resolveEffectiveContext: vi.fn().mockResolvedValue({
    rawContextLength: 65536,
    effectiveContextLength: 49152, // 65536 * 0.75
  }),
}));

vi.mock('@/lib/services/job-event-service', () => ({
  appendJobEvent: (...a: unknown[]) => mockAppendJobEvent(...a),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a),
}));

vi.mock('@/lib/services/analysis-billing-preview', () => ({
  computeBillingPreview: (...a: unknown[]) => mockComputeBillingPreview(...a),
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { analysisLogger: mockLogger, billingLogger: mockLogger, logger: mockLogger, default: mockLogger };
});

import { requireUserSession, getOrderWithAuth } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { getLlmConfig } from '@/lib/llm-config';
import { resolveEffectiveContext } from '@/lib/services/model-context';
import { POST } from '../route';

// ── Helpers ──

const mockOrder = {
  id: 'order-1',
  userId: 'user-1',
  status: 'READY_FOR_ANALYSIS',
  excludedDevelopers: [],
  selectedDevelopers: [{ email: 'dev@test.com', commit_count: 10 }],
  analysisPeriodMode: 'ALL_TIME',
  analysisCommitLimit: null,
};

const mockJob = { id: 'job-1', orderId: 'order-1', status: 'PENDING' };

function makeRequest(body: Record<string, unknown> = {}): NextRequest {
  return new NextRequest(new URL('http://localhost/api/orders/order-1/analyze'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupSession(role = 'USER') {
  vi.mocked(requireUserSession).mockResolvedValue({
    user: { id: 'user-1', email: 'user@test.com', role },
  } as any);
}

function setupTransaction() {
  mockTransaction.mockImplementation(async (fn: any) => {
    const tx = {
      order: { update: mockOrderUpdate },
      analysisJob: {
        findFirst: mockJobFindFirst.mockResolvedValue(null),
        create: mockJobCreate.mockResolvedValue(mockJob),
        update: mockJobUpdate,
      },
      user: { findUnique: mockUserFindUnique },
      creditTransaction: { create: mockCreditTransactionCreate },
      $executeRaw: mockExecuteRaw.mockResolvedValue(1),
    };
    return fn(tx);
  });
}

// ── Tests ──

describe('POST /api/orders/[id]/analyze', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PIPELINE_MODE;
    delete process.env.MODAL_ENDPOINT_URL;
    delete process.env.MODAL_WEBHOOK_SECRET;
    mockOrderFindFirst.mockResolvedValue(mockOrder);
    mockCommitAnalysisCount.mockResolvedValue(0);
    mockCommitAnalysisFindMany.mockResolvedValue([]);
    mockCheckRateLimit.mockResolvedValue(null);
    mockComputeBillingPreview.mockResolvedValue(10);
    mockAppendJobEvent.mockResolvedValue(undefined);
    mockGetOrderWithAuth.mockResolvedValue({ success: true, order: mockOrder });
    mockOrderAuthError.mockImplementation((result: unknown) => result);
  });

  it('local mode: calls processAnalysisJob with contextLength (default)', async () => {
    setupSession();
    setupTransaction();

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.jobId).toBe('job-1');
    // Context resolution is called and effectiveContextLength is passed to the worker
    expect(resolveEffectiveContext).toHaveBeenCalled();
    expect(processAnalysisJob).toHaveBeenCalledWith('job-1', {
      cacheMode: 'model',
      forceRecalculate: false,
      contextLength: 49152,
    });
  });

  it('local mode: explicit PIPELINE_MODE=local', async () => {
    process.env.PIPELINE_MODE = 'local';
    setupSession();
    setupTransaction();

    await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });

    expect(processAnalysisJob).toHaveBeenCalled();
  });

  it('modal mode: saves llmConfigSnapshot and triggers Modal', async () => {
    process.env.PIPELINE_MODE = 'modal';
    process.env.MODAL_ENDPOINT_URL = 'https://modal.test/run';
    process.env.MODAL_WEBHOOK_SECRET = 'test-secret';

    setupSession();
    setupTransaction();

    // Mock fetch for Modal trigger
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ modal_call_id: 'mc-123' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const res = await POST(
      makeRequest({ forceRecalculate: true }),
      { params: Promise.resolve({ id: 'order-1' }) },
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.jobId).toBe('job-1');

    // Should NOT call local processAnalysisJob
    expect(processAnalysisJob).not.toHaveBeenCalled();

    // Should call getLlmConfig for snapshot
    expect(getLlmConfig).toHaveBeenCalled();

    // executionMode should be set in the transaction create, not in update
    expect(mockJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ executionMode: 'modal' }),
      }),
    );

    // 3 updates: pipeline flags, llmConfigSnapshot, modalCallId
    expect(mockJobUpdate).toHaveBeenCalledTimes(3);

    // First update: pipeline flags (survives getLlmConfig failure)
    const flagsUpdate = mockJobUpdate.mock.calls[0][0];
    expect(flagsUpdate.where.id).toBe('job-1');
    expect(flagsUpdate.data.cacheMode).toBe('model');
    expect(flagsUpdate.data.skipBilling).toBe(true); // billing disabled in mock
    expect(flagsUpdate.data.forceRecalculate).toBe(true);

    // Second update: llmConfigSnapshot with context fields
    const snapshotUpdate = mockJobUpdate.mock.calls[1][0];
    expect(snapshotUpdate.where.id).toBe('job-1');
    expect(snapshotUpdate.data.llmConfigSnapshot.openrouter.apiKey).toBeUndefined();
    expect(snapshotUpdate.data.llmConfigSnapshot.contextLength).toBe(65536);
    expect(snapshotUpdate.data.llmConfigSnapshot.effectiveContextLength).toBe(49152);
    expect(snapshotUpdate.data.llmConfigSnapshot.concurrency).toEqual({ llm: 5, fd: null, fdCap: null });

    // Third update: modalCallId from successful trigger
    const modalUpdate = mockJobUpdate.mock.calls[2][0];
    expect(modalUpdate.data.modalCallId).toBe('mc-123');

    // Should have triggered Modal with correct payload
    expect(mockFetch).toHaveBeenCalledWith('https://modal.test/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: 'job-1', auth_token: 'test-secret' }),
    });

    vi.unstubAllGlobals();
  });

  it('modal mode: trigger failure leaves job PENDING for watchdog', async () => {
    process.env.PIPELINE_MODE = 'modal';
    process.env.MODAL_ENDPOINT_URL = 'https://modal.test/run';
    process.env.MODAL_WEBHOOK_SECRET = 'test-secret';

    setupSession();
    setupTransaction();

    // Mock fetch failure
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();

    // Should still return 200 — job is created, watchdog will pick it up
    expect(res.status).toBe(200);
    expect(json.data.jobId).toBe('job-1');
    expect(processAnalysisJob).not.toHaveBeenCalled();

    // modalCallId update should NOT have been called (trigger failed)
    // Only the llmConfigSnapshot update happened
    const modalCallIdUpdates = mockJobUpdate.mock.calls.filter(
      (call: any) => call[0]?.data?.modalCallId,
    );
    expect(modalCallIdUpdates).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it('modal mode: non-ok response logs warning, job stays PENDING', async () => {
    process.env.PIPELINE_MODE = 'modal';
    process.env.MODAL_ENDPOINT_URL = 'https://modal.test/run';
    process.env.MODAL_WEBHOOK_SECRET = 'test-secret';

    setupSession();
    setupTransaction();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });

    expect(res.status).toBe(200);
    expect(processAnalysisJob).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('modal mode: ADMIN sets skipBilling=true', async () => {
    process.env.PIPELINE_MODE = 'modal';
    process.env.MODAL_ENDPOINT_URL = 'https://modal.test/run';

    setupSession('ADMIN');
    setupTransaction();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ modal_call_id: 'mc-456' }),
    }));

    await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });

    const flagsUpdate = mockJobUpdate.mock.calls[0][0];
    expect(flagsUpdate.data.skipBilling).toBe(true);

    vi.unstubAllGlobals();
  });

  it('local mode: selectedCommitHashes triggers targeted recalculation without lastAnalyzedShas persistence', async () => {
    setupSession();
    setupTransaction();
    const selectedSha = 'a'.repeat(40);
    mockCommitAnalysisFindMany.mockResolvedValue([{ commitHash: selectedSha }]);

    const res = await POST(
      makeRequest({ selectedCommitHashes: [selectedSha], forceRecalculate: true }),
      { params: Promise.resolve({ id: 'order-1' }) },
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.jobId).toBe('job-1');
    expect(processAnalysisJob).toHaveBeenCalledWith('job-1', {
      cacheMode: 'off',
      forceRecalculate: true,
      selectedCommitHashes: [selectedSha],
      contextLength: 49152,
    });
    expect(mockJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          lastAnalyzedShas: expect.anything(),
        }),
      }),
    );
  });

  it('rejects selectedCommitHashes in modal mode', async () => {
    process.env.PIPELINE_MODE = 'modal';
    process.env.MODAL_ENDPOINT_URL = 'https://modal.test/run';
    process.env.MODAL_WEBHOOK_SECRET = 'test-secret';
    setupSession();
    setupTransaction();

    const res = await POST(
      makeRequest({ selectedCommitHashes: ['b'.repeat(40)], forceRecalculate: true }),
      { params: Promise.resolve({ id: 'order-1' }) },
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain('not supported in modal mode');
    expect(processAnalysisJob).not.toHaveBeenCalled();
  });
});
