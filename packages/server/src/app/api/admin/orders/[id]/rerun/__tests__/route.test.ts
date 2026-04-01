import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──

const mockTransaction = vi.fn();
const mockOrderFindUnique = vi.fn();
const mockOrderUpdate = vi.fn();
const mockJobFindMany = vi.fn();
const mockJobFindFirst = vi.fn();
const mockJobCreate = vi.fn();
const mockJobUpdate = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    order: {
      findUnique: (...a: unknown[]) => mockOrderFindUnique(...a),
      update: (...a: unknown[]) => mockOrderUpdate(...a),
    },
    analysisJob: {
      findMany: (...a: unknown[]) => mockJobFindMany(...a),
      findFirst: (...a: unknown[]) => mockJobFindFirst(...a),
      create: (...a: unknown[]) => mockJobCreate(...a),
      update: (...a: unknown[]) => mockJobUpdate(...a),
    },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireAdmin: vi.fn(),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
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

vi.mock('@/lib/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/job-event-service', () => ({
  appendJobEvent: vi.fn().mockResolvedValue(undefined),
}));

const mockGetLlmConfig = vi.fn().mockResolvedValue({
  provider: 'openrouter',
  ollama: { url: 'http://localhost:11434', model: 'qwen2.5-coder:32b' },
  openrouter: {
    apiKey: 'sk-current-key',
    model: 'qwen/qwen3-coder-next',
    inputPrice: 0.03,
    outputPrice: 0.11,
    providerOrder: [],
    providerIgnore: [],
    allowFallbacks: true,
    requireParameters: true,
  },
});
vi.mock('@/lib/llm-config', () => ({
  getLlmConfig: (...a: unknown[]) => mockGetLlmConfig(...a),
  getConcurrencySnapshot: () => ({ llm: 5, fd: null, fdCap: null }),
}));

const mockResolveEffectiveContext = vi.fn().mockResolvedValue({
  rawContextLength: 65536,
  effectiveContextLength: 49152,
});
const mockConfigFromSnapshot = vi.fn();
vi.mock('@/lib/services/model-context', () => ({
  resolveEffectiveContext: (...a: unknown[]) => mockResolveEffectiveContext(...a),
  configFromSnapshot: (...a: unknown[]) => mockConfigFromSnapshot(...a),
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { analysisLogger: mockLogger, logger: mockLogger, default: mockLogger };
});

import { requireAdmin } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { POST } from '../route';

// ── Helpers ──

const mockOrder = { id: 'order-1', userId: 'admin-1', status: 'COMPLETED' };
const mockJob = { id: 'job-rerun', orderId: 'order-1', status: 'PENDING' };

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest(new URL('http://localhost/api/admin/orders/order-1/rerun'), {
    method: 'POST',
    ...(body !== undefined ? {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : {}),
  });
}

function setupAdmin() {
  vi.mocked(requireAdmin).mockResolvedValue({
    user: { id: 'admin-1', email: 'admin@test.com', role: 'ADMIN' },
  } as any);
}

function setupTransaction() {
  mockTransaction.mockImplementation(async (fn: any) => {
    const tx = {
      order: {
        findUnique: vi.fn().mockResolvedValue({ status: 'COMPLETED' }),
        update: mockOrderUpdate,
      },
      analysisJob: {
        findFirst: mockJobFindFirst.mockResolvedValue(null), // no active job
        create: mockJobCreate.mockResolvedValue(mockJob),
      },
    };
    return fn(tx);
  });
}

// ── Tests ──

describe('POST /api/admin/orders/[id]/rerun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PIPELINE_MODE;
    mockOrderFindUnique.mockResolvedValue(mockOrder);
    mockResolveEffectiveContext.mockResolvedValue({
      rawContextLength: 65536,
      effectiveContextLength: 49152,
    });
    mockConfigFromSnapshot.mockReturnValue(null);
  });

  it('extracts effectiveContextLength from inherited snapshot and passes to processAnalysisJob', async () => {
    setupAdmin();
    setupTransaction();
    mockJobFindMany.mockResolvedValue([{
      cacheMode: 'model',
      llmConfigSnapshot: {
        provider: 'openrouter',
        openrouter: { model: 'qwen/qwen3-coder-next', apiKey: '[REDACTED]' },
        ollama: { url: 'http://localhost:11434', model: 'qwen2.5-coder:32b' },
        contextLength: 131072,
        effectiveContextLength: 98304,
      },
    }]);

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    expect(res.status).toBe(200);

    // Should use snapshot context directly, no fresh resolution
    expect(mockResolveEffectiveContext).not.toHaveBeenCalled();

    // processAnalysisJob should receive contextLength
    expect(processAnalysisJob).toHaveBeenCalledWith('job-rerun', expect.objectContaining({
      contextLength: 98304,
      cacheMode: 'model',
      skipBillingOverride: true,
    }));
  });

  it('resolves context via configFromSnapshot when snapshot lacks effectiveContextLength', async () => {
    setupAdmin();
    setupTransaction();

    const legacySnapshot = {
      provider: 'ollama',
      ollama: { url: 'http://myhost:11434', model: 'qwen3-coder-next' },
      openrouter: { model: '' },
    };
    mockJobFindMany.mockResolvedValue([{
      cacheMode: 'model',
      llmConfigSnapshot: legacySnapshot,
    }]);

    const reconstructed = {
      provider: 'ollama',
      ollama: { url: 'http://myhost:11434', model: 'qwen3-coder-next' },
      openrouter: { apiKey: '', model: '', inputPrice: 0, outputPrice: 0, providerOrder: [], providerIgnore: [], allowFallbacks: true, requireParameters: true },
    };
    mockConfigFromSnapshot.mockReturnValue(reconstructed);
    mockResolveEffectiveContext.mockResolvedValue({
      rawContextLength: 131072,
      effectiveContextLength: 131072,
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    expect(res.status).toBe(200);

    // Should resolve against snapshot model, NOT getLlmConfig
    expect(mockConfigFromSnapshot).toHaveBeenCalled();
    expect(mockResolveEffectiveContext).toHaveBeenCalledWith(reconstructed);

    expect(processAnalysisJob).toHaveBeenCalledWith('job-rerun', expect.objectContaining({
      contextLength: 131072,
    }));

    // Snapshot in the created job should be enriched
    const createData = mockJobCreate.mock.calls[0][0].data;
    const snap = createData.llmConfigSnapshot as Record<string, unknown>;
    expect(snap.effectiveContextLength).toBe(131072);
    expect(snap.contextLength).toBe(131072);
  });

  it('falls back to getLlmConfig when no previous snapshot exists', async () => {
    setupAdmin();
    setupTransaction();
    mockJobFindMany.mockResolvedValue([]); // no previous jobs

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    expect(res.status).toBe(200);

    // No snapshot → getLlmConfig for both snapshot creation and context resolution
    expect(mockGetLlmConfig).toHaveBeenCalled();
    expect(mockResolveEffectiveContext).toHaveBeenCalled();

    expect(processAnalysisJob).toHaveBeenCalledWith('job-rerun', expect.objectContaining({
      contextLength: 49152,
    }));
  });

  it('accepts admin-selected cache and recalculation options', async () => {
    setupAdmin();
    setupTransaction();
    mockJobFindMany.mockResolvedValue([]);

    const res = await POST(
      makeRequest({ cacheMode: 'off', forceRecalculate: true }),
      { params: Promise.resolve({ id: 'order-1' }) },
    );
    expect(res.status).toBe(200);

    expect(mockJobCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        cacheMode: 'off',
        forceRecalculate: true,
      }),
    }));
    expect(processAnalysisJob).toHaveBeenCalledWith('job-rerun', expect.objectContaining({
      cacheMode: 'off',
      forceRecalculate: true,
    }));
  });
});
