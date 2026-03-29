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
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'test@test.com', role: 'ADMIN' } }),
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

function setupMocks() {
  mockOrderFindFirst.mockResolvedValue({ id: 'order-1', status: 'COMPLETED' });
  mockJobFindFirst
    .mockResolvedValueOnce(null)  // no running job
    .mockResolvedValueOnce({ id: 'base-job' })  // base job
    .mockResolvedValueOnce(null);  // no previous same profile
  mockJobCreate.mockResolvedValue({ id: 'new-job' });
  // Mock fetch for OpenRouter validation (models catalog + preflight)
  (global.fetch as any) = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'qwen/qwen3-coder-next', context_length: 196608 }] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
}

describe('POST /api/orders/[id]/benchmark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PIPELINE_MODE;
    delete process.env.MODAL_ENDPOINT_URL;
    delete process.env.MODAL_WEBHOOK_SECRET;
  });

  it('resolves target_rollout profile and stores full snapshot', async () => {
    setupMocks();
    const req = makeRequest({ profile: 'target_rollout' });
    const res = await POST(req, { params: Promise.resolve({ id: 'order-1' }) });
    expect(res.status).toBe(200);

    const createCall = mockJobCreate.mock.calls[0]![0];
    const snapshot = createCall.data.llmConfigSnapshot;
    expect(snapshot.benchmarkProfile).toBe('target_rollout');
    expect(snapshot.benchmarkProfileLabel).toBe('Full Rollout Candidate');
    expect(snapshot.fdV3Enabled).toBe(true);
    expect(snapshot.fdLargeModel).toBe('qwen/qwen3-coder-plus');
    expect(snapshot.fdLargeProvider).toBe('openrouter');
    expect(snapshot.promptRepeat).toBe(false);

    // Provider/model come from profile
    expect(createCall.data.llmProvider).toBe('openrouter');
    expect(createCall.data.llmModel).toBe('qwen/qwen3-coder-next');
  });

  it('does NOT read FD flags from env — profile is self-contained', async () => {
    // Even if env has different FD flags, profile should win
    process.env.FD_V3_ENABLED = 'false';
    process.env.FD_LARGE_LLM_MODEL = 'some-other-model';
    process.env.FD_LARGE_LLM_PROVIDER = 'ollama';

    setupMocks();
    const req = makeRequest({ profile: 'target_rollout' });
    await POST(req, { params: Promise.resolve({ id: 'order-1' }) });

    const snapshot = mockJobCreate.mock.calls[0]![0].data.llmConfigSnapshot;
    expect(snapshot.fdV3Enabled).toBe(true);
    expect(snapshot.fdLargeModel).toBe('qwen/qwen3-coder-plus');
    expect(snapshot.fdLargeProvider).toBe('openrouter');

    delete process.env.FD_V3_ENABLED;
    delete process.env.FD_LARGE_LLM_MODEL;
    delete process.env.FD_LARGE_LLM_PROVIDER;
  });

  it('resolves context length from OpenRouter catalog', async () => {
    setupMocks();
    const req = makeRequest({ profile: 'target_rollout' });
    await POST(req, { params: Promise.resolve({ id: 'order-1' }) });

    const snapshot = mockJobCreate.mock.calls[0]![0].data.llmConfigSnapshot;
    // The mock returns context_length: 196608
    expect(snapshot.contextLength).toBe(196608);
    expect(snapshot.effectiveContextLength).toBe(196608);
  });

  it('fingerprint includes full profile fields', async () => {
    setupMocks();
    const req = makeRequest({ profile: 'target_rollout' });
    await POST(req, { params: Promise.resolve({ id: 'order-1' }) });

    const fp = mockJobCreate.mock.calls[0]![0].data.llmConfigFingerprint;
    expect(fp).toBeTruthy();
    expect(typeof fp).toBe('string');
    expect(fp.length).toBe(16);
  });

  it('local launch calls processAnalysisJob with resolved config', async () => {
    setupMocks();
    const req = makeRequest({ profile: 'target_rollout' });
    await POST(req, { params: Promise.resolve({ id: 'order-1' }) });

    const { processAnalysisJob } = await import('@/lib/services/analysis-worker');
    expect(processAnalysisJob).toHaveBeenCalledWith('new-job', expect.objectContaining({
      isBenchmark: true,
      failFast: true,
      promptRepeat: false,
      contextLength: 196608,
    }));
  });

  it('dispatches to Modal when PIPELINE_MODE=modal', async () => {
    process.env.PIPELINE_MODE = 'modal';
    process.env.MODAL_ENDPOINT_URL = 'https://modal.test/trigger';
    process.env.MODAL_WEBHOOK_SECRET = 'test-secret';

    setupMocks();

    const mockJobUpdate = vi.fn().mockResolvedValue({});
    const db = (await import('@/lib/db')).default;
    (db.analysisJob as any).update = mockJobUpdate;

    // Mock fetch: OpenRouter catalog + preflight + Modal trigger
    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'qwen/qwen3-coder-next', context_length: 196608 }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ modal_call_id: 'mc-1' }) });

    const req = makeRequest({ profile: 'target_rollout' });
    const res = await POST(req, { params: Promise.resolve({ id: 'order-1' }) });
    expect(res.status).toBe(200);

    // Verify Modal was triggered (3rd fetch call)
    const fetchCalls = (global.fetch as any).mock.calls;
    const modalCall = fetchCalls[2];
    expect(modalCall[0]).toBe('https://modal.test/trigger');

    // Verify pipeline flags saved
    const updateCall = mockJobUpdate.mock.calls[0];
    expect(updateCall[0].data.executionMode).toBe('modal');
    expect(updateCall[0].data.cacheMode).toBe('off');
    expect(updateCall[0].data.skipBilling).toBe(true);

    // processAnalysisJob should NOT be called in modal mode
    const { processAnalysisJob } = await import('@/lib/services/analysis-worker');
    expect(processAnalysisJob).not.toHaveBeenCalled();
  });
});
