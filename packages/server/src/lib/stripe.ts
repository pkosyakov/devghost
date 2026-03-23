import Stripe from 'stripe';
import prisma from '@/lib/db';
import type { Prisma } from '@prisma/client';

/**
 * Stripe client singleton.
 *
 * Uses a lazy-error pattern: the client is created with an empty key
 * if STRIPE_SECRET_KEY is missing, so it won't crash at import time
 * in dev/test environments. Call `requireStripeConfigured()` before
 * any Stripe API call to get a clear error.
 */
const key = process.env.STRIPE_SECRET_KEY || 'sk_not_configured';

export const stripe = new Stripe(key, {
  apiVersion: '2026-01-28.clover',
  typescript: true,
});

/** Throw if Stripe is not configured. Call before any Stripe API usage. */
export function requireStripeConfigured(): void {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
}

/**
 * Get or create a Stripe customer for the given user.
 * Stores the stripeCustomerId on the User record.
 *
 * @param userId - DevGhost user ID
 * @param email - User email for Stripe customer creation
 * @param tx - Optional Prisma transaction client (uses default prisma if not provided)
 * @returns Stripe customer ID
 */
export async function getOrCreateStripeCustomer(
  userId: string,
  email: string,
  tx?: Prisma.TransactionClient,
): Promise<string> {
  const db = tx ?? prisma;

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { stripeCustomerId: true, name: true },
  });

  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  if (user.stripeCustomerId) {
    return user.stripeCustomerId;
  }

  // Create Stripe customer
  const customer = await stripe.customers.create({
    email,
    name: user.name ?? undefined,
    metadata: { userId },
  });

  // Conditional update: only store if still null (race-safe).
  // Note: Concurrent first-purchase requests may create duplicate Stripe customers.
  // Only one is stored; the other becomes orphaned in Stripe. This is rare and acceptable —
  // clean up via Stripe Dashboard or cron if needed.
  const updated = await db.user.updateMany({
    where: { id: userId, stripeCustomerId: null },
    data: { stripeCustomerId: customer.id },
  });

  if (updated.count === 0) {
    // Another request already set it — read the winning value
    const refreshed = await db.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });
    return refreshed!.stripeCustomerId!;
  }

  return customer.id;
}
