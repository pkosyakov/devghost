import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';
import type Stripe from 'stripe';
import type { Prisma } from '@prisma/client';

const log = billingLogger.child({ route: 'billing/webhook' });

function getSubscriptionPeriod(sub: Stripe.Subscription): { start: Date; end: Date } {
  const item = sub.items.data[0];
  return {
    start: item ? new Date(item.current_period_start * 1000) : new Date(),
    end: item ? new Date(item.current_period_end * 1000) : new Date(),
  };
}

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    log.error('STRIPE_WEBHOOK_SECRET is not configured');
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    log.error({ err }, 'Webhook signature verification failed');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  try {
    // Pre-fetch Stripe data outside the transaction to avoid holding DB locks
    // during external API calls (C2 fix)
    let prefetchedStripeSub: Stripe.Subscription | null = null;
    if (event.type === 'invoice.paid') {
      const invoice = event.data.object as Stripe.Invoice;
      const parentSub = invoice.parent?.subscription_details?.subscription;
      const subId = typeof parentSub === 'string' ? parentSub : parentSub?.id;
      if (subId) {
        prefetchedStripeSub = await stripe.subscriptions.retrieve(subId);
      }
    }

    await prisma.$transaction(async (tx) => {
      // Insert-first idempotency — PK on StripeEvent.id acts as lock
      await tx.stripeEvent.create({
        data: { id: event.id, type: event.type },
      });

      // Route to handler
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutCompleted(tx, event);
          break;
        case 'invoice.paid':
          await handleInvoicePaid(tx, event, prefetchedStripeSub);
          break;
        case 'customer.subscription.updated':
          await handleSubscriptionUpdated(tx, event);
          break;
        case 'customer.subscription.deleted':
          await handleSubscriptionDeleted(tx, event);
          break;
        default:
          log.debug({ type: event.type }, 'Unhandled webhook event type');
      }
    });
  } catch (err: unknown) {
    // P2002 on StripeEvent PK = already processed (idempotent)
    // IMPORTANT: check meta.target to avoid swallowing unrelated unique violations
    const prismaErr = err as { code?: string; meta?: { target?: string[] } };
    if (
      prismaErr?.code === 'P2002' &&
      prismaErr?.meta?.target?.includes('StripeEvent_pkey')
    ) {
      log.debug({ eventId: event.id }, 'Webhook event already processed');
      return NextResponse.json({ received: true });
    }
    log.error({ err, eventId: event.id }, 'Webhook processing failed');
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// ---------------------------------------------------------------------------
// Checkout completed — credit pack purchase
// ---------------------------------------------------------------------------

async function handleCheckoutCompleted(
  tx: Prisma.TransactionClient,
  event: Stripe.Event,
): Promise<void> {
  const session = event.data.object as Stripe.Checkout.Session;

  // Only handle one-time payments (credit packs)
  if (session.mode !== 'payment') {
    log.debug({ mode: session.mode, sessionId: session.id }, 'Skipping non-payment checkout');
    return;
  }

  const userId = session.metadata?.userId;
  const packId = session.metadata?.packId;

  if (!userId || !packId) {
    log.warn({ sessionId: session.id, metadata: session.metadata }, 'Checkout missing metadata');
    return;
  }

  // Look up pack
  const pack = await tx.creditPack.findUnique({ where: { id: packId } });
  if (!pack) {
    log.error({ packId, sessionId: session.id }, 'Credit pack not found');
    return;
  }

  // Credit permanent wallet
  const updatedUser = await tx.user.update({
    where: { id: userId },
    data: { permanentCredits: { increment: pack.credits } },
    select: {
      permanentCredits: true,
      subscriptionCredits: true,
      reservedCredits: true,
    },
  });

  const balanceAfter =
    updatedUser.permanentCredits +
    updatedUser.subscriptionCredits -
    updatedUser.reservedCredits;

  await tx.creditTransaction.create({
    data: {
      userId,
      type: 'PACK_PURCHASE',
      amount: pack.credits,
      wallet: 'PERMANENT',
      balanceAfter,
      stripePaymentId: session.payment_intent as string | null,
      stripeEventId: event.id,
      description: `Purchased credit pack: ${pack.name} (${pack.credits} credits)`,
    },
  });

  log.info(
    { userId, packId, credits: pack.credits, sessionId: session.id },
    'Credit pack purchase completed',
  );
}

// ---------------------------------------------------------------------------
// Invoice paid — subscription renewal or first payment
// ---------------------------------------------------------------------------

/**
 * Shared logic for all subscription credit flows (renewal, re-subscription, first-time).
 * Expires old subscription credits if any, sets new credits, and logs a ledger entry.
 */
async function applySubscriptionCredits(
  tx: Prisma.TransactionClient,
  userId: string,
  plan: { id: string; name: string; creditsPerMonth: number },
  periodEnd: Date,
  eventId: string,
  description: string,
): Promise<void> {
  // Expire old subscription credits if any remain
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { subscriptionCredits: true },
  });

  if (user && user.subscriptionCredits > 0) {
    await tx.user.update({
      where: { id: userId },
      data: { subscriptionCredits: 0 },
    });
    await tx.creditTransaction.create({
      data: {
        userId,
        type: 'SUBSCRIPTION_EXPIRY',
        amount: -user.subscriptionCredits,
        wallet: 'SUBSCRIPTION',
        balanceAfter: 0,
        stripeEventId: eventId,
        description: `Subscription credits expired (${user.subscriptionCredits} credits)`,
      },
    });
  }

  // Set new subscription credits
  const updatedUser = await tx.user.update({
    where: { id: userId },
    data: {
      subscriptionCredits: plan.creditsPerMonth,
      subscriptionExpiresAt: periodEnd,
    },
    select: {
      permanentCredits: true,
      subscriptionCredits: true,
      reservedCredits: true,
    },
  });

  const balanceAfter =
    updatedUser.permanentCredits +
    updatedUser.subscriptionCredits -
    updatedUser.reservedCredits;

  await tx.creditTransaction.create({
    data: {
      userId,
      type: 'SUBSCRIPTION_RENEWAL',
      amount: plan.creditsPerMonth,
      wallet: 'SUBSCRIPTION',
      balanceAfter,
      stripeEventId: eventId,
      description,
    },
  });
}

async function handleInvoicePaid(
  tx: Prisma.TransactionClient,
  event: Stripe.Event,
  prefetchedStripeSub: Stripe.Subscription | null,
): Promise<void> {
  const stripeSub = prefetchedStripeSub;
  if (!stripeSub) {
    const invoice = event.data.object as Stripe.Invoice;
    log.debug({ invoiceId: invoice.id }, 'Invoice has no subscription, skipping');
    return;
  }

  const stripeSubscriptionId = stripeSub.id;
  const userId = stripeSub.metadata?.userId;
  const subscriptionId = stripeSub.metadata?.subscriptionId;

  if (!userId || !subscriptionId) {
    log.warn(
      { stripeSubscriptionId, metadata: stripeSub.metadata },
      'Subscription missing metadata',
    );
    return;
  }

  // Find the DevGhost subscription plan
  const plan = await tx.subscription.findUnique({ where: { id: subscriptionId } });
  if (!plan) {
    log.error({ subscriptionId }, 'Subscription plan not found');
    return;
  }

  const { start: periodStart, end: periodEnd } = getSubscriptionPeriod(stripeSub);

  // Check if UserSubscription already exists for this stripe subscription
  const existing = await tx.userSubscription.findUnique({
    where: { stripeSubscriptionId },
  });

  if (existing) {
    // Path 1: Renewal — same Stripe subscription, new period
    await tx.userSubscription.update({
      where: { stripeSubscriptionId },
      data: {
        subscriptionId: plan.id,
        status: 'ACTIVE',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    });

    await applySubscriptionCredits(
      tx, userId, plan, periodEnd, event.id,
      `Subscription renewed: ${plan.name} (${plan.creditsPerMonth} credits)`,
    );

    log.info(
      { userId, subscriptionId: plan.id, credits: plan.creditsPerMonth },
      'Subscription renewed',
    );
  } else {
    // Check if user already has a UserSubscription (re-subscription after cancellation)
    const existingByUser = await tx.userSubscription.findUnique({
      where: { userId },
    });

    if (existingByUser) {
      // Path 2: Re-subscription — cancelled record exists, update with new Stripe subscription
      await tx.userSubscription.update({
        where: { userId },
        data: {
          subscriptionId: plan.id,
          stripeSubscriptionId,
          status: 'ACTIVE',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      });

      await applySubscriptionCredits(
        tx, userId, plan, periodEnd, event.id,
        `Re-subscription started: ${plan.name} (${plan.creditsPerMonth} credits)`,
      );

      log.info(
        { userId, subscriptionId: plan.id, credits: plan.creditsPerMonth, stripeSubscriptionId },
        'Re-subscription created (updated existing UserSubscription)',
      );
    } else {
      // Path 3: Truly first-time subscription — create UserSubscription
      await tx.userSubscription.create({
        data: {
          userId,
          subscriptionId: plan.id,
          stripeSubscriptionId,
          status: 'ACTIVE',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      });

      await applySubscriptionCredits(
        tx, userId, plan, periodEnd, event.id,
        `Subscription started: ${plan.name} (${plan.creditsPerMonth} credits)`,
      );

      log.info(
        { userId, subscriptionId: plan.id, credits: plan.creditsPerMonth, stripeSubscriptionId },
        'New subscription created',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Subscription updated — upgrade/downgrade detection
// ---------------------------------------------------------------------------

async function handleSubscriptionUpdated(
  tx: Prisma.TransactionClient,
  event: Stripe.Event,
): Promise<void> {
  const stripeSub = event.data.object as Stripe.Subscription;
  const previousAttributes = (event.data as { previous_attributes?: Record<string, unknown> })
    .previous_attributes;

  const userId = stripeSub.metadata?.userId;
  const subscriptionId = stripeSub.metadata?.subscriptionId;

  if (!userId || !subscriptionId) {
    log.debug({ stripeSubscriptionId: stripeSub.id }, 'Subscription update missing metadata');
    return;
  }

  // Find existing UserSubscription
  const userSub = await tx.userSubscription.findUnique({
    where: { stripeSubscriptionId: stripeSub.id },
    include: { subscription: true },
  });

  if (!userSub) {
    log.debug(
      { stripeSubscriptionId: stripeSub.id },
      'No UserSubscription found for update event',
    );
    return;
  }

  // Detect plan change: check if items/price changed
  const hasItemsChanged = previousAttributes && 'items' in previousAttributes;
  if (!hasItemsChanged) {
    // Not a plan change — might be a status change or other metadata update
    log.debug({ stripeSubscriptionId: stripeSub.id }, 'Subscription update without plan change');
    return;
  }

  // Find the new plan by stripePriceId
  const newPriceId = stripeSub.items.data[0]?.price?.id;
  if (!newPriceId) {
    log.warn({ stripeSubscriptionId: stripeSub.id }, 'Could not determine new price ID');
    return;
  }

  const newPlan = await tx.subscription.findUnique({
    where: { stripePriceId: newPriceId },
  });

  if (!newPlan) {
    log.error({ newPriceId }, 'New subscription plan not found for price');
    return;
  }

  const oldPlan = userSub.subscription;

  // Update UserSubscription to point to the new plan (including period dates)
  await tx.userSubscription.update({
    where: { id: userSub.id },
    data: {
      subscriptionId: newPlan.id,
      status: 'ACTIVE',
      currentPeriodStart: getSubscriptionPeriod(stripeSub).start,
      currentPeriodEnd: getSubscriptionPeriod(stripeSub).end,
    },
  });

  // Upgrade: immediate delta credit addition
  const creditDelta = newPlan.creditsPerMonth - oldPlan.creditsPerMonth;

  if (creditDelta > 0) {
    // Upgrade — add delta credits immediately
    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: {
        subscriptionCredits: { increment: creditDelta },
        subscriptionExpiresAt: getSubscriptionPeriod(stripeSub).end,
      },
      select: {
        permanentCredits: true,
        subscriptionCredits: true,
        reservedCredits: true,
      },
    });

    const balanceAfter =
      updatedUser.permanentCredits +
      updatedUser.subscriptionCredits -
      updatedUser.reservedCredits;

    await tx.creditTransaction.create({
      data: {
        userId,
        type: 'SUBSCRIPTION_RENEWAL',
        amount: creditDelta,
        wallet: 'SUBSCRIPTION',
        balanceAfter,
        stripeEventId: event.id,
        description: `Subscription upgraded: ${oldPlan.name} -> ${newPlan.name} (+${creditDelta} credits)`,
      },
    });

    log.info(
      { userId, oldPlan: oldPlan.name, newPlan: newPlan.name, creditDelta },
      'Subscription upgraded with immediate credit delta',
    );
  } else {
    // Downgrade — new amount takes effect on next invoice.paid
    log.info(
      { userId, oldPlan: oldPlan.name, newPlan: newPlan.name },
      'Subscription downgraded, new credits on next renewal',
    );
  }
}

// ---------------------------------------------------------------------------
// Subscription deleted — cancelled by Stripe (period ended)
// ---------------------------------------------------------------------------

async function handleSubscriptionDeleted(
  tx: Prisma.TransactionClient,
  event: Stripe.Event,
): Promise<void> {
  const stripeSub = event.data.object as Stripe.Subscription;

  const userSub = await tx.userSubscription.findUnique({
    where: { stripeSubscriptionId: stripeSub.id },
  });

  if (!userSub) {
    log.debug(
      { stripeSubscriptionId: stripeSub.id },
      'No UserSubscription found for deletion event',
    );
    return;
  }

  // Mark as cancelled — don't zero subscription credits;
  // they stay until expiry (the expiry guard in credit-service handles this)
  await tx.userSubscription.update({
    where: { id: userSub.id },
    data: { status: 'CANCELLED' },
  });

  log.info(
    { userId: userSub.userId, stripeSubscriptionId: stripeSub.id },
    'Subscription deleted/cancelled',
  );
}
