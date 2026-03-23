import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';

const log = billingLogger;

interface RegistrationResult {
  creditsAssigned: number;
  referrerRewarded: boolean;
  referrerId: string | null;
}

/**
 * Assign registration credits to a newly created user.
 * If a valid referral code is provided, both the new user
 * and the referrer receive bonus credits.
 *
 * - New user without referral: gets `defaultFreeCredits`
 * - New user with valid referral: gets `defaultFreeCredits * referralBonusMultiplier`
 * - Referrer: gets `defaultFreeCredits` as reward (if under `maxReferralsPerUser` limit)
 */
export async function assignRegistrationCredits(
  newUserId: string,
  referralCode: string | null,
): Promise<RegistrationResult> {
  return prisma.$transaction(async (tx) => {
    // Load system settings (singleton row)
    const settings = await tx.systemSettings.findFirst();
    const freeCredits = settings?.defaultFreeCredits ?? 100;
    const multiplier = settings?.referralBonusMultiplier ?? 2;
    const maxReferrals = settings?.maxReferralsPerUser ?? 20;

    let creditsToAssign = freeCredits;
    let referrerRewarded = false;
    let referrerId: string | null = null;

    if (referralCode) {
      // Find referrer by their referral code
      const referrer = await tx.user.findFirst({
        where: { referralCode },
        select: { id: true },
      });

      if (referrer && referrer.id !== newUserId) {
        // Check referrer hasn't hit the limit
        const referralCount = await tx.referral.count({
          where: { referrerId: referrer.id },
        });

        if (referralCount < maxReferrals) {
          // Bonus for new user
          creditsToAssign = freeCredits * multiplier;
          referrerId = referrer.id;

          // Reward referrer with base credits
          const updatedReferrer = await tx.user.update({
            where: { id: referrer.id },
            data: { permanentCredits: { increment: freeCredits } },
            select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
          });

          await tx.creditTransaction.create({
            data: {
              userId: referrer.id,
              type: 'REFERRAL_REWARD',
              amount: freeCredits,
              wallet: 'PERMANENT',
              balanceAfter: updatedReferrer.permanentCredits + updatedReferrer.subscriptionCredits - updatedReferrer.reservedCredits,
              description: `Referral reward for inviting user`,
            },
          });

          await tx.referral.create({
            data: {
              referrerId: referrer.id,
              referredId: newUserId,
              creditsAwarded: freeCredits,
            },
          });

          referrerRewarded = true;
          log.info(
            { referrerId: referrer.id, newUserId, credits: freeCredits },
            'Referral reward granted',
          );
        }
      }
    }

    // Assign credits to new user
    await tx.user.update({
      where: { id: newUserId },
      data: {
        permanentCredits: creditsToAssign,
        ...(referrerId ? { referredByUserId: referrerId } : {}),
      },
    });

    const txType = referrerRewarded ? 'REFERRAL_BONUS' : 'REGISTRATION';
    await tx.creditTransaction.create({
      data: {
        userId: newUserId,
        type: txType,
        amount: creditsToAssign,
        wallet: 'PERMANENT',
        balanceAfter: creditsToAssign,
        description: referrerRewarded
          ? `Referral bonus: ${creditsToAssign} credits`
          : `Welcome bonus: ${creditsToAssign} credits`,
      },
    });

    log.info(
      { newUserId, credits: creditsToAssign, referrerRewarded },
      'Registration credits assigned',
    );

    return { creditsAssigned: creditsToAssign, referrerRewarded, referrerId };
  });
}
