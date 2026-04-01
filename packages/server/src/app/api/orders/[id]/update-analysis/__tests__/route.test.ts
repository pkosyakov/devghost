import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──

const mockOrderFindFirst = vi.fn();
const mockJobFindFirst = vi.fn();
const mockJobCreate = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    order: { findFirst: (...a: unknown[]) => mockOrderFindFirst(...a) },
    analysisJob: {
      findFirst: (...a: unknown[]) => mockJobFindFirst(...a),
      create: (...a: unknown[]) => mockJobCreate(...a),
    },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn(),
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

import { requireUserSession } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { POST } from '../route';

// ── Helpers ──

const mockOrder = { id: 'order-1', userId: 'user-1', status: 'COMPLETED' };
const mockJob = { id: 'job-new', orderId: 'order-1', status: 'PENDING' };

function makeRequest(): NextRequest {
  return new NextRequest(new URL('http://localhost/api/orders/order-1/update-analysis'), {
    method: 'POST',
  });
}

function setupSession() {
  vi.mocked(requireUserSession).mockResolvedValue({
    user: { id: 'user-1', email: 'user@test.com', role: 'USER' },
  } as any);
}

// ── Tests ──

describe('POST /api/orders/[id]/update-analysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrderFindFirst.mockResolvedValue(mockOrder);
    mockJobCreate.mockResolvedValue(mockJob);
    mockResolveEffectiveContext.mockResolvedValue({
      rawContextLength: 65536,
      effectiveContextLength: 49152,
    });
    mockConfigFromSnapshot.mockReturnValue(null);
  });

  it('inherits effectiveContextLength from previous analysis snapshot', async () => {
    setupSession();
    mockJobFindFirst.mockResolvedValue({
      lastAnalyzedShas: { repo: 'abc123' },
      llmConfigSnapshot: {
        provider: 'openrouter',
        openrouter: { model: 'qwen/qwen3-coder-next', apiKey: '[REDACTED]' },
        ollama: { url: 'http://localhost:11434', model: 'qwen2.5-coder:32b' },
        contextLength: 131072,
        effectiveContextLength: 98304,
      },
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    expect(res.status).toBe(200);

    // Should reuse snapshot context, not resolve fresh
    expect(mockResolveEffectiveContext).not.toHaveBeenCalled();
    expect(processAnalysisJob).toHaveBeenCalledWith('job-new', { contextLength: 98304 });

    // Snapshot should be persisted on the new job
    const createCall = mockJobCreate.mock.calls[0][0];
    expect(createCall.data.llmConfigSnapshot.effectiveContextLength).toBe(98304);
    expect(createCall.data.llmConfigSnapshot.contextLength).toBe(131072);
    // API key must be stripped
    expect(createCall.data.llmConfigSnapshot.openrouter.apiKey).toBeUndefined();
    // Concurrency should be stamped with current env values
    expect(createCall.data.llmConfigSnapshot.concurrency).toEqual({ llm: 5, fd: null, fdCap: null });
  });

  it('resolves context via configFromSnapshot when snapshot lacks effectiveContextLength', async () => {
    setupSession();
    const legacySnapshot = {
      provider: 'ollama',
      ollama: { url: 'http://myhost:11434', model: 'qwen3-coder-next' },
      openrouter: { model: 'qwen/qwen3-coder-next' },
    };
    mockJobFindFirst.mockResolvedValue({
      lastAnalyzedShas: null,
      llmConfigSnapshot: legacySnapshot,
    });
    // configFromSnapshot returns a reconstructed LlmConfig
    const reconstructed = {
      provider: 'ollama',
      ollama: { url: 'http://myhost:11434', model: 'qwen3-coder-next' },
      openrouter: { apiKey: '', model: '', inputPrice: 0, outputPrice: 0, providerOrder: [], providerIgnore: [], allowFallbacks: true, requireParameters: true },
    };
    mockConfigFromSnapshot.mockReturnValue(reconstructed);
    mockResolveEffectiveContext.mockResolvedValue({
      rawContextLength: 131072,
      effectiveContextLength: 131072, // ollama, no factor
    });

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    expect(res.status).toBe(200);

    // Should resolve against snapshot model, not getLlmConfig
    expect(mockConfigFromSnapshot).toHaveBeenCalledWith(legacySnapshot);
    expect(mockResolveEffectiveContext).toHaveBeenCalledWith(reconstructed);
    expect(mockGetLlmConfig).not.toHaveBeenCalled();

    expect(processAnalysisJob).toHaveBeenCalledWith('job-new', { contextLength: 131072 });

    // Enriched snapshot should have context fields
    const createCall = mockJobCreate.mock.calls[0][0];
    expect(createCall.data.llmConfigSnapshot.effectiveContextLength).toBe(131072);
    expect(createCall.data.llmConfigSnapshot.contextLength).toBe(131072);
  });

  it('resolves from getLlmConfig when no previous snapshot exists', async () => {
    setupSession();
    mockJobFindFirst.mockResolvedValue(null); // no previous job

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    expect(res.status).toBe(200);

    // No snapshot to reconstruct — should use getLlmConfig
    expect(mockConfigFromSnapshot).not.toHaveBeenCalled();
    expect(mockGetLlmConfig).toHaveBeenCalled();
    expect(mockResolveEffectiveContext).toHaveBeenCalled();

    expect(processAnalysisJob).toHaveBeenCalledWith('job-new', { contextLength: 49152 });
  });

  it('filters to type:analysis — ignores benchmark jobs', async () => {
    setupSession();
    mockJobFindFirst.mockResolvedValue(null);

    await POST(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });

    // Verify the findFirst query includes type: 'analysis'
    const findCall = mockJobFindFirst.mock.calls[0][0];
    expect(findCall.where.type).toBe('analysis');
    expect(findCall.where.status).toBe('COMPLETED');
  });
});
