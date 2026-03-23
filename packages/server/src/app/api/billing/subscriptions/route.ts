import { apiResponse, apiError } from '@/lib/api-utils';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'billing/subscriptions' });

/**
 * GET /api/billing/subscriptions
 *
 * Returns all active subscription plans sorted by sortOrder.
 * Public endpoint (no auth required) — plans are displayed to all visitors.
 */
export async function GET() {
  try {
    const subscriptions = await prisma.subscription.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        creditsPerMonth: true,
        priceUsd: true,
        sortOrder: true,
      },
    });

    return apiResponse({ subscriptions });
  } catch (err) {
    log.error({ err }, 'Failed to fetch subscription plans');
    return apiError('Failed to fetch subscription plans', 500);
  }
}
