import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { stripe, requireStripeConfigured, getOrCreateStripeCustomer } from '@/lib/stripe';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';

const log = billingLogger.child({ route: 'billing/subscribe' });

const schema = z.object({
  subscriptionId: z.string().min(1, 'Subscription ID is required'),
});

/**
 * POST /api/billing/subscribe
 *
 * Create a Stripe Checkout Session for a subscription plan.
 * Returns { url } for the client to redirect to Stripe.
 */
export async function POST(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

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

  const { subscriptionId } = parsed.data;

  try {
    // Look up subscription plan — must be active
    const plan = await prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });

    if (!plan || !plan.isActive) {
      return apiError('Subscription plan not found or inactive', 404);
    }

    // Check if user already has an active subscription
    const existingSub = await prisma.userSubscription.findUnique({
      where: { userId: session.user.id },
    });

    if (existingSub && existingSub.status === 'ACTIVE') {
      return apiError(
        'You already have an active subscription. Cancel it first or use the upgrade flow.',
        409,
      );
    }

    // Get or create Stripe customer
    const customerId = await getOrCreateStripeCustomer(
      session.user.id,
      session.user.email,
    );

    // Create Stripe Checkout Session for subscription
    const checkoutSession = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [
        {
          price: plan.stripePriceId,
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: {
          userId: session.user.id,
          subscriptionId: plan.id,
        },
      },
      metadata: {
        userId: session.user.id,
        subscriptionId: plan.id,
      },
      success_url: `${process.env.AUTH_URL}/billing?subscription=success`,
      cancel_url: `${process.env.AUTH_URL}/billing?subscription=cancelled`,
    });

    log.info(
      { userId: session.user.id, subscriptionId, sessionId: checkoutSession.id },
      'Checkout session created for subscription',
    );

    return apiResponse({ url: checkoutSession.url });
  } catch (err) {
    log.error(
      { err, userId: session.user.id, subscriptionId },
      'Failed to create subscription checkout session',
    );
    return apiError('Failed to create subscription checkout session', 500);
  }
}
