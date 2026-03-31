import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOrderFindFirst = vi.fn();
const mockOrderMetricFindMany = vi.fn();
const mockCommitAnalysisCount = vi.fn();
const mockCommitAnalysisFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    order: { findFirst: (...args: unknown[]) => mockOrderFindFirst(...args) },
    orderMetric: { findMany: (...args: unknown[]) => mockOrderMetricFindMany(...args) },
    commitAnalysis: {
      count: (...args: unknown[]) => mockCommitAnalysisCount(...args),
      findMany: (...args: unknown[]) => mockCommitAnalysisFindMany(...args),
    },
  },
}));

import { getLatestCompletedAnalysis } from '../home-service';

describe('getLatestCompletedAnalysis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no completed order exists', async () => {
    mockOrderFindFirst.mockResolvedValue(null);
    const result = await getLatestCompletedAnalysis('user-1');
    expect(result).toBeNull();
    expect(mockOrderFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', status: 'COMPLETED' },
        orderBy: { completedAt: 'desc' },
      })
    );
  });

  it('returns completed-result counts (not raw extraction-era counts)', async () => {
    mockOrderFindFirst.mockResolvedValue({
      id: 'order-1',
      name: 'My Analysis',
      completedAt: new Date('2026-03-15T10:00:00Z'),
    });
    mockOrderMetricFindMany.mockResolvedValue([
      { developerEmail: 'a@test.com' },
      { developerEmail: 'b@test.com' },
      { developerEmail: 'a@test.com' },
    ]);
    mockCommitAnalysisCount.mockResolvedValue(95);
    mockCommitAnalysisFindMany.mockResolvedValue([
      { repository: 'org/repo1' },
      { repository: 'org/repo2' },
    ]);

    const result = await getLatestCompletedAnalysis('user-1');

    expect(result).toEqual({
      id: 'order-1',
      name: 'My Analysis',
      completedAt: new Date('2026-03-15T10:00:00Z').toISOString(),
      repoCount: 2,
      contributorCount: 2,
      commitCount: 95,
    });

    // Verify commit/repo queries exclude benchmark rows (jobId: null)
    expect(mockCommitAnalysisCount).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 'order-1', jobId: null } })
    );
    expect(mockCommitAnalysisFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: 'order-1', jobId: null } })
    );
  });
});
