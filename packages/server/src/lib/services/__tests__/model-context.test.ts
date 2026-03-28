import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { analysisLogger: mockLogger, logger: mockLogger, default: mockLogger };
});

import {
  clampContext,
  computeEffectiveContext,
  resolveModelContext,
  resolveEffectiveContext,
  configFromSnapshot,
  DEFAULT_CTX,
  MIN_CONTEXT,
  MAX_CONTEXT,
} from '../model-context';
import type { LlmConfig } from '@/lib/llm-config';

const baseConfig: LlmConfig = {
  provider: 'ollama',
  ollama: { url: 'http://localhost:11434', model: 'qwen3-coder-next' },
  openrouter: {
    apiKey: 'sk-test',
    model: 'qwen/qwen3-coder-next',
    inputPrice: 0.03,
    outputPrice: 0.11,
    providerOrder: [],
    providerIgnore: [],
    allowFallbacks: true,
    requireParameters: true,
  },
};

describe('clampContext', () => {
  it('returns value within bounds', () => {
    expect(clampContext(65536)).toBe(65536);
  });

  it('clamps below MIN_CONTEXT', () => {
    expect(clampContext(1000)).toBe(MIN_CONTEXT);
  });

  it('clamps above MAX_CONTEXT', () => {
    expect(clampContext(500000)).toBe(MAX_CONTEXT);
  });

  it('handles edge values', () => {
    expect(clampContext(MIN_CONTEXT)).toBe(MIN_CONTEXT);
    expect(clampContext(MAX_CONTEXT)).toBe(MAX_CONTEXT);
  });
});

describe('computeEffectiveContext', () => {
  it('applies 0.75x factor for openrouter', () => {
    // 131072 * 0.75 = 98304
    expect(computeEffectiveContext(131072, 'openrouter')).toBe(98304);
  });

  it('uses raw value for ollama', () => {
    expect(computeEffectiveContext(131072, 'ollama')).toBe(131072);
  });

  it('clamps result after applying factor', () => {
    // 5000 * 0.75 = 3750 → clamped to MIN_CONTEXT
    expect(computeEffectiveContext(5000, 'openrouter')).toBe(MIN_CONTEXT);
  });
});

describe('resolveModelContext', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves Ollama context from /api/show', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        model_info: {
          'llama.context_length': 131072,
          'llama.embedding_length': 5120,
        },
      }),
    });

    const result = await resolveModelContext({
      ...baseConfig,
      provider: 'ollama',
    });

    expect(result).toBe(131072);
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:11434/api/show',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns null for Ollama when /api/show fails', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404 });

    const result = await resolveModelContext({
      ...baseConfig,
      provider: 'ollama',
    });

    expect(result).toBeNull();
  });

  it('returns null for Ollama when context_length not in model_info', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ model_info: { 'llama.embedding_length': 5120 } }),
    });

    const result = await resolveModelContext({
      ...baseConfig,
      provider: 'ollama',
    });

    expect(result).toBeNull();
  });

  it('resolves OpenRouter context from catalog', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { id: 'qwen/qwen3-coder-next', context_length: 65536 },
          { id: 'other/model', context_length: 8192 },
        ],
      }),
    });

    const result = await resolveModelContext({
      ...baseConfig,
      provider: 'openrouter',
    });

    expect(result).toBe(65536);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer sk-test' },
      }),
    );
  });

  it('returns null for OpenRouter when model not in catalog', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [{ id: 'other/model', context_length: 8192 }],
      }),
    });

    const result = await resolveModelContext({
      ...baseConfig,
      provider: 'openrouter',
    });

    expect(result).toBeNull();
  });

  it('returns null for OpenRouter when API fails', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401 });

    const result = await resolveModelContext({
      ...baseConfig,
      provider: 'openrouter',
    });

    expect(result).toBeNull();
  });

  it('returns null for OpenRouter when no API key', async () => {
    const result = await resolveModelContext({
      ...baseConfig,
      provider: 'openrouter',
      openrouter: { ...baseConfig.openrouter, apiKey: '' },
    });

    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await resolveModelContext({
      ...baseConfig,
      provider: 'ollama',
    });

    expect(result).toBeNull();
  });
});

describe('resolveEffectiveContext', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns raw and effective context for Ollama', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        model_info: { 'llama.context_length': 131072 },
      }),
    });

    const result = await resolveEffectiveContext({
      ...baseConfig,
      provider: 'ollama',
    });

    expect(result.rawContextLength).toBe(131072);
    expect(result.effectiveContextLength).toBe(131072); // no factor for ollama
  });

  it('applies OpenRouter safety factor', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [{ id: 'qwen/qwen3-coder-next', context_length: 131072 }],
      }),
    });

    const result = await resolveEffectiveContext({
      ...baseConfig,
      provider: 'openrouter',
    });

    expect(result.rawContextLength).toBe(131072);
    expect(result.effectiveContextLength).toBe(Math.floor(131072 * 0.75)); // 98304
  });

  it('falls back to DEFAULT_CTX on resolution failure', async () => {
    fetchSpy.mockRejectedValue(new Error('network error'));

    const result = await resolveEffectiveContext({
      ...baseConfig,
      provider: 'ollama',
    });

    expect(result.rawContextLength).toBe(DEFAULT_CTX);
    expect(result.effectiveContextLength).toBe(DEFAULT_CTX); // no factor for ollama, 32768 unchanged
  });
});

describe('configFromSnapshot', () => {
  it('reconstructs LlmConfig for openrouter snapshot', () => {
    const snapshot = {
      provider: 'openrouter',
      ollama: { url: 'http://localhost:11434', model: 'qwen2.5-coder:32b' },
      openrouter: { model: 'qwen/qwen3-coder-next', apiKey: '[REDACTED]' },
    };
    const config = configFromSnapshot(snapshot);
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('openrouter');
    expect(config!.openrouter.model).toBe('qwen/qwen3-coder-next');
  });

  it('reconstructs LlmConfig for ollama snapshot', () => {
    const snapshot = {
      provider: 'ollama',
      ollama: { url: 'http://myhost:11434', model: 'qwen3-coder-next' },
      openrouter: {},
    };
    const config = configFromSnapshot(snapshot);
    expect(config).not.toBeNull();
    expect(config!.provider).toBe('ollama');
    expect(config!.ollama.model).toBe('qwen3-coder-next');
    expect(config!.ollama.url).toBe('http://myhost:11434');
  });

  it('returns null for invalid provider', () => {
    expect(configFromSnapshot({ provider: 'gemini' })).toBeNull();
    expect(configFromSnapshot({})).toBeNull();
  });

  it('returns null when model is missing', () => {
    expect(configFromSnapshot({ provider: 'openrouter', openrouter: {} })).toBeNull();
    expect(configFromSnapshot({ provider: 'ollama', ollama: {} })).toBeNull();
  });
});
