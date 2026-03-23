import { NextRequest } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'billing/ios-verify' });

const verifySchema = z.object({
  originalTransactionId: z.string().min(1),
  productId: z.string().min(1),
  transactionType: z.enum(['consumable', 'subscription']).default('consumable'),
});

export async function POST(request: NextRequest) {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;
    const { user } = result;

    const body = await request.json();
    const parsed = verifySchema.safeParse(body);

    if (!parsed.success) {
      return apiError('Invalid request body', 400);
    }

    const { originalTransactionId, productId, transactionType } = parsed.data;

    // Idempotency check
    const existingEvent = await prisma.appStoreEvent.findUnique({
      where: { originalTransactionId },
    });

    if (existingEvent) {
      log.debug({ originalTransactionId }, 'App Store transaction already processed');
      // Return current balance (idempotent success)
      const currentUser = await prisma.user.findUnique({
        where: { id: user.id },
        select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
      });
      return apiResponse({
        alreadyProcessed: true,
        balance: currentUser
          ? currentUser.permanentCredits + currentUser.subscriptionCredits - currentUser.reservedCredits
          : 0,
      });
    }

    if (transactionType === 'consumable') {
      // Find credit pack by App Store product ID
      const pack = await prisma.creditPack.findUnique({
        where: { appStoreProductId: productId },
      });

      if (!pack) {
        log.error({ productId }, 'No CreditPack found for App Store product');
        return apiError('Unknown product', 400);
      }

      // Atomic: create event + credit user in transaction
      const updatedUser = await prisma.$transaction(async (tx) => {
        await tx.appStoreEvent.create({
          data: {
            originalTransactionId,
            type: 'PURCHASE',
            productId,
          },
        });

        const updated = await tx.user.update({
          where: { id: user.id },
          data: { permanentCredits: { increment: pack.credits } },
          select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
        });

        const balanceAfter = updated.permanentCredits + updated.subscriptionCredits - updated.reservedCredits;

        await tx.creditTransaction.create({
          data: {
            userId: user.id,
            type: 'IAP_PURCHASE',
            amount: pack.credits,
            wallet: 'PERMANENT',
            balanceAfter,
            description: `App Store purchase: ${pack.name} (${pack.credits} credits)`,
          },
        });

        return updated;
      });

      const balance = updatedUser.permanentCredits + updatedUser.subscriptionCredits - updatedUser.reservedCredits;

      log.info(
        { userId: user.id, productId, credits: pack.credits, originalTransactionId },
        'App Store credit pack purchase verified',
      );

      return apiResponse({ balance });
    }

    if (transactionType === 'subscription') {
      // Find subscription plan by App Store product ID
      const plan = await prisma.subscription.findUnique({
        where: { appStoreProductId: productId },
      });

      if (!plan) {
        log.error({ productId }, 'No Subscription found for App Store product');
        return apiError('Unknown subscription product', 400);
      }

      const updatedUser = await prisma.$transaction(async (tx) => {
        await tx.appStoreEvent.create({
          data: {
            originalTransactionId,
            type: 'SUBSCRIPTION',
            productId,
          },
        });

        // Expire old subscription credits
        const currentUserData = await tx.user.findUnique({
          where: { id: user.id },
          select: { subscriptionCredits: true },
        });

        if (currentUserData && currentUserData.subscriptionCredits > 0) {
          await tx.user.update({
            where: { id: user.id },
            data: { subscriptionCredits: 0 },
          });
          await tx.creditTransaction.create({
            data: {
              userId: user.id,
              type: 'SUBSCRIPTION_EXPIRY',
              amount: -currentUserData.subscriptionCredits,
              wallet: 'SUBSCRIPTION',
              balanceAfter: 0,
              description: `Previous subscription credits expired (${currentUserData.subscriptionCredits} credits)`,
            },
          });
        }

        // Calculate period end (30 days from now for monthly)
        const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

        // Upsert user subscription
        await tx.userSubscription.upsert({
          where: { userId: user.id },
          create: {
            userId: user.id,
            subscriptionId: plan.id,
            stripeSubscriptionId: `ios_${originalTransactionId}`,
            appStoreOriginalTransactionId: originalTransactionId,
            status: 'ACTIVE',
            currentPeriodStart: new Date(),
            currentPeriodEnd: periodEnd,
          },
          update: {
            subscriptionId: plan.id,
            appStoreOriginalTransactionId: originalTransactionId,
            status: 'ACTIVE',
            currentPeriodStart: new Date(),
            currentPeriodEnd: periodEnd,
          },
        });

        const updated = await tx.user.update({
          where: { id: user.id },
          data: {
            subscriptionCredits: plan.creditsPerMonth,
            subscriptionExpiresAt: periodEnd,
          },
          select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
        });

        const balanceAfter = updated.permanentCredits + updated.subscriptionCredits - updated.reservedCredits;

        await tx.creditTransaction.create({
          data: {
            userId: user.id,
            type: 'IAP_SUBSCRIPTION_RENEWAL',
            amount: plan.creditsPerMonth,
            wallet: 'SUBSCRIPTION',
            balanceAfter,
            description: `App Store subscription: ${plan.name} (${plan.creditsPerMonth} credits)`,
          },
        });

        return updated;
      });

      const balance = updatedUser.permanentCredits + updatedUser.subscriptionCredits - updatedUser.reservedCredits;

      log.info(
        { userId: user.id, productId, credits: plan.creditsPerMonth, originalTransactionId },
        'App Store subscription verified',
      );

      return apiResponse({ balance });
    }

    return apiError('Invalid transaction type', 400);
  } catch (err) {
    // Handle idempotency race condition (P2002 on AppStoreEvent unique)
    const prismaErr = err as { code?: string; meta?: { target?: string[] } };
    if (
      prismaErr?.code === 'P2002' &&
      prismaErr?.meta?.target?.some((t: string) => t.includes('originalTransactionId'))
    ) {
      log.debug({ err }, 'App Store transaction already processed (race condition)');
      return apiResponse({ alreadyProcessed: true });
    }

    log.error({ err }, 'iOS verify error');
    return apiError('Internal server error', 500);
  }
}
