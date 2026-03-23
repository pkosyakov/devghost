import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { stripe, requireStripeConfigured, getOrCreateStripeCustomer } from '@/lib/stripe';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rate-limit';

const log = billingLogger.child({ route: 'billing/checkout' });

const schema = z.object({
  packId: z.string().min(1, 'Pack ID is required'),
});

/**
 * POST /api/billing/checkout
 *
 * Create a Stripe Checkout Session for a one-time credit pack purchase.
 * Returns { url } for the client to redirect to Stripe.
 */
export async function POST(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const rateLimited = await checkRateLimit(request, 'billing', session.user.id);
  if (rateLimited) return rateLimited;

  try {
    requireStripeConfigured();
  } catch {
    return apiError('Payment system is not configured', 503);
  }

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

  const { packId } = parsed.data;

  try {
    // Look up credit pack — must be active
    const pack = await prisma.creditPack.findUnique({
      where: { id: packId },
    });

    if (!pack || !pack.isActive) {
      return apiError('Credit pack not found or inactive', 404);
    }

    // Get or create Stripe customer
    const customerId = await getOrCreateStripeCustomer(
      session.user.id,
      session.user.email,
    );

    // Create Stripe Checkout Session
    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [
        {
          price: pack.stripePriceId,
          quantity: 1,
        },
      ],
      metadata: {
        userId: session.user.id,
        packId: pack.id,
      },
      success_url: `${process.env.AUTH_URL}/billing?checkout=success`,
      cancel_url: `${process.env.AUTH_URL}/billing?checkout=cancelled`,
    });

    log.info(
      { userId: session.user.id, packId, sessionId: checkoutSession.id },
      'Checkout session created for credit pack',
    );

    return apiResponse({ url: checkoutSession.url });
  } catch (err) {
    log.error({ err, userId: session.user.id, packId }, 'Failed to create checkout session');
    return apiError('Failed to create checkout session', 500);
  }
}
