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

vi.mock('@/lib/auth', () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
}));

import { GET } from '../route';

describe('GET /api/orders/[id]/benchmark/compare', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes fdV3 fields in benchmark run', async () => {
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
          effectiveContextLength: 32768,
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

    // Benchmark run has FD v3 fields
    const benchRun = body.runs.find((r: any) => r.jobId === 'job-bench');
    expect(benchRun.fdV3Enabled).toBe(true);
    expect(benchRun.fdLargeModel).toBe('qwen/qwen3-coder-plus');
    expect(benchRun.fdLargeProvider).toBe('openrouter');

    // Original run does not
    const origRun = body.runs.find((r: any) => r.jobId === null);
    expect(origRun.fdV3Enabled).toBe(false);

    // Per-commit models are exposed
    const bigCommit = body.commits.find((c: any) => c.sha === 'def');
    expect(bigCommit.models['job-bench']).toBe('qwen/qwen3-coder-plus');
    expect(bigCommit.models['original']).toBeUndefined(); // old FD had null model
  });
});
