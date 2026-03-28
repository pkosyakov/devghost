import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockOrderFindFirst = vi.fn();
const mockJobFindFirst = vi.fn();
const mockJobCreate = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    order: { findFirst: (...a: unknown[]) => mockOrderFindFirst(...a) },
    analysisJob: { findFirst: (...a: unknown[]) => mockJobFindFirst(...a), create: (...a: unknown[]) => mockJobCreate(...a) },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'test@test.com', role: 'USER' } }),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
  apiResponse: vi.fn((data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })),
  apiError: vi.fn((msg: string, status: number) => new Response(JSON.stringify({ success: false, error: msg }), { status })),
  parseBody: vi.fn(async (req: NextRequest) => {
    const body = await req.json();
    return { success: true, data: body };
  }),
}));

vi.mock('@/lib/llm-config', () => ({
  getLlmConfig: vi.fn().mockResolvedValue({
    provider: 'openrouter',
    ollama: { url: 'http://localhost:11434', model: 'test' },
    openrouter: { apiKey: 'sk-test', model: 'test', providerOrder: [], providerIgnore: [], allowFallbacks: false, requireParameters: true },
  }),
}));

vi.mock('@/lib/services/model-context', () => ({
  DEFAULT_CTX: 32768,
  clampContext: vi.fn((v: number) => v),
  resolveModelContext: vi.fn().mockResolvedValue(null),
  computeEffectiveContext: vi.fn((v: number) => v),
}));

vi.mock('@/lib/services/analysis-worker', () => ({
  processAnalysisJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/pipeline-bridge', () => ({
  checkOllamaHealth: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { analysisLogger: mockLogger };
});

import { POST } from '../route';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL('http://localhost/api/orders/order-1/benchmark'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/orders/[id]/benchmark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FD_V3_ENABLED = 'true';
    process.env.FD_LARGE_LLM_MODEL = 'qwen/qwen3-coder-plus';
    process.env.FD_LARGE_LLM_PROVIDER = 'openrouter';
    // Mock fetch for OpenRouter validation (models catalog + preflight)
    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'qwen/qwen3-coder-next', context_length: 32768 }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
  });

  it('includes FD v3 config in snapshot', async () => {
    mockOrderFindFirst.mockResolvedValue({ id: 'order-1', status: 'COMPLETED' });
    mockJobFindFirst
      .mockResolvedValueOnce(null)  // no running job
      .mockResolvedValueOnce({ id: 'base-job' })  // base job
      .mockResolvedValueOnce(null);  // no previous same model
    mockJobCreate.mockResolvedValue({ id: 'new-job' });

    const req = makeRequest({ provider: 'openrouter', model: 'qwen/qwen3-coder-next' });
    await POST(req, { params: Promise.resolve({ id: 'order-1' }) });

    const createCall = mockJobCreate.mock.calls[0]![0];
    const snapshot = createCall.data.llmConfigSnapshot;
    expect(snapshot.fdV3Enabled).toBe(true);
    expect(snapshot.fdLargeModel).toBe('qwen/qwen3-coder-plus');
    expect(snapshot.fdLargeProvider).toBe('openrouter');
  });

  it('FD v3 config affects fingerprint', async () => {
    mockOrderFindFirst.mockResolvedValue({ id: 'order-1', status: 'COMPLETED' });
    mockJobFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'base-job' })
      .mockResolvedValueOnce(null);
    mockJobCreate.mockResolvedValue({ id: 'job-1' });

    const req1 = makeRequest({ provider: 'openrouter', model: 'qwen/qwen3-coder-next' });
    await POST(req1, { params: Promise.resolve({ id: 'order-1' }) });
    const fp1 = mockJobCreate.mock.calls[0]![0].data.llmConfigFingerprint;

    // Change FD config
    process.env.FD_LARGE_LLM_MODEL = 'qwen/qwen3-coder-32b';
    vi.clearAllMocks();
    mockOrderFindFirst.mockResolvedValue({ id: 'order-1', status: 'COMPLETED' });
    mockJobFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'base-job' }).mockResolvedValueOnce(null);
    mockJobCreate.mockResolvedValue({ id: 'job-2' });
    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'qwen/qwen3-coder-next', context_length: 32768 }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const req2 = makeRequest({ provider: 'openrouter', model: 'qwen/qwen3-coder-next' });
    await POST(req2, { params: Promise.resolve({ id: 'order-1' }) });
    const fp2 = mockJobCreate.mock.calls[0]![0].data.llmConfigFingerprint;

    expect(fp1).not.toBe(fp2);
  });
});
