import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';
import type { Prisma, WalletType } from '@prisma/client';

const log = billingLogger;

/**
 * Check if billing/credit system is enabled.
 * Default: false (disabled). Set BILLING_ENABLED=true in production.
 */
export function isBillingEnabled(): boolean {
  return process.env.BILLING_ENABLED === 'true';
}

export interface BalanceInfo {
  permanent: number;
  subscription: number;
  reserved: number;
  available: number;
  subscriptionExpiresAt: Date | null;
}

export interface DebitResult {
  wallet: WalletType;
  balanceAfter: number;
}

/**
 * Expiry guard: if subscription credits are expired, zero them out
 * and log a SUBSCRIPTION_EXPIRY transaction.
 * Runs inline before any balance read or debit.
 * Returns number of credits expired (0 if none).
 */
export async function runExpiryGuard(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<number> {
  // CTE captures old value before UPDATE zeroes it (RETURNING gives post-SET values)
  const expired = await tx.$queryRaw<{ expired_amount: number }[]>`
    WITH old AS (
      SELECT id, "subscriptionCredits" AS expired_amount
      FROM "User"
      WHERE id = ${userId}
        AND "subscriptionExpiresAt" IS NOT NULL
        AND "subscriptionExpiresAt" <= NOW()
        AND "subscriptionCredits" > 0
      FOR UPDATE
    ),
    zeroed AS (
      UPDATE "User" u
      SET "subscriptionCredits" = 0, "subscriptionExpiresAt" = NULL
      FROM old
      WHERE u.id = old.id
      RETURNING 1
    )
    SELECT expired_amount FROM old WHERE EXISTS (SELECT 1 FROM zeroed)
  `;

  if (expired.length === 0) return 0;

  const amount = expired[0].expired_amount;

  // Record the expiry in the ledger
  await tx.creditTransaction.create({
    data: {
      userId,
      type: 'SUBSCRIPTION_EXPIRY',
      amount: -amount,
      wallet: 'SUBSCRIPTION',
      balanceAfter: 0,
      description: `Subscription credits expired (${amount} credits)`,
    },
  });

  log.info({ userId, amount }, 'Subscription credits expired');
  return amount;
}

/**
 * Get available balance for a user (with inline expiry guard).
 */
export async function getAvailableBalance(userId: string): Promise<BalanceInfo> {
  return prisma.$transaction(async (tx) => {
    // Run expiry guard first
    await runExpiryGuard(tx, userId);

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        permanentCredits: true,
        subscriptionCredits: true,
        reservedCredits: true,
        subscriptionExpiresAt: true,
      },
    });

    if (!user) throw new Error('User not found');

    return {
      permanent: user.permanentCredits,
      subscription: user.subscriptionCredits,
      reserved: user.reservedCredits,
      available: user.permanentCredits + user.subscriptionCredits - user.reservedCredits,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
    };
  });
}

/**
 * Reserve credits for an analysis job.
 * Returns true if reservation succeeded, false if insufficient balance.
 */
export async function reserveCredits(
  userId: string,
  jobId: string,
  orderId: string,
  amount: number,
): Promise<boolean> {
  if (amount <= 0) throw new Error(`reserveCredits: amount must be positive, got ${amount}`);

  return prisma.$transaction(async (tx) => {
    await runExpiryGuard(tx, userId);

    // Atomic reserve with balance check
    const reserved = await tx.$executeRaw`
      UPDATE "User"
      SET "reservedCredits" = "reservedCredits" + ${amount}
      WHERE id = ${userId}
        AND ("permanentCredits" + "subscriptionCredits" - "reservedCredits") >= ${amount}
    `;

    if (reserved === 0) return false;

    // Record on the specific job
    await tx.analysisJob.update({
      where: { id: jobId },
      data: { creditsReserved: amount },
    });

    // Log transaction — read actual balance for accurate ledger
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
    });
    if (!user) throw new Error('User disappeared during reservation');

    const balanceAfter = user.permanentCredits + user.subscriptionCredits - user.reservedCredits;
    await tx.creditTransaction.create({
      data: {
        userId,
        type: 'ANALYSIS_RESERVE',
        amount: -amount,
        wallet: 'PERMANENT', // reservation is conceptual, not from a specific wallet yet
        balanceAfter,
        relatedOrderId: orderId,
        description: `Reserved ${amount} credits for analysis`,
      },
    });

    log.info({ userId, jobId, orderId, amount }, 'Credits reserved');
    return true;
  });
}

/**
 * Debit 1 credit for a processed commit.
 * Bounded by the job's reservation (creditsConsumed < creditsReserved).
 * Returns which wallet was debited, or null if budget exhausted.
 */
export async function debitCredit(
  userId: string,
  jobId: string,
  orderId: string,
): Promise<DebitResult | null> {
  return prisma.$transaction(async (tx) => {
    // Expiry guard
    await runExpiryGuard(tx, userId);

    // Check job still has reserved budget
    const jobUpdated = await tx.$executeRaw`
      UPDATE "AnalysisJob"
      SET "creditsConsumed" = "creditsConsumed" + 1
      WHERE id = ${jobId} AND "creditsConsumed" < "creditsReserved"
    `;

    if (jobUpdated === 0) return null; // reservation exhausted

    // Atomic wallet choice + debit in a single statement via CTE
    const result = await tx.$queryRaw<
      { target: string; sub_after: number; perm_after: number }[]
    >`
      WITH wallet_choice AS (
        SELECT id,
          CASE WHEN "subscriptionCredits" > 0 THEN 'SUBSCRIPTION' ELSE 'PERMANENT' END AS target,
          "subscriptionCredits", "permanentCredits"
        FROM "User" WHERE id = ${userId}
      ),
      debited AS (
        UPDATE "User" u SET
          "subscriptionCredits" = CASE WHEN wc.target = 'SUBSCRIPTION'
                                  THEN u."subscriptionCredits" - 1 ELSE u."subscriptionCredits" END,
          "permanentCredits" = CASE WHEN wc.target = 'PERMANENT'
                               THEN u."permanentCredits" - 1 ELSE u."permanentCredits" END,
          "reservedCredits" = u."reservedCredits" - 1
        FROM wallet_choice wc
        WHERE u.id = wc.id
          AND (CASE WHEN wc.target = 'SUBSCRIPTION' THEN u."subscriptionCredits"
                    ELSE u."permanentCredits" END) > 0
        RETURNING wc.target, u."subscriptionCredits" AS sub_after, u."permanentCredits" AS perm_after
      )
      SELECT * FROM debited
    `;

    if (result.length === 0) {
      // Wallet empty — roll back the job increment (guard against underflow)
      await tx.$executeRaw`
        UPDATE "AnalysisJob" SET "creditsConsumed" = "creditsConsumed" - 1
        WHERE id = ${jobId} AND "creditsConsumed" > 0
      `;
      return null;
    }

    const { target: wallet, sub_after, perm_after } = result[0];
    // Total available balance (consistent with other transaction types)
    const reservedAfter = await tx.$queryRaw<{ r: number }[]>`
      SELECT "reservedCredits" AS r FROM "User" WHERE id = ${userId}
    `;
    const reserved = reservedAfter[0]?.r ?? 0;
    const balanceAfter = sub_after + perm_after - reserved;

    await tx.creditTransaction.create({
      data: {
        userId,
        type: 'ANALYSIS_DEBIT',
        amount: -1,
        wallet: wallet as WalletType,
        balanceAfter,
        relatedOrderId: orderId,
      },
    });

    return { wallet: wallet as WalletType, balanceAfter };
  });
}

/**
 * Release unused reserved credits after analysis completes/fails.
 * Idempotent — safe to call multiple times.
 */
export async function releaseReservedCredits(
  userId: string,
  jobId: string,
  orderId: string,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    // Get job state
    const job = await tx.analysisJob.findUnique({
      where: { id: jobId },
      select: { creditsReserved: true, creditsConsumed: true, creditsReleased: true },
    });

    if (!job) return 0;

    // unused = what was reserved minus what was consumed minus what was
    // already released (cache hits release individually during processing)
    const unused = job.creditsReserved - job.creditsConsumed - job.creditsReleased;
    if (unused <= 0) return 0;

    // Mark final release on job
    await tx.analysisJob.update({
      where: { id: jobId },
      data: { creditsReleased: { increment: unused } },
    });

    // Return to user's available pool (floor guard against negative)
    await tx.$executeRaw`
      UPDATE "User" SET "reservedCredits" = GREATEST("reservedCredits" - ${unused}, 0)
      WHERE id = ${userId}
    `;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
    });
    if (!user) return unused;

    await tx.creditTransaction.create({
      data: {
        userId,
        type: 'ANALYSIS_RELEASE',
        amount: unused,
        wallet: 'PERMANENT',
        balanceAfter: user.permanentCredits + user.subscriptionCredits - user.reservedCredits,
        relatedOrderId: orderId,
        description: `Released ${unused} unused credits`,
      },
    });

    log.info({ userId, jobId, orderId, unused }, 'Reserved credits released');
    return unused;
  });
}
