import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll mock prisma
vi.mock('@/lib/db', () => ({
  default: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    creditTransaction: {
      create: vi.fn(),
    },
    analysisJob: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import prisma from '@/lib/db';
import {
  getAvailableBalance,
  runExpiryGuard,
  debitCredit,
  reserveCredits,
  releaseReservedCredits,
  type BalanceInfo,
} from '../credit-service';

const mockedPrisma = vi.mocked(prisma, true);

describe('getAvailableBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // $transaction executes the callback with mockedPrisma as tx
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
    // Default: expiry guard returns no expired rows
    mockedPrisma.$queryRaw.mockResolvedValue([]);
  });

  it('returns correct available balance with no reservations', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      permanentCredits: 100,
      subscriptionCredits: 50,
      reservedCredits: 0,
      subscriptionExpiresAt: new Date('2099-01-01'),
    } as any);

    const result = await getAvailableBalance('user1');

    expect(result).toEqual({
      permanent: 100,
      subscription: 50,
      reserved: 0,
      available: 150,
      subscriptionExpiresAt: expect.any(Date),
    });
  });

  it('subtracts reserved credits from available', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      permanentCredits: 100,
      subscriptionCredits: 50,
      reservedCredits: 30,
      subscriptionExpiresAt: new Date('2099-01-01'),
    } as any);

    const result = await getAvailableBalance('user1');

    expect(result.available).toBe(120);
    expect(result.reserved).toBe(30);
  });

  it('throws if user not found', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await expect(getAvailableBalance('nonexistent')).rejects.toThrow('User not found');
  });
});

describe('runExpiryGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 when no credits expired', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([]);

    const result = await runExpiryGuard(mockedPrisma as any, 'user1');

    expect(result).toBe(0);
  });

  it('returns expired amount and creates transaction', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{ expired_amount: 50 }]);

    const result = await runExpiryGuard(mockedPrisma as any, 'user1');

    expect(result).toBe(50);
    expect(mockedPrisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user1',
        type: 'SUBSCRIPTION_EXPIRY',
        amount: -50,
        wallet: 'SUBSCRIPTION',
        balanceAfter: 0,
      }),
    });
  });
});

describe('debitCredit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
    // Default: no expiry
    mockedPrisma.$queryRaw.mockResolvedValue([]);
  });

  it('debits from subscription wallet when available', async () => {
    // First $queryRaw = expiry guard (no rows), already mocked above
    // Then $executeRaw = job budget check (1 row updated)
    mockedPrisma.$executeRaw.mockResolvedValue(1);
    // $queryRaw calls: expiry guard → CTE debit → reservedCredits read-back
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([]) // expiry guard
      .mockResolvedValueOnce([{ target: 'SUBSCRIPTION', sub_after: 49, perm_after: 100 }])
      .mockResolvedValueOnce([{ r: 10 }]); // reservedCredits after debit

    const result = await debitCredit('user1', 'job1', 'order1');

    expect(result).not.toBeNull();
    expect(result!.wallet).toBe('SUBSCRIPTION');
    // balanceAfter = sub_after + perm_after - reserved = 49 + 100 - 10 = 139
    expect(result!.balanceAfter).toBe(139);
  });

  it('returns null when job reservation exhausted', async () => {
    mockedPrisma.$executeRaw.mockResolvedValue(0); // no rows updated

    const result = await debitCredit('user1', 'job1', 'order1');

    expect(result).toBeNull();
  });

  it('rolls back job increment when wallet empty', async () => {
    mockedPrisma.$executeRaw
      .mockResolvedValueOnce(1) // job budget check passes
      .mockResolvedValueOnce(1); // rollback
    mockedPrisma.$queryRaw
      .mockResolvedValueOnce([]) // expiry guard
      .mockResolvedValueOnce([]); // CTE returns empty (wallet empty)

    const result = await debitCredit('user1', 'job1', 'order1');

    expect(result).toBeNull();
    // Should have called $executeRaw twice (budget check + rollback)
    expect(mockedPrisma.$executeRaw).toHaveBeenCalledTimes(2);
  });
});

describe('reserveCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
    mockedPrisma.$queryRaw.mockResolvedValue([]); // expiry guard
  });

  it('returns true when reservation succeeds', async () => {
    mockedPrisma.$executeRaw.mockResolvedValue(1); // 1 row updated
    mockedPrisma.user.findUnique.mockResolvedValue({
      permanentCredits: 80,
      subscriptionCredits: 50,
      reservedCredits: 20,
    } as any);

    const result = await reserveCredits('user1', 'job1', 'order1', 20);

    expect(result).toBe(true);
    expect(mockedPrisma.analysisJob.update).toHaveBeenCalledWith({
      where: { id: 'job1' },
      data: { creditsReserved: 20 },
    });
  });

  it('returns false when insufficient balance', async () => {
    mockedPrisma.$executeRaw.mockResolvedValue(0); // no rows updated

    const result = await reserveCredits('user1', 'job1', 'order1', 200);

    expect(result).toBe(false);
  });

  it('throws on non-positive amount', async () => {
    await expect(reserveCredits('user1', 'job1', 'order1', 0)).rejects.toThrow('amount must be positive');
    await expect(reserveCredits('user1', 'job1', 'order1', -5)).rejects.toThrow('amount must be positive');
  });
});

describe('releaseReservedCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
  });

  it('releases unused credits (reserved - consumed - released)', async () => {
    mockedPrisma.analysisJob.findUnique.mockResolvedValue({
      creditsReserved: 100,
      creditsConsumed: 60,
      creditsReleased: 10, // 10 from cache hits
    } as any);
    mockedPrisma.$executeRaw.mockResolvedValue(1);
    mockedPrisma.user.findUnique.mockResolvedValue({
      permanentCredits: 80,
      subscriptionCredits: 50,
      reservedCredits: 0,
    } as any);

    const result = await releaseReservedCredits('user1', 'job1', 'order1');

    expect(result).toBe(30); // 100 - 60 - 10
    expect(mockedPrisma.analysisJob.update).toHaveBeenCalledWith({
      where: { id: 'job1' },
      data: { creditsReleased: { increment: 30 } },
    });
    // Uses floor-guarded raw SQL instead of Prisma decrement
    expect(mockedPrisma.$executeRaw).toHaveBeenCalled();
    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user1' },
      select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
    });
  });

  it('returns 0 when nothing to release', async () => {
    mockedPrisma.analysisJob.findUnique.mockResolvedValue({
      creditsReserved: 100,
      creditsConsumed: 100,
      creditsReleased: 0,
    } as any);

    const result = await releaseReservedCredits('user1', 'job1', 'order1');

    expect(result).toBe(0);
  });

  it('returns 0 when job not found', async () => {
    mockedPrisma.analysisJob.findUnique.mockResolvedValue(null);

    const result = await releaseReservedCredits('user1', 'job1', 'order1');

    expect(result).toBe(0);
  });
});
