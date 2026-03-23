import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'admin/billing/stats' });

/**
 * GET /api/admin/billing/stats
 *
 * Aggregate billing statistics for the admin dashboard.
 */
export async function GET() {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  try {
    const [
      creditsSoldResult,
      creditsConsumedResult,
      activeSubscriptions,
      creditsInCirculationResult,
      recentTransactions,
    ] = await Promise.all([
      // Total credits sold (PACK_PURCHASE + SUBSCRIPTION_RENEWAL, positive amounts only)
      prisma.creditTransaction.aggregate({
        _sum: { amount: true },
        where: {
          type: { in: ['PACK_PURCHASE', 'SUBSCRIPTION_RENEWAL'] },
          amount: { gt: 0 },
        },
      }),

      // Total credits consumed (ANALYSIS_DEBIT — absolute value of negative amounts)
      prisma.creditTransaction.aggregate({
        _sum: { amount: true },
        where: {
          type: 'ANALYSIS_DEBIT',
        },
      }),

      // Active subscriptions count
      prisma.userSubscription.count({
        where: { status: 'ACTIVE' },
      }),

      // Credits in circulation (sum of all users' permanent + subscription)
      prisma.user.aggregate({
        _sum: {
          permanentCredits: true,
          subscriptionCredits: true,
        },
      }),

      // Recent transactions (last 50 across all users)
      prisma.creditTransaction.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          type: true,
          amount: true,
          wallet: true,
          balanceAfter: true,
          description: true,
          createdAt: true,
          user: {
            select: { email: true },
          },
        },
      }),
    ]);

    const totalCreditsSold = creditsSoldResult._sum.amount ?? 0;
    const totalCreditsConsumed = Math.abs(creditsConsumedResult._sum.amount ?? 0);
    const permanentInCirculation = creditsInCirculationResult._sum.permanentCredits ?? 0;
    const subscriptionInCirculation = creditsInCirculationResult._sum.subscriptionCredits ?? 0;
    const creditsInCirculation = permanentInCirculation + subscriptionInCirculation;

    return apiResponse({
      totalCreditsSold,
      totalCreditsConsumed,
      activeSubscriptions,
      creditsInCirculation,
      recentTransactions: recentTransactions.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        wallet: t.wallet,
        balanceAfter: t.balanceAfter,
        description: t.description,
        userEmail: t.user.email,
        createdAt: t.createdAt,
      })),
    });
  } catch (err) {
    log.error({ err }, 'Failed to fetch billing stats');
    return apiError('Failed to fetch billing stats', 500);
  }
}
