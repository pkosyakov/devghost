import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { stripe, requireStripeConfigured } from '@/lib/stripe';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'billing/cancel-subscription' });

/**
 * POST /api/billing/cancel-subscription
 *
 * Gracefully cancel the user's subscription at end of current billing period.
 * Subscription credits remain available until subscriptionExpiresAt.
 */
export async function POST() {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  try {
    requireStripeConfigured();
  } catch {
    return apiError('Payment system is not configured', 503);
  }

  try {
    // Find user's active subscription
    const userSub = await prisma.userSubscription.findUnique({
      where: { userId: session.user.id },
      include: { subscription: true },
    });

    if (!userSub) {
      return apiError('No subscription found', 404);
    }

    if (userSub.status === 'CANCELLED') {
      return apiError('Subscription is already cancelled', 400);
    }

    // Cancel at period end via Stripe — graceful cancellation
    await stripe.subscriptions.update(userSub.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });

    // Update local status
    await prisma.userSubscription.update({
      where: { id: userSub.id },
      data: { status: 'CANCELLED' },
    });

    log.info(
      {
        userId: session.user.id,
        stripeSubscriptionId: userSub.stripeSubscriptionId,
        periodEnd: userSub.currentPeriodEnd,
      },
      'Subscription cancelled at period end',
    );

    return apiResponse({
      message: 'Subscription will be cancelled at the end of the current billing period',
      currentPeriodEnd: userSub.currentPeriodEnd,
    });
  } catch (err) {
    log.error(
      { err, userId: session.user.id },
      'Failed to cancel subscription',
    );
    return apiError('Failed to cancel subscription', 500);
  }
}
