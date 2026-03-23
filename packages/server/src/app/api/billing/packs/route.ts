import { apiResponse, apiError } from '@/lib/api-utils';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'billing/packs' });

/**
 * GET /api/billing/packs
 *
 * Returns all active credit packs sorted by sortOrder.
 * Public endpoint (no auth required) — packs are displayed to all visitors.
 */
export async function GET() {
  try {
    const packs = await prisma.creditPack.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        credits: true,
        priceUsd: true,
        sortOrder: true,
      },
    });

    return apiResponse({ packs });
  } catch (err) {
    log.error({ err }, 'Failed to fetch credit packs');
    return apiError('Failed to fetch credit packs', 500);
  }
}
