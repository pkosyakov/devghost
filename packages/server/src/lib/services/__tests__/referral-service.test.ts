import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    $transaction: vi.fn(),
    systemSettings: { findFirst: vi.fn() },
    user: { findFirst: vi.fn(), update: vi.fn() },
    referral: { count: vi.fn(), create: vi.fn() },
    creditTransaction: { create: vi.fn() },
  },
}));

import prisma from '@/lib/db';
import { assignRegistrationCredits } from '../referral-service';

const mockedPrisma = vi.mocked(prisma, true);

describe('assignRegistrationCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
  });

  it('assigns default credits without referral code', async () => {
    mockedPrisma.systemSettings.findFirst.mockResolvedValue({
      defaultFreeCredits: 100,
      referralBonusMultiplier: 2,
      maxReferralsPerUser: 20,
    } as any);

    const result = await assignRegistrationCredits('newuser1', null);

    expect(result.creditsAssigned).toBe(100);
    expect(result.referrerRewarded).toBe(false);
    expect(result.referrerId).toBeNull();

    // Should update user's permanent credits
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'newuser1' },
      data: { permanentCredits: 100 },
    });

    // Should create REGISTRATION transaction
    expect(mockedPrisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'newuser1',
        type: 'REGISTRATION',
        amount: 100,
        wallet: 'PERMANENT',
        balanceAfter: 100,
      }),
    });
  });

  it('assigns double credits with valid referral', async () => {
    mockedPrisma.systemSettings.findFirst.mockResolvedValue({
      defaultFreeCredits: 100,
      referralBonusMultiplier: 2,
      maxReferralsPerUser: 20,
    } as any);
    mockedPrisma.user.findFirst.mockResolvedValue({
      id: 'referrer1',
      referralCode: 'ABC123',
    } as any);
    mockedPrisma.referral.count.mockResolvedValue(5); // under limit
    // Mock the referrer update returning balance info
    mockedPrisma.user.update.mockResolvedValueOnce({
      permanentCredits: 600,
      subscriptionCredits: 50,
      reservedCredits: 0,
    } as any);

    const result = await assignRegistrationCredits('newuser1', 'ABC123');

    expect(result.creditsAssigned).toBe(200);
    expect(result.referrerRewarded).toBe(true);
    expect(result.referrerId).toBe('referrer1');

    // Should reward referrer with freeCredits (not multiplied)
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'referrer1' },
      data: { permanentCredits: { increment: 100 } },
      select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
    });

    // Should create referral record
    expect(mockedPrisma.referral.create).toHaveBeenCalledWith({
      data: {
        referrerId: 'referrer1',
        referredId: 'newuser1',
        creditsAwarded: 100,
      },
    });

    // Should assign multiplied credits to new user (with referredByUserId)
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'newuser1' },
      data: { permanentCredits: 200, referredByUserId: 'referrer1' },
    });

    // Should create REFERRAL_BONUS transaction for new user
    expect(mockedPrisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'newuser1',
        type: 'REFERRAL_BONUS',
        amount: 200,
      }),
    });

    // Should create REFERRAL_REWARD transaction for referrer with actual balance
    expect(mockedPrisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'referrer1',
        type: 'REFERRAL_REWARD',
        amount: 100,
        balanceAfter: 650, // 600 permanent + 50 subscription - 0 reserved
      }),
    });
  });

  it('assigns standard credits when referrer at limit', async () => {
    mockedPrisma.systemSettings.findFirst.mockResolvedValue({
      defaultFreeCredits: 100,
      referralBonusMultiplier: 2,
      maxReferralsPerUser: 20,
    } as any);
    mockedPrisma.user.findFirst.mockResolvedValue({
      id: 'referrer1',
      referralCode: 'ABC123',
    } as any);
    mockedPrisma.referral.count.mockResolvedValue(20); // at limit

    const result = await assignRegistrationCredits('newuser1', 'ABC123');

    expect(result.creditsAssigned).toBe(100);
    expect(result.referrerRewarded).toBe(false);
    expect(result.referrerId).toBeNull();

    // Should NOT create referral record
    expect(mockedPrisma.referral.create).not.toHaveBeenCalled();
  });

  it('assigns standard credits when referral code not found', async () => {
    mockedPrisma.systemSettings.findFirst.mockResolvedValue({
      defaultFreeCredits: 100,
      referralBonusMultiplier: 2,
      maxReferralsPerUser: 20,
    } as any);
    mockedPrisma.user.findFirst.mockResolvedValue(null); // no referrer found

    const result = await assignRegistrationCredits('newuser1', 'INVALID_CODE');

    expect(result.creditsAssigned).toBe(100);
    expect(result.referrerRewarded).toBe(false);
    expect(result.referrerId).toBeNull();
  });

  it('prevents self-referral', async () => {
    mockedPrisma.systemSettings.findFirst.mockResolvedValue({
      defaultFreeCredits: 100,
      referralBonusMultiplier: 2,
      maxReferralsPerUser: 20,
    } as any);
    mockedPrisma.user.findFirst.mockResolvedValue({
      id: 'newuser1', // same as new user
      referralCode: 'SELF_CODE',
    } as any);

    const result = await assignRegistrationCredits('newuser1', 'SELF_CODE');

    expect(result.creditsAssigned).toBe(100);
    expect(result.referrerRewarded).toBe(false);
    expect(result.referrerId).toBeNull();
  });

  it('uses fallback defaults when no system settings exist', async () => {
    mockedPrisma.systemSettings.findFirst.mockResolvedValue(null);

    const result = await assignRegistrationCredits('newuser1', null);

    expect(result.creditsAssigned).toBe(100); // default fallback
    expect(result.referrerRewarded).toBe(false);
  });
});
