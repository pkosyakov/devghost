import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Prisma mock ---
const mockOrderFindFirst = vi.fn();
const mockOrderMetricFindMany = vi.fn();
const mockOrderMetricUpdate = vi.fn();
const mockDailyEffortFindMany = vi.fn();
const mockCommitAnalysisFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    order: { findFirst: (...a: unknown[]) => mockOrderFindFirst(...a) },
    orderMetric: {
      findMany: (...a: unknown[]) => mockOrderMetricFindMany(...a),
      update: (...a: unknown[]) => mockOrderMetricUpdate(...a),
    },
    dailyEffort: { findMany: (...a: unknown[]) => mockDailyEffortFindMany(...a) },
    commitAnalysis: { findMany: (...a: unknown[]) => mockCommitAnalysisFindMany(...a) },
  },
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => ({ info: noop, warn: noop, error: noop, debug: noop, child });
  return {
    analysisLogger: { child },
  };
});

import { getGhostMetricsService } from '@/lib/services/ghost-metrics-service';

function makeMetricRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'metric-1',
    orderId: 'order-1',
    developerEmail: 'dev@test.com',
    developerName: 'Dev',
    periodType: 'ALL_TIME',
    year: null,
    month: null,
    commitCount: 5,
    workDays: 3,
    totalEffortHours: 15,
    avgDailyEffort: 5.0,
    ghostPercentRaw: 166.67,
    ghostPercent: 166.67,
    share: 1.0,
    shareAutoCalculated: true,
    fteWorkDays: 0,
    fteAvgDailyEffort: 0,
    fteGhostPercentRaw: null,
    fteGhostPercent: null,
    ...overrides,
  };
}

describe('GhostMetricsService.recalculateFteForOrder', () => {
  const service = getGhostMetricsService();

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: order with ALL_TIME scope
    mockOrderFindFirst.mockResolvedValue({
      analysisPeriodMode: 'ALL_TIME',
      analysisYears: null,
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
    });
  });

  it('updates FTE fields for a single developer ALL_TIME metric', async () => {
    // 5 commits across Mon-Fri week, daily effort on 3 of those days
    const commits = [
      { commitHash: 'a1', authorEmail: 'dev@test.com', authorName: 'Dev', authorDate: new Date('2026-03-02'), effortHours: 5 },
      { commitHash: 'a2', authorEmail: 'dev@test.com', authorName: 'Dev', authorDate: new Date('2026-03-03'), effortHours: 4 },
      { commitHash: 'a3', authorEmail: 'dev@test.com', authorName: 'Dev', authorDate: new Date('2026-03-04'), effortHours: 3 },
      { commitHash: 'a4', authorEmail: 'dev@test.com', authorName: 'Dev', authorDate: new Date('2026-03-05'), effortHours: 2 },
      { commitHash: 'a5', authorEmail: 'dev@test.com', authorName: 'Dev', authorDate: new Date('2026-03-06'), effortHours: 1 },
    ];
    mockCommitAnalysisFindMany.mockResolvedValue(commits);

    // Daily effort on Mon, Wed, Fri (3 days spread)
    mockDailyEffortFindMany.mockResolvedValue([
      { developerEmail: 'dev@test.com', date: new Date('2026-03-02') },
      { developerEmail: 'dev@test.com', date: new Date('2026-03-04') },
      { developerEmail: 'dev@test.com', date: new Date('2026-03-06') },
    ]);

    mockOrderMetricFindMany.mockResolvedValue([makeMetricRow()]);
    mockOrderMetricUpdate.mockResolvedValue({});

    const updated = await service.recalculateFteForOrder('order-1', 'user-1');

    expect(updated).toBe(1);
    expect(mockOrderMetricUpdate).toHaveBeenCalledOnce();

    const updateCall = mockOrderMetricUpdate.mock.calls[0][0];
    expect(updateCall.where.id).toBe('metric-1');
    // Period Mon Mar 2 to Fri Mar 6 = 5 weekdays
    expect(updateCall.data.fteWorkDays).toBe(5);
    // avgDaily = 15 / 5 = 3.0
    expect(updateCall.data.fteAvgDailyEffort).toBe(3);
    // fteGhostPercentRaw and fteGhostPercent should be numbers (not null)
    expect(updateCall.data.fteGhostPercentRaw).toBeTypeOf('number');
    expect(updateCall.data.fteGhostPercent).toBeTypeOf('number');
  });

  it('skips metrics with no matching commits or daily effort', async () => {
    mockCommitAnalysisFindMany.mockResolvedValue([]);
    mockDailyEffortFindMany.mockResolvedValue([]);
    mockOrderMetricFindMany.mockResolvedValue([makeMetricRow()]);

    const updated = await service.recalculateFteForOrder('order-1', 'user-1');

    expect(updated).toBe(0);
    expect(mockOrderMetricUpdate).not.toHaveBeenCalled();
  });

  it('handles multiple developers independently', async () => {
    const commits = [
      { commitHash: 'a1', authorEmail: 'alice@test.com', authorName: 'Alice', authorDate: new Date('2026-03-02'), effortHours: 6 },
      { commitHash: 'b1', authorEmail: 'bob@test.com', authorName: 'Bob', authorDate: new Date('2026-03-02'), effortHours: 4 },
    ];
    mockCommitAnalysisFindMany.mockResolvedValue(commits);

    mockDailyEffortFindMany.mockResolvedValue([
      { developerEmail: 'alice@test.com', date: new Date('2026-03-02') },
      { developerEmail: 'bob@test.com', date: new Date('2026-03-02') },
    ]);

    mockOrderMetricFindMany.mockResolvedValue([
      makeMetricRow({ id: 'metric-alice', developerEmail: 'alice@test.com', totalEffortHours: 6 }),
      makeMetricRow({ id: 'metric-bob', developerEmail: 'bob@test.com', totalEffortHours: 4 }),
    ]);
    mockOrderMetricUpdate.mockResolvedValue({});

    const updated = await service.recalculateFteForOrder('order-1', 'user-1');

    expect(updated).toBe(2);
    expect(mockOrderMetricUpdate).toHaveBeenCalledTimes(2);
  });

  it('filters by YEAR bucket correctly', async () => {
    const commits = [
      { commitHash: 'a1', authorEmail: 'dev@test.com', authorName: 'Dev', authorDate: new Date('2025-06-15'), effortHours: 5 },
      { commitHash: 'a2', authorEmail: 'dev@test.com', authorName: 'Dev', authorDate: new Date('2026-03-02'), effortHours: 3 },
    ];
    mockCommitAnalysisFindMany.mockResolvedValue(commits);

    mockDailyEffortFindMany.mockResolvedValue([
      { developerEmail: 'dev@test.com', date: new Date('2025-06-15') },
      { developerEmail: 'dev@test.com', date: new Date('2026-03-02') },
    ]);

    // YEAR bucket for 2025 — should only match 2025 commits/effort
    mockOrderMetricFindMany.mockResolvedValue([
      makeMetricRow({ id: 'metric-2025', periodType: 'YEAR', year: 2025, totalEffortHours: 5 }),
    ]);
    mockOrderMetricUpdate.mockResolvedValue({});

    const updated = await service.recalculateFteForOrder('order-1', 'user-1');

    expect(updated).toBe(1);
    const data = mockOrderMetricUpdate.mock.calls[0][0].data;
    // Only one day in 2025 bucket: June 15 (Sun) is weekend — but dayMap has it,
    // and single commit date = single day, so fteDays = 1 (weekend day in dayMap)
    expect(data.fteWorkDays).toBe(1);
  });

  it('filters by QUARTER bucket correctly', async () => {
    const commits = [
      { commitHash: 'a1', authorEmail: 'dev@test.com', authorName: 'Dev', authorDate: new Date('2026-01-05'), effortHours: 3 },
      { commitHash: 'a2', authorEmail: 'dev@test.com', authorName: 'Dev', authorDate: new Date('2026-04-10'), effortHours: 4 },
    ];
    mockCommitAnalysisFindMany.mockResolvedValue(commits);

    mockDailyEffortFindMany.mockResolvedValue([
      { developerEmail: 'dev@test.com', date: new Date('2026-01-05') },
      { developerEmail: 'dev@test.com', date: new Date('2026-04-10') },
    ]);

    // Q1 2026 bucket (month=1 → ceil(1/3)=1) — only Jan commit matches
    mockOrderMetricFindMany.mockResolvedValue([
      makeMetricRow({ id: 'metric-q1', periodType: 'QUARTER', year: 2026, month: 1, totalEffortHours: 3 }),
    ]);
    mockOrderMetricUpdate.mockResolvedValue({});

    const updated = await service.recalculateFteForOrder('order-1', 'user-1');

    expect(updated).toBe(1);
    const data = mockOrderMetricUpdate.mock.calls[0][0].data;
    // Only Jan 5 (Mon) in Q1 bucket — 1 weekday
    expect(data.fteWorkDays).toBe(1);
  });

  it('throws when order not found', async () => {
    mockOrderFindFirst.mockResolvedValue(null);

    await expect(
      service.recalculateFteForOrder('nonexistent', 'user-1')
    ).rejects.toThrow(/order not found/i);
  });
});
