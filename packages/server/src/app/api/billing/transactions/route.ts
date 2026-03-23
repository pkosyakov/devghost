import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';
import type { Prisma } from '@prisma/client';

const log = billingLogger.child({ route: 'billing/transactions' });

/**
 * GET /api/billing/transactions
 *
 * Returns paginated credit transaction history for the authenticated user.
 *
 * Query params:
 *   page      - Page number (default: 1)
 *   pageSize  - Items per page (default: 20, max: 100)
 *   type      - Optional filter by CreditTransactionType
 */
export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const url = request.nextUrl;
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1') || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20') || 20),
  );
  const type = url.searchParams.get('type') ?? '';

  const where: Prisma.CreditTransactionWhereInput = {
    userId: session.user.id,
  };

  const VALID_TYPES = [
    'REGISTRATION', 'PACK_PURCHASE', 'SUBSCRIPTION_RENEWAL',
    'SUBSCRIPTION_EXPIRY', 'PROMO_REDEMPTION', 'REFERRAL_BONUS',
    'REFERRAL_REWARD', 'ANALYSIS_RESERVE', 'ANALYSIS_DEBIT',
    'ANALYSIS_RELEASE', 'ADMIN_ADJUSTMENT',
  ];

  if (type) {
    if (!VALID_TYPES.includes(type)) {
      return apiError('Invalid transaction type filter', 400);
    }
    where.type = type as Prisma.CreditTransactionWhereInput['type'];
  }

  try {
    const [transactions, total] = await Promise.all([
      prisma.creditTransaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          type: true,
          amount: true,
          wallet: true,
          balanceAfter: true,
          description: true,
          relatedOrderId: true,
          createdAt: true,
        },
      }),
      prisma.creditTransaction.count({ where }),
    ]);

    return apiResponse({
      transactions,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    log.error({ err, userId: session.user.id }, 'Failed to fetch transactions');
    return apiError('Failed to fetch transactions', 500);
  }
}
