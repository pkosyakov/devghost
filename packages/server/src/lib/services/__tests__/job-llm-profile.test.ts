import { afterEach, describe, expect, it } from 'vitest';
import type { LlmConfig } from '@/lib/llm-config';
import {
  buildAnalysisJobLlmProfileFromConfig,
  buildAnalysisJobLlmProfileFromSnapshot,
  withSplitModelSnapshot,
} from '@/lib/services/job-llm-profile';

const ENV_KEYS = ['FD_V3_ENABLED', 'FD_LARGE_LLM_PROVIDER', 'FD_LARGE_LLM_MODEL'] as const;

function setFdEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  setFdEnv({});
});

describe('job-llm-profile', () => {
  it('builds split profile from llm config plus env-backed large path', () => {
    setFdEnv({
      FD_V3_ENABLED: 'true',
      FD_LARGE_LLM_PROVIDER: 'openrouter',
      FD_LARGE_LLM_MODEL: 'qwen/qwen3-coder-plus',
    });

    const config: LlmConfig = {
      provider: 'openrouter',
      ollama: { url: 'http://localhost:11434', model: 'qwen2.5-coder:32b' },
      openrouter: {
        apiKey: 'secret',
        model: 'qwen/qwen3-coder-next',
        inputPrice: 0.12,
        outputPrice: 0.75,
        providerOrder: [],
        providerIgnore: [],
        allowFallbacks: true,
        requireParameters: true,
      },
    };

    expect(buildAnalysisJobLlmProfileFromConfig(config)).toEqual({
      llmProvider: 'openrouter',
      llmModel: 'qwen/qwen3-coder-next',
      smallLlmProvider: 'openrouter',
      smallLlmModel: 'qwen/qwen3-coder-next',
      largeLlmProvider: 'openrouter',
      largeLlmModel: 'qwen/qwen3-coder-plus',
      fdV3Enabled: true,
    });
  });

  it('prefers snapshot split fields when present', () => {
    setFdEnv({
      FD_V3_ENABLED: 'false',
      FD_LARGE_LLM_PROVIDER: 'ollama',
      FD_LARGE_LLM_MODEL: 'stale-model',
    });

    expect(buildAnalysisJobLlmProfileFromSnapshot({
      provider: 'openrouter',
      openrouter: { model: 'qwen/qwen3-coder-next' },
      fdV3Enabled: true,
      fdLargeProvider: 'openrouter',
      fdLargeModel: 'qwen/qwen3-coder-plus',
    })).toEqual({
      llmProvider: 'openrouter',
      llmModel: 'qwen/qwen3-coder-next',
      smallLlmProvider: 'openrouter',
      smallLlmModel: 'qwen/qwen3-coder-next',
      largeLlmProvider: 'openrouter',
      largeLlmModel: 'qwen/qwen3-coder-plus',
      fdV3Enabled: true,
    });
  });

  it('stamps split-model env into snapshot without clobbering explicit fields', () => {
    setFdEnv({
      FD_V3_ENABLED: 'true',
      FD_LARGE_LLM_PROVIDER: 'openrouter',
      FD_LARGE_LLM_MODEL: 'qwen/qwen3-coder-plus',
    });

    expect(withSplitModelSnapshot({
      provider: 'openrouter',
      openrouter: { model: 'qwen/qwen3-coder-next' },
      fdLargeModel: 'custom-large',
    })).toEqual({
      provider: 'openrouter',
      openrouter: { model: 'qwen/qwen3-coder-next' },
      fdV3Enabled: true,
      fdLargeProvider: 'openrouter',
      fdLargeModel: 'custom-large',
    });
  });
});
