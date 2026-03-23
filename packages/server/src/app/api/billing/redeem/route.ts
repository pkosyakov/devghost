import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { redeemPromoCode } from '@/lib/services/promo-service';
import { getAvailableBalance } from '@/lib/services/credit-service';
import { billingLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rate-limit';

const log = billingLogger.child({ route: 'billing/redeem' });

const schema = z.object({
  code: z.string().trim().min(1, 'Promo code is required').max(32),
});

export async function POST(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const rateLimited = await checkRateLimit(request, 'billing', session.user.id);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors.map((e) => e.message).join(', '), 400);
  }

  try {
    const result = await redeemPromoCode(session.user.id, parsed.data.code);
    const balance = await getAvailableBalance(session.user.id);

    return apiResponse({
      creditsAwarded: result.creditsAwarded,
      balance: {
        permanent: balance.permanent,
        subscription: balance.subscription,
        available: balance.available,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';

    // Known user-facing errors from promo-service
    if (
      message === 'Invalid or exhausted promo code' ||
      message === 'You have already redeemed this promo code'
    ) {
      return apiError(message, 400);
    }

    log.error({ err, userId: session.user.id, code: parsed.data.code }, 'Promo redemption failed');
    return apiError('Failed to redeem promo code', 500);
  }
}
