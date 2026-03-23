import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    promoCode: { findUnique: vi.fn() },
    promoRedemption: { create: vi.fn() },
    user: { update: vi.fn() },
    creditTransaction: { create: vi.fn() },
  },
}));

import prisma from '@/lib/db';
import { redeemPromoCode } from '../promo-service';

const mockedPrisma = vi.mocked(prisma, true);

describe('redeemPromoCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
  });

  it('redeems valid code and credits permanent wallet', async () => {
    // Atomic UPDATE matches 1 row (code is valid, active, not expired, not exhausted)
    mockedPrisma.$executeRaw.mockResolvedValue(1);
    // Fetch promo for credit amount
    mockedPrisma.promoCode.findUnique.mockResolvedValue({
      id: 'promo1',
      code: 'WELCOME50',
      credits: 50,
    } as any);
    // promoRedemption.create succeeds (no P2002)
    mockedPrisma.promoRedemption.create.mockResolvedValue({} as any);
    // user.update returns new balance
    mockedPrisma.user.update.mockResolvedValue({
      permanentCredits: 150,
      subscriptionCredits: 0,
      reservedCredits: 0,
    } as any);
    // creditTransaction.create succeeds
    mockedPrisma.creditTransaction.create.mockResolvedValue({} as any);

    const result = await redeemPromoCode('user1', 'WELCOME50');

    expect(result).toEqual({ creditsAwarded: 50 });

    // Should have called $executeRaw for atomic promo update
    expect(mockedPrisma.$executeRaw).toHaveBeenCalled();

    // Should fetch the promo to get credits amount
    expect(mockedPrisma.promoCode.findUnique).toHaveBeenCalledWith({
      where: { code: 'WELCOME50' },
    });

    // Should create redemption record
    expect(mockedPrisma.promoRedemption.create).toHaveBeenCalledWith({
      data: { promoCodeId: 'promo1', userId: 'user1' },
    });

    // Should increment permanent credits
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user1' },
      data: { permanentCredits: { increment: 50 } },
      select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
    });

    // Should log credit transaction
    expect(mockedPrisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user1',
        type: 'PROMO_REDEMPTION',
        amount: 50,
        wallet: 'PERMANENT',
        balanceAfter: 150,
        relatedPromoId: 'promo1',
      }),
    });
  });

  it('throws error for expired / inactive / exhausted code', async () => {
    // Atomic UPDATE matches 0 rows
    mockedPrisma.$executeRaw.mockResolvedValue(0);

    await expect(redeemPromoCode('user1', 'EXPIRED_CODE')).rejects.toThrow(
      'Invalid or exhausted promo code',
    );

    // Should NOT attempt redemption record or credit
    expect(mockedPrisma.promoRedemption.create).not.toHaveBeenCalled();
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });

  it('throws user-friendly error when same user redeems twice (P2002)', async () => {
    // Atomic UPDATE succeeds
    mockedPrisma.$executeRaw.mockResolvedValue(1);
    mockedPrisma.promoCode.findUnique.mockResolvedValue({
      id: 'promo1',
      code: 'ONCE_ONLY',
      credits: 25,
    } as any);
    // promoRedemption.create throws P2002 (unique constraint violation)
    const p2002Error = new Error('Unique constraint failed');
    (p2002Error as any).code = 'P2002';
    mockedPrisma.promoRedemption.create.mockRejectedValue(p2002Error);

    await expect(redeemPromoCode('user1', 'ONCE_ONLY')).rejects.toThrow(
      'already redeemed',
    );

    // Should NOT update user credits (tx rolled back)
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
  });

  it('throws for invalid code that does not exist (findUnique returns null after UPDATE)', async () => {
    // Edge case: $executeRaw returns 1 but findUnique returns null
    // (should not happen in practice, but defensively handled)
    mockedPrisma.$executeRaw.mockResolvedValue(1);
    mockedPrisma.promoCode.findUnique.mockResolvedValue(null);

    await expect(redeemPromoCode('user1', 'GHOST_CODE')).rejects.toThrow(
      'Promo code not found after update',
    );
  });

  it('normalizes code to uppercase before querying', async () => {
    mockedPrisma.$executeRaw.mockResolvedValue(1);
    mockedPrisma.promoCode.findUnique.mockResolvedValue({
      id: 'promo1',
      code: 'LOWERCASE',
      credits: 10,
    } as any);
    mockedPrisma.promoRedemption.create.mockResolvedValue({} as any);
    mockedPrisma.user.update.mockResolvedValue({
      permanentCredits: 110,
      subscriptionCredits: 0,
      reservedCredits: 0,
    } as any);
    mockedPrisma.creditTransaction.create.mockResolvedValue({} as any);

    const result = await redeemPromoCode('user1', 'lowercase');

    expect(result).toEqual({ creditsAwarded: 10 });
    // The findUnique should use uppercased code
    expect(mockedPrisma.promoCode.findUnique).toHaveBeenCalledWith({
      where: { code: 'LOWERCASE' },
    });
  });
});
