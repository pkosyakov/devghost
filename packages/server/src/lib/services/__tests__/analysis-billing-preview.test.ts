import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    $queryRaw: vi.fn(),
    commitAnalysis: { count: vi.fn() },
  },
}));
vi.mock('@/lib/llm-config', () => ({ getLlmConfig: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  billingLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import prisma from '@/lib/db';
import { getLlmConfig } from '@/lib/llm-config';
import {
  computeBillingPreview,
  type BillingPreviewInput,
  type BillingPreviewScope,
} from '../analysis-billing-preview';

const mockedPrisma = vi.mocked(prisma, true);
const mockedGetLlmConfig = vi.mocked(getLlmConfig);

function makeScope(overrides: Partial<BillingPreviewScope> = {}): BillingPreviewScope {
  return {
    mode: 'ALL_TIME',
    years: [],
    startDate: null,
    endDate: null,
    commitLimit: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<BillingPreviewInput> = {}): BillingPreviewInput {
  return {
    userId: 'user-1',
    orderId: 'order-1',
    selectedRepos: [{ fullName: 'owner/repo' }],
    selectedDevelopers: [
      { email: 'dev@example.com', commitCount: 10 },
    ],
    excludedEmails: [],
    cacheMode: 'any',
    scope: makeScope(),
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────
// First-run path (no CommitAnalysis rows for this order)
// ────────────────────────────────────────────────────────────
describe('computeBillingPreview — first-run path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No CA rows for this order → first-run
    mockedPrisma.commitAnalysis.count.mockResolvedValue(0);
    // Default: cross-order cache returns 0
    mockedPrisma.$queryRaw.mockResolvedValue([{ count: 0 }]);
    // Default LLM config
    mockedGetLlmConfig.mockResolvedValue({
      provider: 'openrouter',
      ollama: { url: 'http://localhost:11434', model: 'qwen2.5-coder:32b' },
      openrouter: {
        apiKey: 'key',
        model: 'qwen/qwen3-coder-next',
        inputPrice: 0.12,
        outputPrice: 0.75,
        providerOrder: [],
        providerIgnore: [],
        allowFallbacks: true,
        requireParameters: true,
      },
    });
  });

  it('sums selectedDevelopers.commitCount, zero cache -> total = sum, billable = sum', async () => {
    const input = makeInput({
      selectedDevelopers: [
        { email: 'a@x.com', commitCount: 5 },
        { email: 'b@x.com', commitCount: 8 },
      ],
    });

    const result = await computeBillingPreview(input);

    expect(result.isFirstRunEstimate).toBe(true);
    expect(result.totalScopedCommits).toBe(13);
    expect(result.reusableCachedCommits).toBe(0);
    expect(result.billableCommits).toBe(13);
    expect(result.estimatedCredits).toBe(13);
  });

  it('subtracts cross-order cache from total', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{ count: 3 }]);
    const input = makeInput({
      selectedDevelopers: [{ email: 'a@x.com', commitCount: 10 }],
    });

    const result = await computeBillingPreview(input);

    expect(result.totalScopedCommits).toBe(10);
    expect(result.reusableCachedCommits).toBe(3);
    expect(result.billableCommits).toBe(7);
    expect(result.estimatedCredits).toBe(7);
  });

  it('shows zero billable when cross-order cache covers all commits', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{ count: 15 }]);
    const input = makeInput({
      selectedDevelopers: [{ email: 'a@x.com', commitCount: 10 }],
    });

    const result = await computeBillingPreview(input);

    expect(result.totalScopedCommits).toBe(10);
    // Cache is capped at total
    expect(result.reusableCachedCommits).toBe(10);
    expect(result.billableCommits).toBe(0);
    expect(result.estimatedCredits).toBe(0);
  });

  it('excludes specified emails', async () => {
    const input = makeInput({
      selectedDevelopers: [
        { email: 'keep@x.com', commitCount: 5 },
        { email: 'drop@x.com', commitCount: 8 },
      ],
      excludedEmails: ['drop@x.com'],
    });

    const result = await computeBillingPreview(input);

    expect(result.totalScopedCommits).toBe(5);
  });

  it('handles legacy commit_count field', async () => {
    const input = makeInput({
      selectedDevelopers: [
        { email: 'a@x.com', commit_count: 7 },
      ],
    });

    const result = await computeBillingPreview(input);

    expect(result.totalScopedCommits).toBe(7);
  });

  it('filters out blank-email rows', async () => {
    const input = makeInput({
      selectedDevelopers: [
        { email: 'a@x.com', commitCount: 5 },
        { email: '', commitCount: 3 },
        { commitCount: 2 },
        { email: '  ', commitCount: 4 },
      ],
    });

    const result = await computeBillingPreview(input);

    expect(result.totalScopedCommits).toBe(5);
  });

  it('caps at commitLimit for LAST_N_COMMITS', async () => {
    const input = makeInput({
      selectedDevelopers: [
        { email: 'a@x.com', commitCount: 50 },
        { email: 'b@x.com', commitCount: 30 },
      ],
      scope: makeScope({ mode: 'LAST_N_COMMITS', commitLimit: 20 }),
    });

    const result = await computeBillingPreview(input);

    expect(result.totalScopedCommits).toBe(20);
  });

  it('returns zero cache when cacheMode is off', async () => {
    const input = makeInput({
      cacheMode: 'off',
      selectedDevelopers: [{ email: 'a@x.com', commitCount: 10 }],
    });

    const result = await computeBillingPreview(input);

    expect(result.reusableCachedCommits).toBe(0);
    expect(result.billableCommits).toBe(10);
    // $queryRaw should NOT be called for cross-order cache when cacheMode is off
    expect(mockedPrisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns zero for empty selectedDevelopers', async () => {
    const input = makeInput({ selectedDevelopers: [] });

    const result = await computeBillingPreview(input);

    expect(result.totalScopedCommits).toBe(0);
    expect(result.billableCommits).toBe(0);
    expect(result.estimatedCredits).toBe(0);
  });

  it('returns zero for empty repos', async () => {
    const input = makeInput({ selectedRepos: [] });

    const result = await computeBillingPreview(input);

    expect(result.totalScopedCommits).toBe(0);
    expect(result.billableCommits).toBe(0);
  });

  it('DATE_RANGE does NOT narrow first-run total (known limitation)', async () => {
    const input = makeInput({
      selectedDevelopers: [{ email: 'a@x.com', commitCount: 30 }],
      scope: makeScope({
        mode: 'DATE_RANGE',
        startDate: new Date('2025-01-01'),
        endDate: new Date('2025-06-30'),
      }),
    });

    const result = await computeBillingPreview(input);

    // First-run cannot narrow by date — uses flat aggregate
    expect(result.totalScopedCommits).toBe(30);
    expect(result.isFirstRunEstimate).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// Re-run path (CommitAnalysis rows exist for this order)
// ────────────────────────────────────────────────────────────
describe('computeBillingPreview — re-run path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // CA rows exist → re-run path
    mockedPrisma.commitAnalysis.count.mockResolvedValue(42);
    // Default LLM config
    mockedGetLlmConfig.mockResolvedValue({
      provider: 'openrouter',
      ollama: { url: 'http://localhost:11434', model: 'qwen2.5-coder:32b' },
      openrouter: {
        apiKey: 'key',
        model: 'qwen/qwen3-coder-next',
        inputPrice: 0.12,
        outputPrice: 0.75,
        providerOrder: [],
        providerIgnore: [],
        allowFallbacks: true,
        requireParameters: true,
      },
    });
  });

  it('billable = total - cached for normal run', async () => {
    // Re-run query returns: total 20, cached 8
    mockedPrisma.$queryRaw.mockResolvedValue([{
      total: 20,
      cached: 8,
    }]);

    const input = makeInput();

    const result = await computeBillingPreview(input);

    expect(result.isFirstRunEstimate).toBe(false);
    expect(result.totalScopedCommits).toBe(20);
    expect(result.reusableCachedCommits).toBe(8);
    expect(result.billableCommits).toBe(12);
    expect(result.estimatedCredits).toBe(12);
  });

  it('zero billable when fully cached', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{
      total: 15,
      cached: 15,
    }]);

    const result = await computeBillingPreview(makeInput());

    expect(result.billableCommits).toBe(0);
    expect(result.estimatedCredits).toBe(0);
  });

  it('zero cached when cacheMode is off', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{
      total: 10,
      cached: 0,
    }]);

    const input = makeInput({ cacheMode: 'off' });

    const result = await computeBillingPreview(input);

    expect(result.reusableCachedCommits).toBe(0);
    expect(result.billableCommits).toBe(10);
  });

  it('no negative billable (cached > total edge case)', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{
      total: 5,
      cached: 12,
    }]);

    const result = await computeBillingPreview(makeInput());

    expect(result.billableCommits).toBe(0);
    expect(result.estimatedCredits).toBe(0);
  });

  it('handles legacy repos with full_name', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{
      total: 10,
      cached: 2,
    }]);

    const input = makeInput({
      selectedRepos: [{ full_name: 'legacy/repo' }],
    });

    const result = await computeBillingPreview(input);

    expect(result.isFirstRunEstimate).toBe(false);
    expect(result.totalScopedCommits).toBe(10);
    expect(result.billableCommits).toBe(8);
  });
});
