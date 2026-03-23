# DevGhost Monetization Design

**Date**: 2026-02-25
**Status**: Reviewed — findings addressed (v3)

## Overview

Credit-based monetization system for DevGhost. 1 commit processed = 1 credit consumed. Users get free credits on registration, can buy credit packs (one-time) or subscriptions (monthly, 2x value), and redeem promo codes. Referral program doubles signup bonus for invited users and rewards the referrer.

## Core Concepts

- **1 commit = 1 credit** regardless of evaluation method (LLM, FD hybrid, FD fallback, cheap signals)
- **Cached commits are free** — cross-order cache hits (same commit+model already analyzed) cost 0 credits
- **Two wallets**: permanent credits (never expire) and subscription credits (expire at period end)
- **Debit priority**: subscription credits first (with expiry guard), then permanent
- **Credit reservation** on analysis start — estimated credits are reserved, released on completion
- **Stripe** for payments (Checkout for packs, Subscriptions for recurring)
- **Webhook idempotency** — all Stripe events deduplicated by event ID
- **Promo codes** created by admin, one-time per user, with expiry, atomic redemption
- **Referral program** with configurable limits

## Data Model

### User (extended fields)

```prisma
model User {
  // ... existing fields ...

  // Credit wallets
  permanentCredits     Int       @default(0)
  subscriptionCredits  Int       @default(0)
  reservedCredits      Int       @default(0)  // held for in-progress analyses
  subscriptionExpiresAt DateTime?

  // Stripe
  stripeCustomerId     String?   @unique

  // Referral
  referralCode         String    @unique  // auto-generated, 8 chars alphanumeric
  referredByUserId     String?
  referredByUser       User?     @relation("Referrals", fields: [referredByUserId], references: [id])
  referrals            User[]    @relation("Referrals")

  // Relations
  creditTransactions   CreditTransaction[]
  userSubscription     UserSubscription?
  promoRedemptions     PromoRedemption[]
  referralsMade        Referral[] @relation("Referrer")
  referralsReceived    Referral[] @relation("Referred")
}
```

### CreditTransaction

```prisma
enum CreditTransactionType {
  REGISTRATION
  PACK_PURCHASE
  SUBSCRIPTION_RENEWAL
  SUBSCRIPTION_EXPIRY
  PROMO_REDEMPTION
  REFERRAL_BONUS        // new user gets 2x
  REFERRAL_REWARD       // referrer gets 1x
  ANALYSIS_RESERVE      // credits reserved on analysis start
  ANALYSIS_DEBIT        // reserved → consumed (per commit)
  ANALYSIS_RELEASE      // unused reserved credits returned
  ADMIN_ADJUSTMENT
}

enum WalletType {
  PERMANENT
  SUBSCRIPTION
}

model CreditTransaction {
  id              String                @id @default(cuid())
  userId          String
  user            User                  @relation(fields: [userId], references: [id], onDelete: Cascade)
  type            CreditTransactionType
  amount          Int                   // positive = credit, negative = debit
  wallet          WalletType
  balanceAfter    Int                   // wallet balance after this transaction
  description     String?

  // Optional references
  relatedOrderId  String?
  relatedPromoId  String?
  stripePaymentId String?
  stripeEventId   String?               // for idempotency tracking

  createdAt       DateTime              @default(now())

  @@index([userId])
  @@index([userId, createdAt])
  @@index([type])
}
```

### CreditPack

```prisma
model CreditPack {
  id            String   @id @default(cuid())
  name          String                    // "Starter", "Pro", "Business"
  credits       Int
  priceUsd      Decimal  @db.Decimal(8, 2)
  stripePriceId String   @unique
  isActive      Boolean  @default(true)
  sortOrder     Int      @default(0)

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
```

### Subscription & UserSubscription

```prisma
model Subscription {
  id              String   @id @default(cuid())
  name            String                    // "Basic", "Pro", "Business"
  creditsPerMonth Int
  priceUsd        Decimal  @db.Decimal(8, 2)
  stripePriceId   String   @unique
  isActive        Boolean  @default(true)
  sortOrder       Int      @default(0)

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  userSubscriptions UserSubscription[]
}

enum SubscriptionStatus {
  ACTIVE
  PAST_DUE
  CANCELLED
  EXPIRED
}

model UserSubscription {
  id                   String             @id @default(cuid())
  userId               String             @unique
  user                 User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  subscriptionId       String
  subscription         Subscription       @relation(fields: [subscriptionId], references: [id])
  stripeSubscriptionId String             @unique
  status               SubscriptionStatus @default(ACTIVE)
  currentPeriodStart   DateTime
  currentPeriodEnd     DateTime

  createdAt            DateTime           @default(now())
  updatedAt            DateTime           @updatedAt

  @@index([userId])
}
```

### PromoCode & PromoRedemption

```prisma
model PromoCode {
  id              String   @id @default(cuid())
  code            String   @unique
  credits         Int
  maxRedemptions  Int?                      // null = unlimited
  redemptionCount Int      @default(0)
  expiresAt       DateTime
  isActive        Boolean  @default(true)
  description     String?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  redemptions     PromoRedemption[]
}

model PromoRedemption {
  id          String    @id @default(cuid())
  promoCodeId String
  promoCode   PromoCode @relation(fields: [promoCodeId], references: [id])
  userId      String
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  redeemedAt  DateTime  @default(now())

  @@unique([promoCodeId, userId])  // one code per user
  @@index([userId])
}
```

### StripeEvent (idempotency)

```prisma
model StripeEvent {
  id          String   @id                   // Stripe event ID (evt_...)
  type        String                         // e.g. "checkout.session.completed"
  processedAt DateTime @default(now())

  @@index([type])
}
```

### Referral

```prisma
model Referral {
  id             String   @id @default(cuid())
  referrerId     String
  referrer       User     @relation("Referrer", fields: [referrerId], references: [id])
  referredId     String   @unique  // one referrer per user
  referred       User     @relation("Referred", fields: [referredId], references: [id])
  creditsAwarded Int                // credits given to referrer

  createdAt      DateTime @default(now())

  @@index([referrerId])
}
```

### SystemSettings (extended)

```prisma
model SystemSettings {
  // ... existing fields ...

  // Monetization
  defaultFreeCredits      Int @default(100)
  referralBonusMultiplier Int @default(2)   // new user gets N * defaultFreeCredits
  maxReferralsPerUser     Int @default(20)
}
```

### AnalysisJob (extended fields)

```prisma
model AnalysisJob {
  // ... existing fields ...

  // Credit reservation (per-job tracking)
  creditsReserved  Int @default(0)  // how many credits were reserved for this job
  creditsConsumed  Int @default(0)  // how many actually debited (incremented per commit)
  creditsReleased  Int @default(0)  // how many returned after completion/failure
}
```

**Invariant**: For any active job, `creditsConsumed + creditsReleased <= creditsReserved`.
**Invariant**: `User.reservedCredits = SUM(creditsReserved - creditsConsumed - creditsReleased)` across all active jobs.

### OrderStatus (extended)

```prisma
enum OrderStatus {
  DRAFT
  DEVELOPERS_LOADED
  READY_FOR_ANALYSIS
  PROCESSING
  COMPLETED
  FAILED
  INSUFFICIENT_CREDITS  // new — analysis paused, can resume after top-up
}
```

## Credit Flow

### Expiry Guard

Before any balance read or debit, check subscription expiry:

```
if (subscriptionExpiresAt != null && subscriptionExpiresAt <= now()):
  expired = subscriptionCredits
  subscriptionCredits = 0
  subscriptionExpiresAt = null
  create CreditTransaction(SUBSCRIPTION_EXPIRY, -expired, SUBSCRIPTION)
```

This runs inline (not via cron) — guarantees expired credits are never spent.

### Debit Priority

After expiry guard:
```
1. subscriptionCredits > 0 → debit from subscription wallet
2. else permanentCredits > 0 → debit from permanent wallet
3. else → reject / pause analysis
```

### Available Balance

```
availableCredits = permanentCredits + subscriptionCredits - reservedCredits
```

`reservedCredits` holds credits locked by in-progress analyses. Users see available balance, not raw wallet totals.

### Pre-analysis Check & Reservation

Before `POST /api/orders/[id]/analyze`:
1. Estimate billable commits: total commits in scope minus already-analyzed (`lastAnalyzedShas`) minus cross-order cache hits (same commitHash+llmModel in CommitAnalysis)
2. Compare estimated count with `availableCredits`
3. If insufficient → return error with deficit, suggest purchase
4. If sufficient → show preview "~N credits will be used (estimate)", reserve credits:

```sql
BEGIN TRANSACTION;
  -- Expiry guard
  UPDATE "User" SET "subscriptionCredits" = 0, "subscriptionExpiresAt" = NULL
    WHERE id = $1 AND "subscriptionExpiresAt" <= NOW() AND "subscriptionCredits" > 0;

  -- Reserve on User (atomic check against available balance)
  UPDATE "User" SET "reservedCredits" = "reservedCredits" + $estimated
    WHERE id = $1
    AND ("permanentCredits" + "subscriptionCredits" - "reservedCredits") >= $estimated;
  -- If 0 rows affected → insufficient balance, abort

  -- Record reservation on the specific job
  UPDATE "AnalysisJob" SET "creditsReserved" = $estimated
    WHERE id = $jobId;

  INSERT INTO "CreditTransaction" (type, amount, wallet, "relatedOrderId", ...)
    VALUES ('ANALYSIS_RESERVE', -$estimated, 'PERMANENT', $orderId, ...);
COMMIT;
```

### Per-commit Debit (in pipeline)

Each processed commit — atomic debit of 1 credit, bounded by the job's reservation:

```sql
BEGIN TRANSACTION;
  -- Expiry guard
  UPDATE "User" SET "subscriptionCredits" = 0, "subscriptionExpiresAt" = NULL
    WHERE id = $1 AND "subscriptionExpiresAt" <= NOW() AND "subscriptionCredits" > 0;

  -- Check job still has reserved budget
  -- This is the critical guard: debit is bounded by this job's reservation
  UPDATE "AnalysisJob" SET "creditsConsumed" = "creditsConsumed" + 1
    WHERE id = $jobId AND "creditsConsumed" < "creditsReserved";
  -- If 0 rows affected → job's reservation exhausted, stop analysis

  -- Debit from wallets (subscription first, fallback to permanent)
  -- Single UPDATE with CASE expression — exactly one wallet is decremented
  WITH wallet_choice AS (
    SELECT
      CASE WHEN "subscriptionCredits" > 0 THEN 'SUBSCRIPTION'
           ELSE 'PERMANENT'
      END AS target
    FROM "User" WHERE id = $1
  )
  UPDATE "User" SET
    "subscriptionCredits" = CASE WHEN (SELECT target FROM wallet_choice) = 'SUBSCRIPTION'
                            THEN "subscriptionCredits" - 1 ELSE "subscriptionCredits" END,
    "permanentCredits" = CASE WHEN (SELECT target FROM wallet_choice) = 'PERMANENT'
                         THEN "permanentCredits" - 1 ELSE "permanentCredits" END,
    "reservedCredits" = "reservedCredits" - 1
  WHERE id = $1 AND ("subscriptionCredits" > 0 OR "permanentCredits" > 0);
  -- If 0 rows affected → wallet empty (shouldn't happen if reservation was correct)

  INSERT INTO "CreditTransaction" (type, amount, wallet, "relatedOrderId", ...)
    VALUES ('ANALYSIS_DEBIT', -1, (SELECT target FROM wallet_choice), $orderId, ...);
COMMIT;
```

**Cached commits** (cross-order cache hit): no wallet debit. Instead:
```sql
UPDATE "AnalysisJob" SET "creditsConsumed" = "creditsConsumed" -- no change
  WHERE id = $jobId;
UPDATE "User" SET "reservedCredits" = "reservedCredits" - 1
  WHERE id = $1;
-- Release 1 credit back to available pool (reservation was overestimate)
```

**Job reservation exhausted** mid-analysis (`creditsConsumed >= creditsReserved`):
→ set order status to `INSUFFICIENT_CREDITS`. User tops up, a new reservation is made for remaining commits, analysis resumes via `lastAnalyzedShas`.

### Post-analysis Release

When analysis completes, fails, or is cancelled — release unused reserved credits:

```sql
BEGIN TRANSACTION;
  -- Calculate unused
  -- unused = creditsReserved - creditsConsumed - creditsReleased (idempotent)
  UPDATE "AnalysisJob" SET
    "creditsReleased" = "creditsReserved" - "creditsConsumed"
    WHERE id = $jobId AND "creditsReleased" = 0;  -- idempotent guard

  UPDATE "User" SET
    "reservedCredits" = "reservedCredits" - $unused
    WHERE id = $1;

  INSERT INTO "CreditTransaction" (type, amount, wallet, "relatedOrderId", ...)
    VALUES ('ANALYSIS_RELEASE', +$unused, 'PERMANENT', $orderId, ...);
COMMIT;
```

**Invariants** (enforced by application, verifiable by audit query):
- `User.reservedCredits >= 0` always
- `User.reservedCredits = SUM(job.creditsReserved - job.creditsConsumed - job.creditsReleased)` for all RUNNING/PENDING jobs
- `job.creditsConsumed <= job.creditsReserved`
- `job.creditsConsumed + job.creditsReleased <= job.creditsReserved`

### Registration Flow

```
if (referralCode present && referrer exists && referrer under limit):
  newUser.permanentCredits = defaultFreeCredits * referralBonusMultiplier  // 200
  referrer.permanentCredits += defaultFreeCredits                         // 100
  create Referral record
  create CreditTransaction(REFERRAL_BONUS) for new user
  create CreditTransaction(REFERRAL_REWARD) for referrer
else:
  newUser.permanentCredits = defaultFreeCredits                           // 100
  create CreditTransaction(REGISTRATION)
```

## Stripe Integration

### Webhook Idempotency

All webhook handlers use insert-first pattern to avoid TOCTOU race:

```typescript
// 1. Verify Stripe signature
// 2. Claim the event atomically (insert-first, not check-first)
try {
  await db.$transaction(async (tx) => {
    // INSERT will fail on unique PK if already processed — that's the lock
    await tx.stripeEvent.create({ data: { id: event.id, type: event.type } });

    // 3. Business logic runs inside the same transaction
    // ... credit wallet, create CreditTransaction, etc. ...
  });
} catch (err) {
  // Prisma P2002 = unique constraint violation → already processed
  if (err.code === 'P2002') {
    return NextResponse.json({ received: true }); // idempotent success
  }
  throw err;
}
```

**Why insert-first**: Two concurrent webhook deliveries both calling `findUnique` could both see "not found" and proceed. With insert-first, the unique PK on `StripeEvent.id` acts as a lock — exactly one transaction wins, the other gets P2002 and returns 200.

### Packs — One-time Payment

1. User selects pack → `POST /api/billing/checkout` → create Stripe Checkout Session (`mode: 'payment'`)
2. Redirect to Stripe → payment → redirect back
3. Webhook `checkout.session.completed` → (idempotent) credit permanentCredits, create CreditTransaction(PACK_PURCHASE)

### Subscriptions — Recurring

1. User selects plan → `POST /api/billing/subscribe` → Stripe Checkout Session (`mode: 'subscription'`)
2. Webhook `invoice.paid` → (idempotent):
   - Reset subscriptionCredits to 0 (expire old)
   - Create CreditTransaction(SUBSCRIPTION_EXPIRY) if old credits > 0
   - Set subscriptionCredits = plan.creditsPerMonth
   - Create CreditTransaction(SUBSCRIPTION_RENEWAL)
   - Update subscriptionExpiresAt = currentPeriodEnd
3. Webhook `customer.subscription.updated` → handle plan changes (see below)
4. Webhook `customer.subscription.deleted` → mark inactive, subscriptionCredits stay until expiry

### Upgrade / Downgrade

**Upgrade** (immediate, mid-period):
- Stripe prorates automatically. On `customer.subscription.updated`:
  - Detect new plan has more credits than old plan
  - Delta = newPlan.creditsPerMonth - oldPlan.creditsPerMonth
  - Add delta to subscriptionCredits immediately
  - Create CreditTransaction(SUBSCRIPTION_RENEWAL, +delta)
  - Update UserSubscription.subscriptionId to new plan

**Downgrade** (deferred, takes effect next period):
- Set Stripe subscription to change at period end (`proration_behavior: 'none'`)
- On `customer.subscription.updated`: update UserSubscription record, no credit changes
- On next `invoice.paid`: new (lower) credit amount applies

This avoids credit arbitrage: user can't upgrade, spend the delta, then downgrade for a refund.

### Webhooks Endpoint

`POST /api/billing/webhook` — verifies Stripe signature, routes by event type. All handlers idempotent via StripeEvent table.

### Environment Variables

```
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_...
```

## Promo Codes

### Mechanics

1. Admin creates promo code: code string, credits amount, expiry date, optional max redemptions
2. User enters code → `POST /api/billing/redeem`
3. Atomic redemption in a single transaction:

```typescript
await db.$transaction(async (tx) => {
  // Atomic conditional increment via raw SQL — field-to-field comparison
  // not expressible in Prisma Client, so we use $executeRaw
  const updated = await tx.$executeRaw`
    UPDATE "PromoCode"
    SET "redemptionCount" = "redemptionCount" + 1
    WHERE code = ${code}
      AND "isActive" = true
      AND "expiresAt" > NOW()
      AND ("maxRedemptions" IS NULL OR "redemptionCount" < "maxRedemptions")
  `;
  if (updated === 0) throw new Error('Invalid or exhausted promo code');

  // Fetch promo for credits amount
  const promo = await tx.promoCode.findUnique({ where: { code } });

  // @@unique([promoCodeId, userId]) prevents per-user double-redeem at DB level
  // If this throws P2002, the transaction rolls back (including the increment above)
  await tx.promoRedemption.create({ data: { promoCodeId: promo.id, userId } });

  // Credit permanent wallet
  await tx.user.update({
    where: { id: userId },
    data: { permanentCredits: { increment: promo.credits } }
  });

  await tx.creditTransaction.create({ ... });
});
```

Key protections:
- **Global limit**: `WHERE "redemptionCount" < "maxRedemptions"` in raw SQL — atomic field-to-field comparison, no race
- **Per-user uniqueness**: `@@unique([promoCodeId, userId])` — DB rejects duplicate, rolls back entire transaction
- **Expiry**: checked in the same UPDATE, not a separate read
- **Note**: raw SQL is necessary because Prisma Client cannot express `WHERE column < other_column` comparisons

### Code Format

Admin sets manually (e.g. `LAUNCH2026`, `FRIEND50`) or uses "generate random" button for bulk distribution.

## Pricing

### Credit Packs (one-time)

| Pack | Credits | Price | Per credit |
|------|---------|-------|------------|
| Starter | 500 | $9 | $0.018 |
| Pro | 2,000 | $29 | $0.0145 |
| Business | 10,000 | $99 | $0.0099 |

### Subscriptions (monthly, 2x value)

| Plan | Credits/mo | Price/mo | Per credit |
|------|------------|----------|------------|
| Basic | 1,000 | $9 | $0.009 |
| Pro | 4,000 | $29 | $0.00725 |
| Business | 20,000 | $99 | $0.00495 |

**Principle**: Same price, double the credits. Easy to communicate.

All prices configurable via Stripe Dashboard + CreditPack/Subscription tables.

### Free Tier

- Default: 100 credits on registration (configurable in SystemSettings)
- With referral: 200 credits (configurable multiplier)

## API Endpoints

### Billing (user-facing)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/billing/balance` | Balance breakdown: permanent, subscription, reserved, available, expiresAt |
| POST | `/api/billing/checkout` | Create Stripe Checkout for a pack |
| POST | `/api/billing/subscribe` | Create Stripe Checkout for a subscription |
| POST | `/api/billing/cancel-subscription` | Cancel active subscription |
| POST | `/api/billing/redeem` | Redeem promo code |
| GET | `/api/billing/transactions` | Transaction history (paginated) |
| POST | `/api/billing/webhook` | Stripe webhook handler |

### Referral (user-facing)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/referral` | Own ref code, stats (invited count, earned credits, limit) |

### Admin

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/promo-codes` | List promo codes |
| POST | `/api/admin/promo-codes` | Create promo code |
| PATCH | `/api/admin/promo-codes/[id]` | Edit / deactivate promo code |
| POST | `/api/admin/credits/adjust` | Manual credit adjustment for a user |
| GET | `/api/admin/billing/stats` | Revenue, credit usage, conversion stats |

### Modified Existing

| Method | Path | Change |
|--------|------|--------|
| POST | `/api/orders/[id]/analyze` | Add balance check before starting |
| POST | `/api/auth/register` | Handle `?ref=` param, credit bonuses |

## UI

### User — Header

Balance always visible in header (shows available, not raw totals):
```
Credits: 156 available (42 sub + 114 perm)
```
If analysis is running: `Credits: 56 available (100 reserved)`

### User — /billing Page

- Current balance breakdown
- Active subscription (plan, next renewal, cancel button)
- Credit packs (3 cards)
- Subscriptions (3 cards, "2x value" badge)
- Promo code input field
- Transaction history table with filters

### User — /referral Page (or section in /billing)

- Referral link with copy button (`/register?ref=abc123`)
- Stats: invited X of Y limit, earned N credits
- List of invited users (masked email, date)

### User — Analysis Flow

Before analysis start:
- "~N credits will be used. Balance: M"
- If insufficient: "Need K more credits" + "Buy pack" / "Subscribe" buttons

### Admin — /admin/promo-codes Page

- Table: code, credits, used/limit, expiry, status, actions
- Create/edit promo code form

### Admin — /admin/users (extended)

- "Balance" column in users table
- "Adjust credits" button in user profile

### Admin — /admin/billing Page (new)

- Revenue overview, credits sold, active subscriptions
- Charts

## Critical Test Scenarios

These must be covered by integration tests:

1. **Webhook retry idempotency** — same Stripe event ID delivered twice → credits applied only once
2. **Webhook out-of-order** — `invoice.paid` arrives before `checkout.session.completed` for initial subscription
3. **Concurrent debit** — two analyses running simultaneously for same user → no overdraft, correct wallet balances
4. **Concurrent promo redemption** — two requests to redeem same code at global limit → only one succeeds
5. **Subscription expiry boundary** — debit attempt when `subscriptionExpiresAt` is exactly now → expiry guard fires, falls through to permanent wallet
6. **Resume after INSUFFICIENT_CREDITS** — partial analysis, top up, resume → only unprocessed commits billed
7. **Cross-order cache** — commit already analyzed in another order → 0 credits consumed, reserved credits released
8. **Upgrade mid-period** — upgrade subscription → delta credits applied immediately, no double-counting
9. **Downgrade mid-period** — downgrade → current credits untouched, new plan applies next period
10. **Referral with maxed-out referrer** — referrer at maxReferralsPerUser → new user gets standard bonus, referrer gets nothing
11. **Reservation release on failure** — analysis fails mid-way → unused reserved credits returned to wallets
12. **Per-job reservation boundary** — job.creditsConsumed reaches job.creditsReserved → analysis pauses, doesn't overdraw from other jobs' reservations
13. **Concurrent analyses, separate reservations** — two jobs for same user, each with own reserve → neither can spend the other's allocation
14. **Webhook concurrent delivery** — same event ID delivered twice simultaneously → exactly one processes, other gets P2002 and returns 200
