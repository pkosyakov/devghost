import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'billing/ios-webhook' });

export const dynamic = 'force-dynamic';

// App Store Server Notifications v2 payload structure (simplified)
interface AppStoreNotification {
  notificationType: string;
  subtype?: string;
  data: {
    signedTransactionInfo?: string;
    signedRenewalInfo?: string;
  };
}

interface DecodedTransactionInfo {
  originalTransactionId: string;
  productId: string;
  type: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // TODO: In production, verify the JWS signature of the notification
    // using Apple's root certificate chain. For MVP, we process the payload directly.

    const notification = body as AppStoreNotification;
    const { notificationType, subtype } = notification;

    log.info({ notificationType, subtype }, 'Received App Store notification');

    // For MVP, extract transaction info from the notification
    // In production, decode the JWS signed transaction info
    const transactionInfo = extractTransactionInfo(notification);

    if (!transactionInfo) {
      log.warn({ notificationType }, 'Could not extract transaction info');
      return NextResponse.json({ received: true });
    }

    const { originalTransactionId, productId } = transactionInfo;

    switch (notificationType) {
      case 'DID_RENEW':
        await handleRenewal(originalTransactionId, productId);
        break;

      case 'REFUND':
        await handleRefund(originalTransactionId, productId);
        break;

      case 'REVOKE':
        await handleRevoke(originalTransactionId);
        break;

      case 'DID_CHANGE_RENEWAL_STATUS':
        log.info({ originalTransactionId, subtype }, 'Renewal status changed');
        break;

      case 'SUBSCRIBED':
        log.info({ originalTransactionId, productId }, 'New subscription (handled by ios-verify)');
        break;

      default:
        log.debug({ notificationType }, 'Unhandled App Store notification type');
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    log.error({ err }, 'iOS webhook processing error');
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}

function extractTransactionInfo(notification: AppStoreNotification): DecodedTransactionInfo | null {
  // TODO: Properly decode JWS signed transaction info
  // For now, try to extract from the notification data directly
  try {
    if (notification.data?.signedTransactionInfo) {
      // JWS format: header.payload.signature
      const parts = notification.data.signedTransactionInfo.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        return {
          originalTransactionId: payload.originalTransactionId,
          productId: payload.productId,
          type: payload.type,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function handleRenewal(originalTransactionId: string, productId: string): Promise<void> {
  const eventId = `renewal_${originalTransactionId}_${Date.now()}`;

  // Idempotency
  const existing = await prisma.appStoreEvent.findFirst({
    where: { originalTransactionId: eventId },
  });
  if (existing) {
    log.debug({ originalTransactionId }, 'Renewal already processed');
    return;
  }

  const plan = await prisma.subscription.findUnique({
    where: { appStoreProductId: productId },
  });

  if (!plan) {
    log.error({ productId }, 'Subscription plan not found for renewal');
    return;
  }

  const userSub = await prisma.userSubscription.findFirst({
    where: { appStoreOriginalTransactionId: originalTransactionId },
  });

  if (!userSub) {
    log.error({ originalTransactionId }, 'UserSubscription not found for renewal');
    return;
  }

  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  await prisma.$transaction(async (tx) => {
    await tx.appStoreEvent.create({
      data: {
        originalTransactionId: eventId,
        type: 'RENEWAL',
        productId,
      },
    });

    // Expire old credits
    const userData = await tx.user.findUnique({
      where: { id: userSub.userId },
      select: { subscriptionCredits: true },
    });

    if (userData && userData.subscriptionCredits > 0) {
      await tx.user.update({
        where: { id: userSub.userId },
        data: { subscriptionCredits: 0 },
      });
      await tx.creditTransaction.create({
        data: {
          userId: userSub.userId,
          type: 'SUBSCRIPTION_EXPIRY',
          amount: -userData.subscriptionCredits,
          wallet: 'SUBSCRIPTION',
          balanceAfter: 0,
          description: `Subscription credits expired before renewal`,
        },
      });
    }

    // Apply new credits
    const updated = await tx.user.update({
      where: { id: userSub.userId },
      data: {
        subscriptionCredits: plan.creditsPerMonth,
        subscriptionExpiresAt: periodEnd,
      },
      select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
    });

    const balanceAfter = updated.permanentCredits + updated.subscriptionCredits - updated.reservedCredits;

    await tx.creditTransaction.create({
      data: {
        userId: userSub.userId,
        type: 'IAP_SUBSCRIPTION_RENEWAL',
        amount: plan.creditsPerMonth,
        wallet: 'SUBSCRIPTION',
        balanceAfter,
        description: `App Store subscription renewed: ${plan.name} (${plan.creditsPerMonth} credits)`,
      },
    });

    // Update subscription period
    await tx.userSubscription.update({
      where: { id: userSub.id },
      data: {
        status: 'ACTIVE',
        currentPeriodStart: new Date(),
        currentPeriodEnd: periodEnd,
      },
    });
  });

  log.info(
    { userId: userSub.userId, productId, credits: plan.creditsPerMonth },
    'App Store subscription renewed',
  );
}

async function handleRefund(originalTransactionId: string, productId: string): Promise<void> {
  const eventId = `refund_${originalTransactionId}`;

  const existing = await prisma.appStoreEvent.findUnique({
    where: { originalTransactionId: eventId },
  });
  if (existing) {
    log.debug({ originalTransactionId }, 'Refund already processed');
    return;
  }

  // Find the original purchase event
  const originalEvent = await prisma.appStoreEvent.findUnique({
    where: { originalTransactionId },
  });

  if (!originalEvent) {
    log.warn({ originalTransactionId }, 'Original transaction not found for refund');
    return;
  }

  // Find the credit pack to determine refund amount
  const pack = await prisma.creditPack.findUnique({
    where: { appStoreProductId: productId },
  });

  if (!pack) {
    log.warn({ productId }, 'Credit pack not found for refund');
    return;
  }

  // Find the user who made the purchase via credit transaction
  const originalTx = await prisma.creditTransaction.findFirst({
    where: {
      type: 'IAP_PURCHASE',
      description: { contains: pack.name },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!originalTx) {
    log.warn({ productId }, 'Original credit transaction not found for refund');
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.appStoreEvent.create({
      data: {
        originalTransactionId: eventId,
        type: 'REFUND',
        productId,
      },
    });

    const updated = await tx.user.update({
      where: { id: originalTx.userId },
      data: { permanentCredits: { decrement: pack.credits } },
      select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
    });

    const balanceAfter = updated.permanentCredits + updated.subscriptionCredits - updated.reservedCredits;

    await tx.creditTransaction.create({
      data: {
        userId: originalTx.userId,
        type: 'IAP_REFUND',
        amount: -pack.credits,
        wallet: 'PERMANENT',
        balanceAfter,
        description: `App Store refund: ${pack.name} (-${pack.credits} credits)`,
      },
    });
  });

  log.info(
    { userId: originalTx.userId, productId, credits: pack.credits },
    'App Store refund processed',
  );
}

async function handleRevoke(originalTransactionId: string): Promise<void> {
  const userSub = await prisma.userSubscription.findFirst({
    where: { appStoreOriginalTransactionId: originalTransactionId },
  });

  if (!userSub) {
    log.debug({ originalTransactionId }, 'No subscription found for revocation');
    return;
  }

  await prisma.userSubscription.update({
    where: { id: userSub.id },
    data: { status: 'CANCELLED' },
  });

  log.info(
    { userId: userSub.userId, originalTransactionId },
    'App Store subscription revoked',
  );
}
