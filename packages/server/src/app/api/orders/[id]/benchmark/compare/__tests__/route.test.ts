import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockOrderFindFirst = vi.fn();
const mockJobFindMany = vi.fn();
const mockCommitFindMany = vi.fn();
const mockGtFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    order: { findFirst: (...a: unknown[]) => mockOrderFindFirst(...a) },
    analysisJob: { findMany: (...a: unknown[]) => mockJobFindMany(...a) },
    commitAnalysis: { findMany: (...a: unknown[]) => mockCommitFindMany(...a) },
    groundTruth: { findMany: (...a: unknown[]) => mockGtFindMany(...a) },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'test@test.com', role: 'ADMIN' } }),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
}));

import { GET } from '../route';

describe('GET /api/orders/[id]/benchmark/compare', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes benchmarkProfile fields for profile-based runs', async () => {
    mockOrderFindFirst.mockResolvedValue({ id: 'order-1' });
    mockJobFindMany.mockResolvedValue([
      {
        id: 'job-analysis', type: 'analysis', status: 'COMPLETED',
        llmProvider: 'openrouter', llmModel: 'old-model', createdAt: new Date(),
        totalCostUsd: null, llmConfigFingerprint: 'fp1', llmConfigSnapshot: {},
      },
      {
        id: 'job-bench', type: 'benchmark', status: 'COMPLETED',
        llmProvider: 'openrouter', llmModel: 'qwen/qwen3-coder-next', createdAt: new Date(),
        totalCostUsd: null, llmConfigFingerprint: 'fp2',
        llmConfigSnapshot: {
          fdV3Enabled: true,
          fdLargeModel: 'qwen/qwen3-coder-plus',
          fdLargeProvider: 'openrouter',
          effectiveContextLength: 196608,
          benchmarkProfile: 'target_rollout',
          benchmarkProfileLabel: 'Full Rollout Candidate',
        },
      },
    ]);
    mockCommitFindMany.mockResolvedValue([
      { commitHash: 'abc', commitMessage: 'test', repository: 'repo', additions: 10, deletions: 5, filesCount: 2, effortHours: 1.0, jobId: null, method: 'llm_v16', llmModel: 'old-model' },
      { commitHash: 'abc', commitMessage: 'test', repository: 'repo', additions: 10, deletions: 5, filesCount: 2, effortHours: 1.5, jobId: 'job-bench', method: 'llm_v16', llmModel: 'qwen/qwen3-coder-next' },
      { commitHash: 'def', commitMessage: 'big', repository: 'repo', additions: 500, deletions: 100, filesCount: 80, effortHours: 5.0, jobId: null, method: 'FD_fallback', llmModel: null },
      { commitHash: 'def', commitMessage: 'big', repository: 'repo', additions: 500, deletions: 100, filesCount: 80, effortHours: 8.0, jobId: 'job-bench', method: 'FD_v3_holistic', llmModel: 'qwen/qwen3-coder-plus' },
    ]);
    mockGtFindMany.mockResolvedValue([]);

    const req = new NextRequest(new URL('http://localhost/api/orders/order-1/benchmark/compare'));
    const res = await GET(req, { params: Promise.resolve({ id: 'order-1' }) });
    const body = await res.json();

    // Benchmark run has profile metadata
    const benchRun = body.runs.find((r: any) => r.jobId === 'job-bench');
    expect(benchRun.benchmarkProfile).toBe('target_rollout');
    expect(benchRun.benchmarkProfileLabel).toBe('Full Rollout Candidate');
    expect(benchRun.fdV3Enabled).toBe(true);
    expect(benchRun.fdLargeModel).toBe('qwen/qwen3-coder-plus');
    expect(benchRun.fdLargeProvider).toBe('openrouter');

    // Original run has null profile metadata
    const origRun = body.runs.find((r: any) => r.jobId === null);
    expect(origRun.benchmarkProfile).toBeNull();
    expect(origRun.benchmarkProfileLabel).toBeNull();
    expect(origRun.fdV3Enabled).toBe(false);

    // Per-commit models are exposed
    const bigCommit = body.commits.find((c: any) => c.sha === 'def');
    expect(bigCommit.models['job-bench']).toBe('qwen/qwen3-coder-plus');
  });

  it('handles old benchmark runs without profile metadata gracefully', async () => {
    mockOrderFindFirst.mockResolvedValue({ id: 'order-1' });
    mockJobFindMany.mockResolvedValue([
      {
        id: 'job-analysis', type: 'analysis', status: 'COMPLETED',
        llmProvider: 'openrouter', llmModel: 'old-model', createdAt: new Date(),
        totalCostUsd: null, llmConfigFingerprint: 'fp1', llmConfigSnapshot: {},
      },
      {
        id: 'job-legacy', type: 'benchmark', status: 'COMPLETED',
        llmProvider: 'openrouter', llmModel: 'some-model', createdAt: new Date(),
        totalCostUsd: null, llmConfigFingerprint: 'fp-legacy',
        // Old snapshot without benchmarkProfile fields
        llmConfigSnapshot: {
          effectiveContextLength: 32768,
          promptRepeat: false,
        },
      },
    ]);
    mockCommitFindMany.mockResolvedValue([
      { commitHash: 'abc', commitMessage: 'test', repository: 'repo', additions: 10, deletions: 5, filesCount: 2, effortHours: 1.0, jobId: null, method: 'llm_v16', llmModel: 'old-model' },
      { commitHash: 'abc', commitMessage: 'test', repository: 'repo', additions: 10, deletions: 5, filesCount: 2, effortHours: 2.0, jobId: 'job-legacy', method: 'llm_v16', llmModel: 'some-model' },
    ]);
    mockGtFindMany.mockResolvedValue([]);

    const req = new NextRequest(new URL('http://localhost/api/orders/order-1/benchmark/compare'));
    const res = await GET(req, { params: Promise.resolve({ id: 'order-1' }) });
    const body = await res.json();

    const legacyRun = body.runs.find((r: any) => r.jobId === 'job-legacy');
    expect(legacyRun.benchmarkProfile).toBeNull();
    expect(legacyRun.benchmarkProfileLabel).toBeNull();
    expect(legacyRun.fdV3Enabled).toBe(false);
    expect(legacyRun.fdLargeModel).toBeNull();
  });
});
