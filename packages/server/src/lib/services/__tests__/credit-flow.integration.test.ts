/**
 * Integration tests for critical credit flow paths.
 * Tests end-to-end scenarios through the service layer with mocked Prisma.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    promoCode: { findUnique: vi.fn() },
    promoRedemption: { create: vi.fn() },
  },
}));

import prisma from '@/lib/db';
import {
  reserveCredits,
  debitCredit,
  releaseReservedCredits,
  runExpiryGuard,
} from '../credit-service';
import { redeemPromoCode } from '../promo-service';

const mockedPrisma = vi.mocked(prisma, true);

describe('Reserve -> Debit -> Release cycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
    mockedPrisma.$queryRaw.mockResolvedValue([]); // no expiry
  });

  it('reserve 10, debit 7, release returns 3', async () => {
    // Step 1: Reserve 10 credits
    mockedPrisma.$executeRaw.mockResolvedValue(1); // balance check passes
    mockedPrisma.user.findUnique.mockResolvedValue({
      permanentCredits: 90,
      subscriptionCredits: 0,
      reservedCredits: 10,
    } as any);
    mockedPrisma.creditTransaction.create.mockResolvedValue({} as any);

    const reserved = await reserveCredits('user1', 'job1', 'order1', 10);
    expect(reserved).toBe(true);
    expect(mockedPrisma.analysisJob.update).toHaveBeenCalledWith({
      where: { id: 'job1' },
      data: { creditsReserved: 10 },
    });

    // Step 2: Debit 7 times (simulate 7 commits processed)
    for (let i = 0; i < 7; i++) {
      vi.clearAllMocks();
      mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));

      // expiry guard returns no rows
      mockedPrisma.$queryRaw
        .mockResolvedValueOnce([]) // expiry guard
        .mockResolvedValueOnce([{ target: 'PERMANENT', sub_after: 0, perm_after: 90 - (i + 1) }]); // CTE debit
      mockedPrisma.$executeRaw.mockResolvedValue(1); // job budget check passes
      mockedPrisma.creditTransaction.create.mockResolvedValue({} as any);

      const result = await debitCredit('user1', 'job1', 'order1');
      expect(result).not.toBeNull();
      expect(result!.wallet).toBe('PERMANENT');
    }

    // Step 3: Release remaining credits (10 reserved - 7 consumed - 0 released = 3)
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));

    mockedPrisma.analysisJob.findUnique.mockResolvedValue({
      creditsReserved: 10,
      creditsConsumed: 7,
      creditsReleased: 0,
    } as any);
    mockedPrisma.$executeRaw.mockResolvedValue(1);
    mockedPrisma.user.findUnique.mockResolvedValue({
      permanentCredits: 93,
      subscriptionCredits: 0,
      reservedCredits: 0,
    } as any);
    mockedPrisma.creditTransaction.create.mockResolvedValue({} as any);

    const released = await releaseReservedCredits('user1', 'job1', 'order1');
    expect(released).toBe(3);

    // Verify job was updated with released amount
    expect(mockedPrisma.analysisJob.update).toHaveBeenCalledWith({
      where: { id: 'job1' },
      data: { creditsReleased: { increment: 3 } },
    });

    // Verify user reserved credits were decremented (floor-guarded raw SQL)
    expect(mockedPrisma.$executeRaw).toHaveBeenCalled();
    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user1' },
      select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
    });

    // Verify ANALYSIS_RELEASE transaction was created
    expect(mockedPrisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user1',
        type: 'ANALYSIS_RELEASE',
        amount: 3,
        wallet: 'PERMANENT',
        relatedOrderId: 'order1',
      }),
    });
  });
});

describe('Debit bounded by reservation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
    mockedPrisma.$queryRaw.mockResolvedValue([]); // no expiry
  });

  it('returns null when creditsConsumed == creditsReserved', async () => {
    // Job budget check fails: creditsConsumed already equals creditsReserved
    mockedPrisma.$executeRaw.mockResolvedValue(0); // no rows updated

    const result = await debitCredit('user1', 'job1', 'order1');

    expect(result).toBeNull();
    // $queryRaw is called once for expiry guard, but NOT for wallet debit CTE
    expect(mockedPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    // No credit transaction should be logged
    expect(mockedPrisma.creditTransaction.create).not.toHaveBeenCalled();
  });
});

describe('Expiry guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('zeroes subscription credits when subscription is expired', async () => {
    // Simulate expiry guard finding expired subscription
    mockedPrisma.$queryRaw.mockResolvedValue([{ expired_amount: 200 }]);
    mockedPrisma.creditTransaction.create.mockResolvedValue({} as any);

    const expired = await runExpiryGuard(mockedPrisma as any, 'user1');

    expect(expired).toBe(200);

    // Should create SUBSCRIPTION_EXPIRY transaction with negative amount
    expect(mockedPrisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user1',
        type: 'SUBSCRIPTION_EXPIRY',
        amount: -200,
        wallet: 'SUBSCRIPTION',
        balanceAfter: 0,
      }),
    });
  });

  it('returns 0 when subscription is still active', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([]);

    const expired = await runExpiryGuard(mockedPrisma as any, 'user1');

    expect(expired).toBe(0);
    // Should NOT create any transaction
    expect(mockedPrisma.creditTransaction.create).not.toHaveBeenCalled();
  });
});

describe('Release idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
  });

  it('second release call returns 0', async () => {
    // First release: 5 unused credits
    mockedPrisma.analysisJob.findUnique.mockResolvedValue({
      creditsReserved: 10,
      creditsConsumed: 5,
      creditsReleased: 0,
    } as any);
    mockedPrisma.user.update.mockResolvedValue({
      permanentCredits: 95,
      subscriptionCredits: 0,
      reservedCredits: 0,
    } as any);
    mockedPrisma.creditTransaction.create.mockResolvedValue({} as any);

    const first = await releaseReservedCredits('user1', 'job1', 'order1');
    expect(first).toBe(5);

    // Second release: creditsReleased is now 5, so unused = 10 - 5 - 5 = 0
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));

    mockedPrisma.analysisJob.findUnique.mockResolvedValue({
      creditsReserved: 10,
      creditsConsumed: 5,
      creditsReleased: 5, // already released from first call
    } as any);

    const second = await releaseReservedCredits('user1', 'job1', 'order1');
    expect(second).toBe(0);

    // Should NOT update user or create transaction on second call
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    expect(mockedPrisma.creditTransaction.create).not.toHaveBeenCalled();
  });
});

describe('Promo redemption success', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
  });

  it('valid code adds credits to permanentCredits', async () => {
    // Atomic promo update succeeds
    mockedPrisma.$executeRaw.mockResolvedValue(1);

    // Fetch promo details
    mockedPrisma.promoCode.findUnique.mockResolvedValue({
      id: 'promo1',
      code: 'WELCOME100',
      credits: 100,
    } as any);

    // Redemption record created successfully
    mockedPrisma.promoRedemption.create.mockResolvedValue({} as any);

    // User balance after credit increment
    mockedPrisma.user.update.mockResolvedValue({
      permanentCredits: 200,
      subscriptionCredits: 0,
      reservedCredits: 0,
    } as any);

    // Transaction log
    mockedPrisma.creditTransaction.create.mockResolvedValue({} as any);

    const result = await redeemPromoCode('user1', 'WELCOME100');

    expect(result).toEqual({ creditsAwarded: 100 });

    // Verify credits added to permanent wallet
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user1' },
      data: { permanentCredits: { increment: 100 } },
      select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
    });

    // Verify PROMO_REDEMPTION transaction created
    expect(mockedPrisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user1',
        type: 'PROMO_REDEMPTION',
        amount: 100,
        wallet: 'PERMANENT',
        balanceAfter: 200,
        relatedPromoId: 'promo1',
      }),
    });

    // Verify redemption record created
    expect(mockedPrisma.promoRedemption.create).toHaveBeenCalledWith({
      data: { promoCodeId: 'promo1', userId: 'user1' },
    });
  });
});
