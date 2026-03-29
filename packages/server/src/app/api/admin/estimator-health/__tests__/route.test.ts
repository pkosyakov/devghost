import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCommitAnalysisCount = vi.fn();
const mockCommitAnalysisFindMany = vi.fn();
const mockAnalysisJobCount = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    commitAnalysis: {
      count: (...args: unknown[]) => mockCommitAnalysisCount(...args),
      findMany: (...args: unknown[]) => mockCommitAnalysisFindMany(...args),
    },
    analysisJob: {
      count: (...args: unknown[]) => mockAnalysisJobCount(...args),
    },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN' } }),
  isErrorResponse: vi.fn((value: unknown) => value instanceof Response),
  apiResponse: vi.fn((data: unknown) =>
    new Response(JSON.stringify({ success: true, data }), { status: 200 })),
}));

import { GET } from '../route';

describe('GET /api/admin/estimator-health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns pass/warn/fail metrics and suspicious samples', async () => {
    mockCommitAnalysisCount
      .mockResolvedValueOnce(100) // recentCommitCount
      .mockResolvedValueOnce(2)   // fallbackCount
      .mockResolvedValueOnce(10)  // fdTotalCount
      .mockResolvedValueOnce(8)   // fdV3HolisticCount
      .mockResolvedValueOnce(1)   // fdV3NonHolisticCount
      .mockResolvedValueOnce(1)   // heuristicAttributedCount
      .mockResolvedValueOnce(1)   // specialMethodAttributedCount
      .mockResolvedValueOnce(1);  // largeModelMissingCount

    mockAnalysisJobCount
      .mockResolvedValueOnce(5)   // recentModalJobCount
      .mockResolvedValueOnce(1)   // failedModalJobsCount
      .mockResolvedValueOnce(0)   // stalePendingJobsCount
      .mockResolvedValueOnce(1)   // staleRunningJobsCount
      .mockResolvedValueOnce(0);  // stalledPostProcessingJobsCount

    mockCommitAnalysisFindMany.mockResolvedValue([
      {
        commitHash: 'abcdef12',
        method: 'FD_v3_holistic',
        llmModel: null,
        repository: 'owner/repo',
        analyzedAt: new Date('2026-03-29T09:00:00.000Z'),
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.fallbackRate.status).toBe('warn');
    expect(body.data.fallbackRate.percent).toBe(2);
    expect(body.data.fdV3Share.status).toBe('warn');
    expect(body.data.fdV3Share.percent).toBe(80);
    expect(body.data.fdV3Share.fdV3HolisticCount).toBe(8);
    expect(body.data.fdV3Share.fdV3NonHolisticCount).toBe(1);
    expect(body.data.modalJobs.status).toBe('warn');
    expect(body.data.modalJobs.recentModalJobCount).toBe(5);
    expect(body.data.modalJobs.totalIssues).toBe(2);
    expect(body.data.attribution.status).toBe('fail');
    expect(body.data.attribution.suspiciousCount).toBe(3);
    expect(body.data.attribution.samples[0]).toMatchObject({
      sha: 'abcdef12',
      method: 'FD_v3_holistic',
      llmModel: null,
    });
    expect(body.data.overallStatus).toBe('fail');
  });

  it('returns na for empty 24h windows', async () => {
    mockCommitAnalysisCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    mockAnalysisJobCount
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    mockCommitAnalysisFindMany.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();

    expect(body.data.fallbackRate.status).toBe('na');
    expect(body.data.fdV3Share.status).toBe('na');
    expect(body.data.modalJobs.status).toBe('na');
    expect(body.data.attribution.status).toBe('na');
    expect(body.data.overallStatus).toBe('na');
  });

  it('counts failed and llm-complete stalls but ignores stale jobs outside the 24h window', async () => {
    mockCommitAnalysisCount
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    mockAnalysisJobCount
      .mockResolvedValueOnce(3) // recentModalJobCount
      .mockResolvedValueOnce(1) // failed incl. FAILED
      .mockResolvedValueOnce(0) // stalePending in-window
      .mockResolvedValueOnce(0) // staleRunning in-window
      .mockResolvedValueOnce(1); // stalledPostProcessingJobsCount

    mockCommitAnalysisFindMany.mockResolvedValue([]);

    const res = await GET();
    const body = await res.json();

    expect(body.data.modalJobs.status).toBe('warn');
    expect(body.data.modalJobs.failedCount).toBe(1);
    expect(body.data.modalJobs.stalledPostProcessingCount).toBe(1);
    expect(body.data.modalJobs.totalIssues).toBe(2);
  });
});
