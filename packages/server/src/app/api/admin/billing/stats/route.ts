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
      leakedReservations,
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

      // Billing health: terminal jobs with leaked reservations
      prisma.$queryRaw<[{ count: bigint; leaked: bigint }]>`
        SELECT
          COUNT(*)::bigint AS count,
          COALESCE(SUM("creditsReserved" - "creditsConsumed" - "creditsReleased"), 0)::bigint AS leaked
        FROM "AnalysisJob"
        WHERE status IN ('COMPLETED', 'FAILED_FATAL', 'FAILED', 'CANCELLED')
          AND "creditsReserved" > 0
          AND "creditsReserved" - "creditsConsumed" - "creditsReleased" > 0
      `,
    ]);

    const totalCreditsSold = creditsSoldResult._sum.amount ?? 0;
    const totalCreditsConsumed = Math.abs(creditsConsumedResult._sum.amount ?? 0);
    const permanentInCirculation = creditsInCirculationResult._sum.permanentCredits ?? 0;
    const subscriptionInCirculation = creditsInCirculationResult._sum.subscriptionCredits ?? 0;
    const creditsInCirculation = permanentInCirculation + subscriptionInCirculation;

    const leakedRow = leakedReservations[0];

    return apiResponse({
      totalCreditsSold,
      totalCreditsConsumed,
      activeSubscriptions,
      creditsInCirculation,
      billingHealth: {
        leakedReservationJobs: Number(leakedRow?.count ?? 0),
        leakedCreditsTotal: Number(leakedRow?.leaked ?? 0),
      },
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
