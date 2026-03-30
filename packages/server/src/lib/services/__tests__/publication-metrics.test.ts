import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('@/lib/db', () => ({
  default: {
    commitAnalysis: {
      findMany: vi.fn(),
    },
  },
}));

import prisma from '@/lib/db';
import { computeRepoMetrics } from '../publication-metrics';

const mockedPrisma = vi.mocked(prisma, true);

describe('computeRepoMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no commits', async () => {
    mockedPrisma.commitAnalysis.findMany.mockResolvedValue([]);

    const result = await computeRepoMetrics('order-1', 'owner/repo');

    expect(result).toEqual([]);
    expect(mockedPrisma.commitAnalysis.findMany).toHaveBeenCalledWith({
      where: { orderId: 'order-1', repository: 'owner/repo' },
      select: {
        commitHash: true,
        authorEmail: true,
        authorName: true,
        authorDate: true,
        effortHours: true,
      },
      orderBy: { authorDate: 'asc' },
    });
  });

  it('computes per-developer metrics from commits', async () => {
    mockedPrisma.commitAnalysis.findMany.mockResolvedValue([
      {
        authorEmail: 'dev@example.com',
        authorName: 'Dev One',
        authorDate: new Date('2025-03-01T10:00:00Z'),
        effortHours: new Prisma.Decimal(1.5),
      },
      {
        authorEmail: 'dev@example.com',
        authorName: 'Dev One',
        authorDate: new Date('2025-03-02T14:00:00Z'),
        effortHours: new Prisma.Decimal(2.0),
      },
    ] as any);

    const result = await computeRepoMetrics('order-1', 'owner/repo');

    expect(result).toHaveLength(1);
    const m = result[0];
    expect(m.developerEmail).toBe('dev@example.com');
    expect(m.developerName).toBe('Dev One');
    expect(m.commitCount).toBe(2);
    expect(m.totalEffortHours).toBe(3.5);
    expect(m.actualWorkDays).toBe(2);
    expect(m.avgDailyEffort).toBe(1.75);
    expect(m.share).toBe(1); // only developer
    expect(m.periodType).toBe('ALL_TIME');
    expect(m.shareAutoCalculated).toBe(true);
    expect(m.hasEnoughData).toBe(true);
    expect(m.ghostPercentRaw).toBeTypeOf('number');
    expect(m.ghostPercent).toBeTypeOf('number');
  });

  it('filters by visibleDevelopers', async () => {
    mockedPrisma.commitAnalysis.findMany.mockResolvedValue([
      {
        authorEmail: 'alice@example.com',
        authorName: 'Alice',
        authorDate: new Date('2025-03-01T10:00:00Z'),
        effortHours: new Prisma.Decimal(2.0),
      },
      {
        authorEmail: 'bob@example.com',
        authorName: 'Bob',
        authorDate: new Date('2025-03-01T11:00:00Z'),
        effortHours: new Prisma.Decimal(3.0),
      },
    ] as any);

    const result = await computeRepoMetrics('order-1', 'owner/repo', ['alice@example.com']);

    expect(result).toHaveLength(1);
    expect(result[0].developerEmail).toBe('alice@example.com');
    // Share is calculated against total commit count (alice 1 / total 2)
    expect(result[0].share).toBeCloseTo(1 / 2);
  });
});
