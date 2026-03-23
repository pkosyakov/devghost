import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { getAvailableBalance } from '@/lib/services/credit-service';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'billing/balance' });

/**
 * GET /api/billing/balance
 *
 * Returns the authenticated user's credit balance and active subscription info.
 */
export async function GET() {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  try {
    const [balance, subscription] = await Promise.all([
      getAvailableBalance(session.user.id),
      prisma.userSubscription.findUnique({
        where: { userId: session.user.id },
        include: {
          subscription: {
            select: { name: true, creditsPerMonth: true, priceUsd: true },
          },
        },
      }),
    ]);

    return apiResponse({
      balance,
      subscription: subscription
        ? {
            planName: subscription.subscription.name,
            creditsPerMonth: subscription.subscription.creditsPerMonth,
            priceUsd: subscription.subscription.priceUsd,
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }
        : null,
    });
  } catch (err) {
    log.error({ err, userId: session.user.id }, 'Failed to fetch balance');
    return apiError('Failed to fetch balance', 500);
  }
}
