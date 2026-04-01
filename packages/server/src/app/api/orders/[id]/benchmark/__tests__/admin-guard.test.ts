import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Shared mock setup
const mockRequireAdmin = vi.fn();
const mockOrderFindFirst = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    order: { findFirst: (...a: unknown[]) => mockOrderFindFirst(...a) },
    analysisJob: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'j1' }),
    },
    commitAnalysis: { findMany: vi.fn().mockResolvedValue([]) },
    groundTruth: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
  apiResponse: vi.fn((data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })),
  apiError: vi.fn((msg: string, status: number) => new Response(JSON.stringify({ error: msg }), { status })),
  parseBody: vi.fn(async (req: NextRequest) => ({ success: true, data: await req.json() })),
}));

vi.mock('@/lib/llm-config', () => ({
  getConcurrencyFromConfig: () => ({ llm: 5, fd: null, fdCap: null }),
  getLlmConfig: vi.fn().mockResolvedValue({
    provider: 'openrouter',
    ollama: { url: 'http://localhost:11434', model: 'test' },
    openrouter: { apiKey: 'sk-test', model: 'test', providerOrder: [], providerIgnore: [], allowFallbacks: false, requireParameters: true },
    concurrency: { llm: 5, fd: null, fdCap: null },
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

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/services/job-registry', () => ({
  requestCancel: vi.fn(),
}));

describe('Benchmark admin guard', () => {
  const forbidden = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /benchmark returns 403 for non-admin', async () => {
    mockRequireAdmin.mockResolvedValue(forbidden);
    const { POST } = await import('../route');
    const req = new NextRequest('http://localhost/api/orders/o1/benchmark', {
      method: 'POST',
      body: JSON.stringify({ provider: 'openrouter', model: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'o1' }) });
    expect(res.status).toBe(403);
  });

  it('GET /benchmark returns 403 for non-admin', async () => {
    mockRequireAdmin.mockResolvedValue(forbidden);
    const { GET } = await import('../route');
    const req = new NextRequest('http://localhost/api/orders/o1/benchmark');
    const res = await GET(req, { params: Promise.resolve({ id: 'o1' }) });
    expect(res.status).toBe(403);
  });

  it('GET /benchmark/compare returns 403 for non-admin', async () => {
    mockRequireAdmin.mockResolvedValue(forbidden);
    const { GET } = await import('../compare/route');
    const req = new NextRequest('http://localhost/api/orders/o1/benchmark/compare');
    const res = await GET(req, { params: Promise.resolve({ id: 'o1' }) });
    expect(res.status).toBe(403);
  });

  it('GET /benchmark/[jobId] returns 403 for non-admin', async () => {
    mockRequireAdmin.mockResolvedValue(forbidden);
    const { GET } = await import('../[jobId]/route');
    const req = new NextRequest('http://localhost/api/orders/o1/benchmark/j1');
    const res = await GET(req, { params: Promise.resolve({ id: 'o1', jobId: 'j1' }) });
    expect(res.status).toBe(403);
  });

  it('DELETE /benchmark/[jobId] returns 403 for non-admin', async () => {
    mockRequireAdmin.mockResolvedValue(forbidden);
    const { DELETE } = await import('../[jobId]/route');
    const req = new NextRequest('http://localhost/api/orders/o1/benchmark/j1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'o1', jobId: 'j1' }) });
    expect(res.status).toBe(403);
  });
});
