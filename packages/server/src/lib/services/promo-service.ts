import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ service: 'promo' });

export interface RedeemResult {
  creditsAwarded: number;
}

/**
 * Redeem a promo code for the given user.
 *
 * Atomic guarantees:
 * - Global redemption limit: WHERE "redemptionCount" < "maxRedemptions"
 *   in raw SQL — field-to-field comparison prevents race conditions.
 * - Per-user uniqueness: @@unique([promoCodeId, userId]) on PromoRedemption
 *   — DB rejects duplicate, entire transaction rolls back.
 * - Expiry: checked in the same UPDATE WHERE clause, not a separate read.
 */
export async function redeemPromoCode(
  userId: string,
  code: string,
): Promise<RedeemResult> {
  const normalizedCode = code.toUpperCase();

  try {
    return await prisma.$transaction(async (tx) => {
      // Atomic conditional increment via raw SQL — field-to-field comparison
      // not expressible in Prisma Client, so we use $executeRaw
      const updated = await tx.$executeRaw`
        UPDATE "PromoCode"
        SET "redemptionCount" = "redemptionCount" + 1
        WHERE code = ${normalizedCode}
          AND "isActive" = true
          AND "expiresAt" > NOW()
          AND ("maxRedemptions" IS NULL OR "redemptionCount" < "maxRedemptions")
      `;

      if (updated === 0) {
        throw new Error('Invalid or exhausted promo code');
      }

      // Fetch promo for credits amount
      const promo = await tx.promoCode.findUnique({
        where: { code: normalizedCode },
      });

      if (!promo) {
        throw new Error('Promo code not found after update');
      }

      // @@unique([promoCodeId, userId]) prevents per-user double-redeem at DB level
      // If this throws P2002, the transaction rolls back (including the increment above)
      await tx.promoRedemption.create({
        data: { promoCodeId: promo.id, userId },
      });

      // Credit permanent wallet
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { permanentCredits: { increment: promo.credits } },
        select: {
          permanentCredits: true,
          subscriptionCredits: true,
          reservedCredits: true,
        },
      });

      const balanceAfter =
        updatedUser.permanentCredits +
        updatedUser.subscriptionCredits -
        updatedUser.reservedCredits;

      await tx.creditTransaction.create({
        data: {
          userId,
          type: 'PROMO_REDEMPTION',
          amount: promo.credits,
          wallet: 'PERMANENT',
          balanceAfter,
          relatedPromoId: promo.id,
          description: `Redeemed promo code: ${promo.code}`,
        },
      });

      log.info(
        { userId, promoCodeId: promo.id, code: promo.code, credits: promo.credits },
        'Promo code redeemed',
      );

      return { creditsAwarded: promo.credits };
    });
  } catch (err: unknown) {
    // Catch Prisma P2002 (unique constraint violation) — user already redeemed this code
    if (
      err instanceof Error &&
      'code' in err &&
      (err as { code: string }).code === 'P2002'
    ) {
      log.warn({ userId, code: normalizedCode }, 'Duplicate promo redemption attempt');
      throw new Error('You have already redeemed this promo code');
    }
    throw err;
  }
}
