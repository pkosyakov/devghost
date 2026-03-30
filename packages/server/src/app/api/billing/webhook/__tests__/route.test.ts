import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

// Mock Stripe
vi.mock('@/lib/stripe', () => ({
  stripe: {
    webhooks: { constructEvent: vi.fn() },
    subscriptions: { retrieve: vi.fn() },
  },
}));

// Mock Prisma
vi.mock('@/lib/db', () => ({
  default: {
    $transaction: vi.fn(),
    stripeEvent: { create: vi.fn() },
    subscription: { findUnique: vi.fn() },
    userSubscription: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
    creditTransaction: { create: vi.fn() },
  },
}));

// Mock logger (suppress output)
vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { billingLogger: mockLogger };
});

import { POST } from '../route';
import { stripe } from '@/lib/stripe';
import prisma from '@/lib/db';

const mockedStripe = vi.mocked(stripe, true);
const mockedPrisma = vi.mocked(prisma, true);

// ── Helpers ──

function makeRequest(body = 'test-body') {
  return new Request('http://localhost/api/billing/webhook', {
    method: 'POST',
    body,
    headers: { 'stripe-signature': 'sig_test' },
  });
}

function makeStripeSub(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: 'sub_new_123',
    metadata: { userId: 'user1', subscriptionId: 'plan1' },
    current_period_start: 1700000000,
    current_period_end: 1702600000,
    items: { data: [] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function makeInvoicePaidEvent(eventId = 'evt_test', subId = 'sub_new_123'): Stripe.Event {
  return {
    id: eventId,
    type: 'invoice.paid',
    data: {
      object: {
        id: 'inv_123',
        parent: {
          subscription_details: {
            subscription: subId,
          },
        },
      },
    },
  } as unknown as Stripe.Event;
}

const PLAN = { id: 'plan1', name: 'Pro', creditsPerMonth: 100 };

function setupCommonMocks(event: Stripe.Event, stripeSub: Stripe.Subscription) {
  // Stripe mocks
  mockedStripe.webhooks.constructEvent.mockReturnValue(event);
  mockedStripe.subscriptions.retrieve.mockResolvedValue(stripeSub as any);

  // Transaction executes callback directly
  mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
  mockedPrisma.stripeEvent.create.mockResolvedValue({} as any);
  mockedPrisma.subscription.findUnique.mockResolvedValue(PLAN as any);
  mockedPrisma.creditTransaction.create.mockResolvedValue({} as any);
  mockedPrisma.user.update.mockResolvedValue({
    permanentCredits: 50,
    subscriptionCredits: 100,
    reservedCredits: 0,
  } as any);
}

// ── Tests ──

describe('handleInvoicePaid via POST', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
  });

  it('Path 1: renewal — finds existing by stripeSubscriptionId, updates period', async () => {
    const event = makeInvoicePaidEvent('evt_renewal');
    const stripeSub = makeStripeSub();
    setupCommonMocks(event, stripeSub);

    // Existing UserSubscription found by stripeSubscriptionId
    mockedPrisma.userSubscription.findUnique.mockResolvedValue({
      id: 'usub_1',
      userId: 'user1',
      stripeSubscriptionId: 'sub_new_123',
    } as any);
    // No old subscription credits to expire
    mockedPrisma.user.findUnique.mockResolvedValue({ subscriptionCredits: 0 } as any);

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(200);

    // Should update existing subscription record
    expect(mockedPrisma.userSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stripeSubscriptionId: 'sub_new_123' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );

    // Should NOT create a new UserSubscription
    expect(mockedPrisma.userSubscription.create).not.toHaveBeenCalled();

    // Should set new credits on user
    expect(mockedPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user1' },
        data: expect.objectContaining({ subscriptionCredits: 100 }),
      }),
    );

    // Should create SUBSCRIPTION_RENEWAL ledger entry
    expect(mockedPrisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user1',
        type: 'SUBSCRIPTION_RENEWAL',
        amount: 100,
        wallet: 'SUBSCRIPTION',
      }),
    });
  });

  it('Path 2: re-subscription — cancelled record exists, updates with new Stripe sub ID', async () => {
    const stripeSub = makeStripeSub({ id: 'sub_new_456' });
    const event = makeInvoicePaidEvent('evt_resub', 'sub_new_456');
    setupCommonMocks(event, stripeSub);
    mockedStripe.subscriptions.retrieve.mockResolvedValue(stripeSub as any);

    // NOT found by stripeSubscriptionId (new Stripe sub ID)
    mockedPrisma.userSubscription.findUnique
      .mockResolvedValueOnce(null)  // first call: by stripeSubscriptionId → not found
      .mockResolvedValueOnce({      // second call: by userId → found (cancelled record)
        id: 'usub_old',
        userId: 'user1',
        stripeSubscriptionId: 'sub_old_789',
        status: 'CANCELLED',
      } as any);

    // User has 30 leftover subscription credits from old period
    mockedPrisma.user.findUnique.mockResolvedValue({ subscriptionCredits: 30 } as any);

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(200);

    // Should expire old subscription credits
    expect(mockedPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user1' },
        data: { subscriptionCredits: 0 },
      }),
    );
    expect(mockedPrisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user1',
        type: 'SUBSCRIPTION_EXPIRY',
        amount: -30,
        wallet: 'SUBSCRIPTION',
      }),
    });

    // Should update existing record (by userId) with NEW stripeSubscriptionId
    expect(mockedPrisma.userSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user1' },
        data: expect.objectContaining({
          stripeSubscriptionId: 'sub_new_456',
          status: 'ACTIVE',
        }),
      }),
    );

    // Should NOT create a new UserSubscription
    expect(mockedPrisma.userSubscription.create).not.toHaveBeenCalled();

    // Should set new credits
    expect(mockedPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user1' },
        data: expect.objectContaining({ subscriptionCredits: 100 }),
      }),
    );
  });

  it('Path 3: first-time subscription — creates new UserSubscription', async () => {
    const event = makeInvoicePaidEvent('evt_first');
    const stripeSub = makeStripeSub();
    setupCommonMocks(event, stripeSub);

    // No existing UserSubscription at all
    mockedPrisma.userSubscription.findUnique
      .mockResolvedValueOnce(null)   // by stripeSubscriptionId
      .mockResolvedValueOnce(null);  // by userId

    // No old credits
    mockedPrisma.user.findUnique.mockResolvedValue({ subscriptionCredits: 0 } as any);

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(200);

    // Should CREATE a new UserSubscription
    expect(mockedPrisma.userSubscription.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user1',
        subscriptionId: 'plan1',
        stripeSubscriptionId: 'sub_new_123',
        status: 'ACTIVE',
      }),
    });

    // Should NOT update any existing UserSubscription
    expect(mockedPrisma.userSubscription.update).not.toHaveBeenCalled();

    // Should set new credits and create ledger entry
    expect(mockedPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user1' },
        data: expect.objectContaining({ subscriptionCredits: 100 }),
      }),
    );
    expect(mockedPrisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'SUBSCRIPTION_RENEWAL',
        description: expect.stringContaining('Subscription started'),
      }),
    });
  });

  it('idempotency — duplicate event returns 200 without reprocessing', async () => {
    const event = makeInvoicePaidEvent('evt_dup');
    const stripeSub = makeStripeSub();
    mockedStripe.webhooks.constructEvent.mockReturnValue(event);
    mockedStripe.subscriptions.retrieve.mockResolvedValue(stripeSub as any);

    // Simulate P2002 on StripeEvent PK (already processed)
    mockedPrisma.$transaction.mockRejectedValue(
      Object.assign(new Error('Unique constraint'), {
        code: 'P2002',
        meta: { target: ['StripeEvent_pkey'] },
      }),
    );

    const res = await POST(makeRequest() as any);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.received).toBe(true);
  });
});
