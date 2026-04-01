import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──

const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    systemSettings: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      upsert: (...a: unknown[]) => mockUpsert(...a),
    },
  },
}));

const mockRequireAdmin = vi.fn();
vi.mock('@/lib/api-utils', () => ({
  requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
  apiResponse: vi.fn((data: unknown, status = 200) =>
    new Response(JSON.stringify({ success: true, data }), { status }),
  ),
  apiError: vi.fn((msg: string, status: number) =>
    new Response(JSON.stringify({ success: false, error: msg }), { status }),
  ),
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const log = { info: noop, warn: noop, error: noop, debug: noop, child: () => log };
  return { logger: log };
});

vi.mock('@/lib/audit', () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import { GET, PATCH } from '../route';

// ── Helpers ──

const adminUser = { id: 'admin-1', email: 'admin@test.com', role: 'ADMIN' };

function jsonResponse(res: Response) {
  return res.json();
}

// ── Tests ──

describe('GET /api/admin/llm-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ user: adminUser });
    // Clean env for each test
    delete process.env.FD_V3_ENABLED;
    delete process.env.FD_LARGE_LLM_PROVIDER;
    delete process.env.FD_LARGE_LLM_MODEL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LLM_CONCURRENCY;
    delete process.env.FD_LLM_CONCURRENCY;
    delete process.env.FD_LLM_CONCURRENCY_CAP;
  });

  it('returns new defaults when no SystemSettings record exists', async () => {
    mockFindUnique.mockResolvedValue(null);

    const res = await GET();
    const body = await jsonResponse(res);

    expect(body.success).toBe(true);
    expect(body.data.llmProvider).toBe('openrouter');
    expect(body.data.openrouterModel).toBe('qwen/qwen3-coder-next');
    expect(body.data.openrouterInputPrice).toBe(0.12);
    expect(body.data.openrouterOutputPrice).toBe(0.75);
    // Concurrency defaults: all null/auto when no DB record and no env
    expect(body.data.llmConcurrency).toBeNull();
    expect(body.data.llmConcurrencyEffective).toBeNull();
    expect(body.data.llmConcurrencySource).toBe('auto');
    expect(body.data.fdLlmConcurrency).toBeNull();
    expect(body.data.fdLlmConcurrencyEffective).toBeNull(); // no LLM_CONCURRENCY to inherit
    expect(body.data.fdLlmConcurrencySource).toBe('auto');
    expect(body.data.fdLlmConcurrencyCap).toBeNull();
    expect(body.data.fdLlmConcurrencyCapEffective).toBe(32); // Python default
    expect(body.data.fdLlmConcurrencyCapSource).toBe('auto');
  });

  it('includes FD v3 diagnostics when env vars are set', async () => {
    process.env.FD_V3_ENABLED = 'true';
    process.env.FD_LARGE_LLM_PROVIDER = 'openrouter';
    process.env.FD_LARGE_LLM_MODEL = 'qwen/qwen3-coder-plus';

    mockFindUnique.mockResolvedValue(null);

    const res = await GET();
    const body = await jsonResponse(res);

    expect(body.data.fdV3Enabled).toBe(true);
    expect(body.data.fdLargeLlmProvider).toBe('openrouter');
    expect(body.data.fdLargeLlmModel).toBe('qwen/qwen3-coder-plus');
  });

  it('returns fdV3Enabled=false when env vars are absent', async () => {
    mockFindUnique.mockResolvedValue(null);

    const res = await GET();
    const body = await jsonResponse(res);

    expect(body.data.fdV3Enabled).toBe(false);
    expect(body.data.fdLargeLlmProvider).toBe('');
    expect(body.data.fdLargeLlmModel).toBe('');
  });

  it('returns concurrency from DB with source=db when set', async () => {
    mockFindUnique.mockResolvedValue({
      llmProvider: 'openrouter',
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'qwen2.5-coder:32b',
      openrouterApiKey: '',
      openrouterModel: 'qwen/qwen3-coder-next',
      openrouterInputPrice: 0.12,
      openrouterOutputPrice: 0.75,
      demoLiveMode: false,
      demoLiveChunkSize: 10,
      llmConcurrency: 20,
      fdLlmConcurrency: 15,
      fdLlmConcurrencyCap: 8,
    });

    const res = await GET();
    const body = await jsonResponse(res);

    expect(body.data.llmConcurrency).toBe(20);
    expect(body.data.llmConcurrencyEffective).toBe(20);
    expect(body.data.llmConcurrencySource).toBe('db');
    expect(body.data.fdLlmConcurrency).toBe(15);
    expect(body.data.fdLlmConcurrencySource).toBe('db');
    expect(body.data.fdLlmConcurrencyCap).toBe(8);
    expect(body.data.fdLlmConcurrencyCapSource).toBe('db');
  });

  it('returns concurrency source=env when env var set but DB is null', async () => {
    process.env.LLM_CONCURRENCY = '12';
    mockFindUnique.mockResolvedValue(null);

    const res = await GET();
    const body = await jsonResponse(res);

    expect(body.data.llmConcurrency).toBeNull();
    expect(body.data.llmConcurrencyEffective).toBe(12);
    expect(body.data.llmConcurrencySource).toBe('env');
    // FD inherits from LLM_CONCURRENCY when no FD-specific override
    expect(body.data.fdLlmConcurrencyEffective).toBe(12);
    // Cap defaults to Python default (32)
    expect(body.data.fdLlmConcurrencyCapEffective).toBe(32);

    delete process.env.LLM_CONCURRENCY;
  });

  it('includes FD v3 diagnostics with existing DB settings', async () => {
    process.env.FD_V3_ENABLED = '1';
    process.env.FD_LARGE_LLM_PROVIDER = 'openrouter';
    process.env.FD_LARGE_LLM_MODEL = 'qwen/qwen3-coder-plus';

    mockFindUnique.mockResolvedValue({
      llmProvider: 'openrouter',
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'qwen2.5-coder:32b',
      openrouterApiKey: 'sk-real-key',
      openrouterModel: 'qwen/qwen3-coder-next',
      openrouterProviderOrder: 'Chutes',
      openrouterProviderIgnore: 'Cloudflare',
      openrouterAllowFallbacks: true,
      openrouterRequireParameters: true,
      openrouterInputPrice: 0.12,
      openrouterOutputPrice: 0.75,
      demoLiveMode: false,
      demoLiveChunkSize: 10,
    });

    const res = await GET();
    const body = await jsonResponse(res);

    expect(body.data.fdV3Enabled).toBe(true);
    expect(body.data.fdLargeLlmModel).toBe('qwen/qwen3-coder-plus');
    // Editable fields from DB are preserved
    expect(body.data.openrouterModel).toBe('qwen/qwen3-coder-next');
  });
});

describe('PATCH /api/admin/llm-settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue({ user: adminUser });
    delete process.env.FD_V3_ENABLED;
    delete process.env.FD_LARGE_LLM_PROVIDER;
    delete process.env.FD_LARGE_LLM_MODEL;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LLM_CONCURRENCY;
    delete process.env.FD_LLM_CONCURRENCY;
    delete process.env.FD_LLM_CONCURRENCY_CAP;
  });

  it('does not persist FD v3 fields (Zod strips unknown keys)', async () => {
    const dbRecord = {
      llmProvider: 'openrouter',
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'qwen2.5-coder:32b',
      openrouterApiKey: 'sk-real-key',
      openrouterModel: 'qwen/qwen3-coder-next',
      openrouterProviderOrder: 'Chutes',
      openrouterProviderIgnore: 'Cloudflare',
      openrouterAllowFallbacks: true,
      openrouterRequireParameters: true,
      openrouterInputPrice: 0.12,
      openrouterOutputPrice: 0.75,
      demoLiveMode: false,
      demoLiveChunkSize: 10,
    };
    mockUpsert.mockResolvedValue(dbRecord);

    const req = new NextRequest('http://localhost/api/admin/llm-settings', {
      method: 'PATCH',
      body: JSON.stringify({
        openrouterModel: 'qwen/qwen3-coder-next',
        fdV3Enabled: true,
        fdLargeLlmProvider: 'openrouter',
        fdLargeLlmModel: 'should-not-persist',
      }),
    });

    const res = await PATCH(req);
    const body = await jsonResponse(res);

    expect(body.success).toBe(true);

    // Verify upsert was called and the data does NOT include fd* fields
    const upsertCall = mockUpsert.mock.calls[0][0];
    expect(upsertCall.update).not.toHaveProperty('fdV3Enabled');
    expect(upsertCall.update).not.toHaveProperty('fdLargeLlmProvider');
    expect(upsertCall.update).not.toHaveProperty('fdLargeLlmModel');
  });

  it('preserves masked API key handling', async () => {
    const dbRecord = {
      llmProvider: 'openrouter',
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'qwen2.5-coder:32b',
      openrouterApiKey: 'sk-original-key',
      openrouterModel: 'qwen/qwen3-coder-next',
      openrouterProviderOrder: 'Chutes',
      openrouterProviderIgnore: 'Cloudflare',
      openrouterAllowFallbacks: true,
      openrouterRequireParameters: true,
      openrouterInputPrice: 0.12,
      openrouterOutputPrice: 0.75,
      demoLiveMode: false,
      demoLiveChunkSize: 10,
    };
    mockUpsert.mockResolvedValue(dbRecord);

    const req = new NextRequest('http://localhost/api/admin/llm-settings', {
      method: 'PATCH',
      body: JSON.stringify({
        openrouterApiKey: '***',
        openrouterModel: 'qwen/qwen3-coder-next',
      }),
    });

    const res = await PATCH(req);
    expect(res.status).toBe(200);

    // Masked key should be stripped — not sent to DB
    const upsertCall = mockUpsert.mock.calls[0][0];
    expect(upsertCall.update).not.toHaveProperty('openrouterApiKey');
  });

  it('persists concurrency values via PATCH', async () => {
    const dbRecord = {
      llmProvider: 'openrouter',
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'qwen2.5-coder:32b',
      openrouterApiKey: 'sk-key',
      openrouterModel: 'qwen/qwen3-coder-next',
      openrouterProviderOrder: '',
      openrouterProviderIgnore: '',
      openrouterAllowFallbacks: true,
      openrouterRequireParameters: true,
      openrouterInputPrice: 0.12,
      openrouterOutputPrice: 0.75,
      demoLiveMode: false,
      demoLiveChunkSize: 10,
      llmConcurrency: 20,
      fdLlmConcurrency: null,
      fdLlmConcurrencyCap: null,
    };
    mockUpsert.mockResolvedValue(dbRecord);

    const req = new NextRequest('http://localhost/api/admin/llm-settings', {
      method: 'PATCH',
      body: JSON.stringify({ llmConcurrency: 20 }),
    });

    const res = await PATCH(req);
    const body = await jsonResponse(res);

    expect(body.success).toBe(true);
    expect(body.data.llmConcurrency).toBe(20);
    expect(body.data.llmConcurrencySource).toBe('db');

    const upsertCall = mockUpsert.mock.calls[0][0];
    expect(upsertCall.update.llmConcurrency).toBe(20);
  });

  it('resets concurrency to auto via PATCH with null', async () => {
    const dbRecord = {
      llmProvider: 'openrouter',
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'qwen2.5-coder:32b',
      openrouterApiKey: 'sk-key',
      openrouterModel: 'qwen/qwen3-coder-next',
      openrouterProviderOrder: '',
      openrouterProviderIgnore: '',
      openrouterAllowFallbacks: true,
      openrouterRequireParameters: true,
      openrouterInputPrice: 0.12,
      openrouterOutputPrice: 0.75,
      demoLiveMode: false,
      demoLiveChunkSize: 10,
      llmConcurrency: null,
      fdLlmConcurrency: null,
      fdLlmConcurrencyCap: null,
    };
    mockUpsert.mockResolvedValue(dbRecord);

    const req = new NextRequest('http://localhost/api/admin/llm-settings', {
      method: 'PATCH',
      body: JSON.stringify({ llmConcurrency: null }),
    });

    const res = await PATCH(req);
    const body = await jsonResponse(res);

    expect(body.success).toBe(true);
    expect(body.data.llmConcurrency).toBeNull();
    expect(body.data.llmConcurrencySource).toBe('auto');
  });

  it('allows partial PATCH update', async () => {
    const dbRecord = {
      llmProvider: 'openrouter',
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'qwen2.5-coder:32b',
      openrouterApiKey: 'sk-key',
      openrouterModel: 'new-model/test',
      openrouterProviderOrder: 'Chutes',
      openrouterProviderIgnore: 'Cloudflare',
      openrouterAllowFallbacks: true,
      openrouterRequireParameters: true,
      openrouterInputPrice: 0.5,
      openrouterOutputPrice: 1.0,
      demoLiveMode: false,
      demoLiveChunkSize: 10,
    };
    mockUpsert.mockResolvedValue(dbRecord);

    const req = new NextRequest('http://localhost/api/admin/llm-settings', {
      method: 'PATCH',
      body: JSON.stringify({
        openrouterModel: 'new-model/test',
      }),
    });

    const res = await PATCH(req);
    const body = await jsonResponse(res);

    expect(body.success).toBe(true);
    expect(body.data.openrouterModel).toBe('new-model/test');
  });
});
