# Monetization System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement credit-based monetization with Stripe payments, promo codes, referrals, and per-commit billing.

**Architecture:** Two-wallet credit system (permanent + subscription) on User, per-job reservation tracking on AnalysisJob, Stripe Checkout for packs, Stripe Subscriptions for recurring plans. All critical paths use atomic transactions with raw SQL where Prisma Client is insufficient.

**Tech Stack:** Prisma 6.x, Stripe SDK (`stripe` npm), Next.js App Router API routes, Vitest, TanStack Query, shadcn/ui.

**Design doc:** `docs/plans/2026-02-25-monetization-design.md` (v3) — source of truth for data model, credit flow invariants, and pricing.

---

## Phase 1: Schema & Core Credit Service

### Task 1: Prisma Schema — New Billing Tables

**Files:**
- Modify: `packages/server/prisma/schema.prisma`

**Step 1: Add enums**

Add after the existing `AnalysisJobStatus` enum at the bottom of the file:

```prisma
// ==================== BILLING ====================

enum CreditTransactionType {
  REGISTRATION
  PACK_PURCHASE
  SUBSCRIPTION_RENEWAL
  SUBSCRIPTION_EXPIRY
  PROMO_REDEMPTION
  REFERRAL_BONUS
  REFERRAL_REWARD
  ANALYSIS_RESERVE
  ANALYSIS_DEBIT
  ANALYSIS_RELEASE
  ADMIN_ADJUSTMENT
}

enum WalletType {
  PERMANENT
  SUBSCRIPTION
}

enum SubscriptionStatus {
  ACTIVE
  PAST_DUE
  CANCELLED
  EXPIRED
}
```

**Step 2: Extend User model**

Add these fields to the existing `User` model (before the `createdAt` field):

```prisma
  // Credit wallets
  permanentCredits      Int       @default(0)
  subscriptionCredits   Int       @default(0)
  reservedCredits       Int       @default(0)
  subscriptionExpiresAt DateTime?

  // Stripe
  stripeCustomerId      String?   @unique

  // Referral
  referralCode          String    @unique @default(cuid())
  referredByUserId      String?
  referredByUser        User?     @relation("Referrals", fields: [referredByUserId], references: [id])
  referredUsers         User[]    @relation("Referrals")
```

And add these relations to the User model's `// Relations` section:

```prisma
  creditTransactions    CreditTransaction[]
  userSubscription      UserSubscription?
  promoRedemptions      PromoRedemption[]
  referralsMade         Referral[] @relation("Referrer")
  referralsReceived     Referral[] @relation("Referred")
```

**Step 3: Extend AnalysisJob model**

Add credit reservation fields to `AnalysisJob` (before `createdAt`):

```prisma
  // Credit reservation (per-job tracking)
  creditsReserved       Int       @default(0)
  creditsConsumed       Int       @default(0)
  creditsReleased       Int       @default(0)
```

**Step 4: Extend OrderStatus enum**

Add `INSUFFICIENT_CREDITS` to the existing `OrderStatus` enum:

```prisma
enum OrderStatus {
  DRAFT
  DEVELOPERS_LOADED
  READY_FOR_ANALYSIS
  PROCESSING
  COMPLETED
  FAILED
  INSUFFICIENT_CREDITS
}
```

**Step 5: Extend SystemSettings model**

Add monetization fields to the existing `SystemSettings` model:

```prisma
  // Monetization
  defaultFreeCredits      Int @default(100)
  referralBonusMultiplier Int @default(2)
  maxReferralsPerUser     Int @default(20)
```

**Step 6: Add new billing models**

Add all new models at the end of the schema file:

```prisma
// ==================== CREDIT TRANSACTION ====================

model CreditTransaction {
  id              String                @id @default(cuid())
  userId          String
  user            User                  @relation(fields: [userId], references: [id], onDelete: Cascade)
  type            CreditTransactionType
  amount          Int
  wallet          WalletType
  balanceAfter    Int
  description     String?

  relatedOrderId  String?
  relatedPromoId  String?
  stripePaymentId String?
  stripeEventId   String?

  createdAt       DateTime              @default(now())

  @@index([userId])
  @@index([userId, createdAt])
  @@index([type])
}

// ==================== CREDIT PACK ====================

model CreditPack {
  id            String   @id @default(cuid())
  name          String
  credits       Int
  priceUsd      Decimal  @db.Decimal(8, 2)
  stripePriceId String   @unique
  isActive      Boolean  @default(true)
  sortOrder     Int      @default(0)

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}

// ==================== SUBSCRIPTION ====================

model Subscription {
  id              String   @id @default(cuid())
  name            String
  creditsPerMonth Int
  priceUsd        Decimal  @db.Decimal(8, 2)
  stripePriceId   String   @unique
  isActive        Boolean  @default(true)
  sortOrder       Int      @default(0)

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  userSubscriptions UserSubscription[]
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

// ==================== PROMO CODE ====================

model PromoCode {
  id              String   @id @default(cuid())
  code            String   @unique
  credits         Int
  maxRedemptions  Int?
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

  @@unique([promoCodeId, userId])
  @@index([userId])
}

// ==================== STRIPE EVENT (Idempotency) ====================

model StripeEvent {
  id          String   @id
  type        String
  processedAt DateTime @default(now())

  @@index([type])
}

// ==================== REFERRAL ====================

model Referral {
  id             String   @id @default(cuid())
  referrerId     String
  referrer       User     @relation("Referrer", fields: [referrerId], references: [id])
  referredId     String   @unique
  referred       User     @relation("Referred", fields: [referredId], references: [id])
  creditsAwarded Int

  createdAt      DateTime @default(now())

  @@index([referrerId])
}
```

**Step 7: Push schema to database**

Run: `cd packages/server && pnpm db:push`
Expected: Schema synced, no errors.

**Step 8: Generate Prisma client**

Run: `cd packages/server && pnpm db:generate`
Expected: Prisma client regenerated with new types.

**Step 9: Commit**

```bash
git add packages/server/prisma/schema.prisma
git commit -m "feat(billing): add monetization schema — credit wallets, packs, subscriptions, promos, referrals"
```

---

### Task 2: Credit Service — Core Logic

**Files:**
- Create: `packages/server/src/lib/services/credit-service.ts`
- Create: `packages/server/src/lib/services/__tests__/credit-service.test.ts`

This is the central service that all billing operations use. Implements: expiry guard, balance read, per-commit debit, reservation, release.

**Step 1: Write failing tests for expiry guard and balance**

Create `packages/server/src/lib/services/__tests__/credit-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// We'll mock prisma
vi.mock('@/lib/db', () => ({
  default: {
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    creditTransaction: {
      create: vi.fn(),
    },
  },
}));

import prisma from '@/lib/db';
import {
  getAvailableBalance,
  runExpiryGuard,
  debitCredit,
  type BalanceInfo,
} from '../credit-service';

const mockedPrisma = vi.mocked(prisma, true);

describe('getAvailableBalance', () => {
  it('returns correct available balance with no reservations', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user1',
      permanentCredits: 100,
      subscriptionCredits: 50,
      reservedCredits: 0,
      subscriptionExpiresAt: new Date('2099-01-01'),
    } as any);

    const result = await getAvailableBalance('user1');

    expect(result).toEqual({
      permanent: 100,
      subscription: 50,
      reserved: 0,
      available: 150,
      subscriptionExpiresAt: expect.any(Date),
    });
  });

  it('subtracts reserved credits from available', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user1',
      permanentCredits: 100,
      subscriptionCredits: 50,
      reservedCredits: 30,
      subscriptionExpiresAt: new Date('2099-01-01'),
    } as any);

    const result = await getAvailableBalance('user1');

    expect(result.available).toBe(120);
    expect(result.reserved).toBe(30);
  });

  it('returns 0 subscription credits when expired', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user1',
      permanentCredits: 100,
      subscriptionCredits: 50,
      reservedCredits: 0,
      subscriptionExpiresAt: new Date('2020-01-01'), // expired
    } as any);

    const result = await getAvailableBalance('user1');

    // Expiry guard should have zeroed subscription
    expect(result.subscription).toBe(0);
    expect(result.available).toBe(100);
  });

  it('throws if user not found', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue(null);

    await expect(getAvailableBalance('nonexistent')).rejects.toThrow('User not found');
  });
});

describe('debitCredit', () => {
  it('debits from subscription wallet first', async () => {
    // $transaction executes the callback
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
    mockedPrisma.$executeRaw.mockResolvedValue(1); // 1 row affected

    // Mock queryRaw to return wallet choice
    mockedPrisma.$queryRaw.mockResolvedValue([{ target: 'SUBSCRIPTION' }]);

    const result = await debitCredit('user1', 'job1', 'order1');

    expect(result.wallet).toBe('SUBSCRIPTION');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test src/lib/services/__tests__/credit-service.test.ts`
Expected: FAIL — module `../credit-service` not found.

**Step 3: Implement credit-service.ts**

Create `packages/server/src/lib/services/credit-service.ts`:

```typescript
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';
import type { Prisma, WalletType, CreditTransactionType } from '@prisma/client';

const log = billingLogger ?? (await import('@/lib/logger')).logger;

export interface BalanceInfo {
  permanent: number;
  subscription: number;
  reserved: number;
  available: number;
  subscriptionExpiresAt: Date | null;
}

export interface DebitResult {
  wallet: WalletType;
  balanceAfter: number;
}

/**
 * Expiry guard: if subscription credits are expired, zero them out
 * and log a SUBSCRIPTION_EXPIRY transaction.
 * Runs inline before any balance read or debit.
 * Returns number of credits expired (0 if none).
 */
export async function runExpiryGuard(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<number> {
  // Use $queryRaw with RETURNING to get the expired amount in one atomic step
  const expired = await tx.$queryRaw<{ expired_amount: number }[]>`
    UPDATE "User"
    SET "subscriptionCredits" = 0, "subscriptionExpiresAt" = NULL
    WHERE id = ${userId}
      AND "subscriptionExpiresAt" IS NOT NULL
      AND "subscriptionExpiresAt" <= NOW()
      AND "subscriptionCredits" > 0
    RETURNING "subscriptionCredits" AS expired_amount
  `;

  if (expired.length === 0) return 0;

  const amount = expired[0].expired_amount;

  // Record the expiry in the ledger
  await tx.creditTransaction.create({
    data: {
      userId,
      type: 'SUBSCRIPTION_EXPIRY',
      amount: -amount,
      wallet: 'SUBSCRIPTION',
      balanceAfter: 0,
      description: `Subscription credits expired (${amount} credits)`,
    },
  });

  return amount;
}

/**
 * Get available balance for a user (with inline expiry guard).
 */
export async function getAvailableBalance(userId: string): Promise<BalanceInfo> {
  return prisma.$transaction(async (tx) => {
    // Run expiry guard first
    await runExpiryGuard(tx, userId);

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: {
        permanentCredits: true,
        subscriptionCredits: true,
        reservedCredits: true,
        subscriptionExpiresAt: true,
      },
    });

    if (!user) throw new Error('User not found');

    return {
      permanent: user.permanentCredits,
      subscription: user.subscriptionCredits,
      reserved: user.reservedCredits,
      available: user.permanentCredits + user.subscriptionCredits - user.reservedCredits,
      subscriptionExpiresAt: user.subscriptionExpiresAt,
    };
  });
}

/**
 * Reserve credits for an analysis job.
 * Returns true if reservation succeeded, false if insufficient balance.
 */
export async function reserveCredits(
  userId: string,
  jobId: string,
  orderId: string,
  amount: number,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await runExpiryGuard(tx, userId);

    // Atomic reserve with balance check
    const reserved = await tx.$executeRaw`
      UPDATE "User"
      SET "reservedCredits" = "reservedCredits" + ${amount}
      WHERE id = ${userId}
        AND ("permanentCredits" + "subscriptionCredits" - "reservedCredits") >= ${amount}
    `;

    if (reserved === 0) return false;

    // Record on the specific job
    await tx.analysisJob.update({
      where: { id: jobId },
      data: { creditsReserved: amount },
    });

    // Log transaction
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { permanentCredits: true, subscriptionCredits: true, reservedCredits: true },
    });

    await tx.creditTransaction.create({
      data: {
        userId,
        type: 'ANALYSIS_RESERVE',
        amount: -amount,
        wallet: 'PERMANENT', // reservation is conceptual, not from a specific wallet yet
        balanceAfter: (user!.permanentCredits + user!.subscriptionCredits) - user!.reservedCredits,
        relatedOrderId: orderId,
        description: `Reserved ${amount} credits for analysis`,
      },
    });

    return true;
  });
}

/**
 * Debit 1 credit for a processed commit.
 * Bounded by the job's reservation (creditsConsumed < creditsReserved).
 * Returns which wallet was debited, or null if budget exhausted.
 */
export async function debitCredit(
  userId: string,
  jobId: string,
  orderId: string,
): Promise<DebitResult | null> {
  return prisma.$transaction(async (tx) => {
    // Expiry guard
    await runExpiryGuard(tx, userId);

    // Check job still has reserved budget
    const jobUpdated = await tx.$executeRaw`
      UPDATE "AnalysisJob"
      SET "creditsConsumed" = "creditsConsumed" + 1
      WHERE id = ${jobId} AND "creditsConsumed" < "creditsReserved"
    `;

    if (jobUpdated === 0) return null; // reservation exhausted

    // Atomic wallet choice + debit in a single statement via CTE
    // The CTE reads current state and the UPDATE uses it in the same snapshot,
    // eliminating the TOCTOU race between separate SELECT and UPDATE.
    const result = await tx.$queryRaw<
      { target: string; sub_after: number; perm_after: number }[]
    >`
      WITH wallet_choice AS (
        SELECT id,
          CASE WHEN "subscriptionCredits" > 0 THEN 'SUBSCRIPTION' ELSE 'PERMANENT' END AS target,
          "subscriptionCredits", "permanentCredits"
        FROM "User" WHERE id = ${userId}
      ),
      debited AS (
        UPDATE "User" u SET
          "subscriptionCredits" = CASE WHEN wc.target = 'SUBSCRIPTION'
                                  THEN u."subscriptionCredits" - 1 ELSE u."subscriptionCredits" END,
          "permanentCredits" = CASE WHEN wc.target = 'PERMANENT'
                               THEN u."permanentCredits" - 1 ELSE u."permanentCredits" END,
          "reservedCredits" = u."reservedCredits" - 1
        FROM wallet_choice wc
        WHERE u.id = wc.id
          AND (CASE WHEN wc.target = 'SUBSCRIPTION' THEN u."subscriptionCredits"
                    ELSE u."permanentCredits" END) > 0
        RETURNING wc.target, u."subscriptionCredits" AS sub_after, u."permanentCredits" AS perm_after
      )
      SELECT * FROM debited
    `;

    if (result.length === 0) {
      // Wallet empty — roll back the job increment
      await tx.$executeRaw`
        UPDATE "AnalysisJob" SET "creditsConsumed" = "creditsConsumed" - 1
        WHERE id = ${jobId}
      `;
      return null;
    }

    const { target: wallet, sub_after, perm_after } = result[0];
    const balanceAfter = wallet === 'SUBSCRIPTION' ? sub_after : perm_after;

    await tx.creditTransaction.create({
      data: {
        userId,
        type: 'ANALYSIS_DEBIT',
        amount: -1,
        wallet: wallet as WalletType,
        balanceAfter,
        relatedOrderId: orderId,
      },
    });

    return { wallet: wallet as WalletType, balanceAfter };
  });
}

/**
 * Release unused reserved credits after analysis completes/fails.
 * Idempotent — safe to call multiple times.
 */
export async function releaseReservedCredits(
  userId: string,
  jobId: string,
  orderId: string,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    // Get job state
    const job = await tx.analysisJob.findUnique({
      where: { id: jobId },
      select: { creditsReserved: true, creditsConsumed: true, creditsReleased: true },
    });

    if (!job) return 0;

    // unused = what was reserved minus what was consumed minus what was
    // already released (cache hits release individually during processing)
    const unused = job.creditsReserved - job.creditsConsumed - job.creditsReleased;
    if (unused <= 0) return 0;

    // Mark final release on job
    await tx.analysisJob.update({
      where: { id: jobId },
      data: { creditsReleased: { increment: unused } },
    });

    // Return to user's available pool
    await tx.user.update({
      where: { id: userId },
      data: { reservedCredits: { decrement: unused } },
    });

    await tx.creditTransaction.create({
      data: {
        userId,
        type: 'ANALYSIS_RELEASE',
        amount: unused,
        wallet: 'PERMANENT',
        balanceAfter: 0, // will be recalculated
        relatedOrderId: orderId,
        description: `Released ${unused} unused credits`,
      },
    });

    return unused;
  });
}

/**
 * Account for a cached commit (no wallet debit, no LLM cost).
 * Increments creditsReleased on the job so releaseReservedCredits
 * correctly computes unused = reserved - consumed - released.
 */
export async function accountCachedCommit(
  userId: string,
  jobId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // Mark this unit as released on the job (not consumed — no wallet debit)
    await tx.analysisJob.update({
      where: { id: jobId },
      data: { creditsReleased: { increment: 1 } },
    });

    // Shrink the hold on User so available balance increases immediately
    await tx.user.update({
      where: { id: userId },
      data: { reservedCredits: { decrement: 1 } },
    });
  });
}
```

**Step 4: Add billingLogger to logger.ts**

Modify `packages/server/src/lib/logger.ts` — add a child logger:

```typescript
export const billingLogger = logger.child({ module: 'billing' });
```

**Step 5: Run tests**

Run: `cd packages/server && pnpm test src/lib/services/__tests__/credit-service.test.ts`
Expected: Tests pass (or adjust mocks as needed based on actual Prisma raw query behavior).

**Step 6: Commit**

```bash
git add packages/server/src/lib/services/credit-service.ts \
       packages/server/src/lib/services/__tests__/credit-service.test.ts \
       packages/server/src/lib/logger.ts
git commit -m "feat(billing): add core credit service — balance, reserve, debit, release"
```

---

## Phase 2: Registration & Referrals

### Task 3: Registration Flow — Free Credits & Referral

**Files:**
- Modify: `packages/server/src/app/api/auth/register/route.ts`
- Create: `packages/server/src/lib/services/referral-service.ts`
- Create: `packages/server/src/lib/services/__tests__/referral-service.test.ts`

**Step 1: Write failing test for referral credit assignment**

Create `packages/server/src/lib/services/__tests__/referral-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    $transaction: vi.fn(),
    systemSettings: { findFirst: vi.fn() },
    user: { findFirst: vi.fn(), update: vi.fn() },
    referral: { count: vi.fn(), create: vi.fn() },
    creditTransaction: { create: vi.fn() },
  },
}));

import prisma from '@/lib/db';
import { assignRegistrationCredits } from '../referral-service';

const mockedPrisma = vi.mocked(prisma, true);

describe('assignRegistrationCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockedPrisma));
  });

  it('assigns default credits without referral code', async () => {
    mockedPrisma.systemSettings.findFirst.mockResolvedValue({
      defaultFreeCredits: 100,
      referralBonusMultiplier: 2,
      maxReferralsPerUser: 20,
    } as any);

    const result = await assignRegistrationCredits('newuser1', null);

    expect(result.creditsAssigned).toBe(100);
    expect(result.referrerRewarded).toBe(false);
  });

  it('assigns double credits with valid referral', async () => {
    mockedPrisma.systemSettings.findFirst.mockResolvedValue({
      defaultFreeCredits: 100,
      referralBonusMultiplier: 2,
      maxReferralsPerUser: 20,
    } as any);
    mockedPrisma.user.findFirst.mockResolvedValue({
      id: 'referrer1',
      referralCode: 'ABC123',
    } as any);
    mockedPrisma.referral.count.mockResolvedValue(5); // under limit

    const result = await assignRegistrationCredits('newuser1', 'ABC123');

    expect(result.creditsAssigned).toBe(200);
    expect(result.referrerRewarded).toBe(true);
  });

  it('assigns standard credits when referrer at limit', async () => {
    mockedPrisma.systemSettings.findFirst.mockResolvedValue({
      defaultFreeCredits: 100,
      referralBonusMultiplier: 2,
      maxReferralsPerUser: 20,
    } as any);
    mockedPrisma.user.findFirst.mockResolvedValue({
      id: 'referrer1',
      referralCode: 'ABC123',
    } as any);
    mockedPrisma.referral.count.mockResolvedValue(20); // at limit

    const result = await assignRegistrationCredits('newuser1', 'ABC123');

    expect(result.creditsAssigned).toBe(100);
    expect(result.referrerRewarded).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test src/lib/services/__tests__/referral-service.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement referral-service.ts**

Create `packages/server/src/lib/services/referral-service.ts`:

```typescript
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';
import type { Prisma } from '@prisma/client';

const log = billingLogger;

interface RegistrationResult {
  creditsAssigned: number;
  referrerRewarded: boolean;
  referrerId: string | null;
}

export async function assignRegistrationCredits(
  newUserId: string,
  referralCode: string | null,
): Promise<RegistrationResult> {
  return prisma.$transaction(async (tx) => {
    const settings = await tx.systemSettings.findFirst();
    const freeCredits = settings?.defaultFreeCredits ?? 100;
    const multiplier = settings?.referralBonusMultiplier ?? 2;
    const maxReferrals = settings?.maxReferralsPerUser ?? 20;

    let creditsToAssign = freeCredits;
    let referrerRewarded = false;
    let referrerId: string | null = null;

    if (referralCode) {
      // Find referrer by their referral code (not the new user's)
      const referrer = await tx.user.findFirst({
        where: { referralCode },
        select: { id: true },
      });

      if (referrer && referrer.id !== newUserId) {
        // Check referrer hasn't hit the limit
        const referralCount = await tx.referral.count({
          where: { referrerId: referrer.id },
        });

        if (referralCount < maxReferrals) {
          // Bonus for new user
          creditsToAssign = freeCredits * multiplier;
          referrerId = referrer.id;

          // Reward referrer
          await tx.user.update({
            where: { id: referrer.id },
            data: { permanentCredits: { increment: freeCredits } },
          });

          await tx.creditTransaction.create({
            data: {
              userId: referrer.id,
              type: 'REFERRAL_REWARD',
              amount: freeCredits,
              wallet: 'PERMANENT',
              balanceAfter: 0, // recalculated in trigger or next read
              description: `Referral reward for inviting user`,
            },
          });

          await tx.referral.create({
            data: {
              referrerId: referrer.id,
              referredId: newUserId,
              creditsAwarded: freeCredits,
            },
          });

          referrerRewarded = true;
          log.info({ referrerId: referrer.id, newUserId, credits: freeCredits }, 'Referral reward granted');
        }
      }
    }

    // Assign credits to new user
    await tx.user.update({
      where: { id: newUserId },
      data: { permanentCredits: creditsToAssign },
    });

    const txType = referrerRewarded ? 'REFERRAL_BONUS' : 'REGISTRATION';
    await tx.creditTransaction.create({
      data: {
        userId: newUserId,
        type: txType,
        amount: creditsToAssign,
        wallet: 'PERMANENT',
        balanceAfter: creditsToAssign,
        description: referrerRewarded
          ? `Referral bonus: ${creditsToAssign} credits`
          : `Welcome bonus: ${creditsToAssign} credits`,
      },
    });

    log.info({ newUserId, credits: creditsToAssign, referrerRewarded }, 'Registration credits assigned');

    return { creditsAssigned: creditsToAssign, referrerRewarded, referrerId };
  });
}
```

**Step 4: Modify registration route**

Read and modify `packages/server/src/app/api/auth/register/route.ts`:
- After creating the user, call `assignRegistrationCredits(user.id, referralCode)`
- Extract `referralCode` from request body (add to zod schema as optional)

**Step 5: Run tests**

Run: `cd packages/server && pnpm test src/lib/services/__tests__/referral-service.test.ts`
Expected: All pass.

**Step 6: Commit**

```bash
git add packages/server/src/lib/services/referral-service.ts \
       packages/server/src/lib/services/__tests__/referral-service.test.ts \
       packages/server/src/app/api/auth/register/route.ts
git commit -m "feat(billing): add registration credits + referral system"
```

---

### Task 4: Referral API Endpoint

**Files:**
- Create: `packages/server/src/app/api/referral/route.ts`

**Step 1: Implement GET /api/referral**

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { referralCode: true },
  });

  const settings = await prisma.systemSettings.findFirst({
    select: { maxReferralsPerUser: true, defaultFreeCredits: true },
  });

  const [referralCount, totalEarned] = await Promise.all([
    prisma.referral.count({ where: { referrerId: session.user.id } }),
    prisma.referral.aggregate({
      where: { referrerId: session.user.id },
      _sum: { creditsAwarded: true },
    }),
  ]);

  const referrals = await prisma.referral.findMany({
    where: { referrerId: session.user.id },
    include: { referred: { select: { email: true, createdAt: true } } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return apiResponse({
    referralCode: user?.referralCode,
    stats: {
      invited: referralCount,
      limit: settings?.maxReferralsPerUser ?? 20,
      creditsEarned: totalEarned._sum.creditsAwarded ?? 0,
      creditsPerReferral: settings?.defaultFreeCredits ?? 100,
    },
    referrals: referrals.map((r) => ({
      // Mask email: show first 2 chars + domain
      email: r.referred.email.replace(/^(.{2}).*(@.*)$/, '$1***$2'),
      date: r.createdAt,
      creditsAwarded: r.creditsAwarded,
    })),
  });
}
```

**Step 2: Commit**

```bash
git add packages/server/src/app/api/referral/route.ts
git commit -m "feat(billing): add referral stats API endpoint"
```

---

## Phase 3: Promo Codes

### Task 5: Admin Promo Code CRUD API

**Files:**
- Create: `packages/server/src/app/api/admin/promo-codes/route.ts`
- Create: `packages/server/src/app/api/admin/promo-codes/[id]/route.ts`

**Step 1: Implement GET + POST /api/admin/promo-codes**

Follow existing admin API patterns from `packages/server/src/app/api/admin/orders/route.ts`:
- `requireAdmin()` check
- Paginated list with search/filter
- Zod validation for creation

POST body schema:
```typescript
const createSchema = z.object({
  code: z.string().min(3).max(32).regex(/^[A-Z0-9_-]+$/i),
  credits: z.number().int().positive(),
  maxRedemptions: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime(),
  description: z.string().max(200).optional(),
});
```

**Step 2: Implement PATCH /api/admin/promo-codes/[id]**

Allow updating: `isActive`, `maxRedemptions`, `expiresAt`, `description`.

**Step 3: Commit**

```bash
git add packages/server/src/app/api/admin/promo-codes/
git commit -m "feat(billing): add admin promo code CRUD API"
```

---

### Task 6: Promo Code Redemption API

**Files:**
- Create: `packages/server/src/lib/services/promo-service.ts`
- Create: `packages/server/src/lib/services/__tests__/promo-service.test.ts`
- Create: `packages/server/src/app/api/billing/redeem/route.ts`

**Step 1: Write failing tests for promo redemption**

Test cases:
- Valid code → credits added to permanentCredits
- Expired code → error
- Already redeemed by same user → error (P2002)
- Global limit reached → error (0 rows from UPDATE)
- Invalid/inactive code → error

**Step 2: Implement promo-service.ts**

Core function `redeemPromoCode(userId, code)` using `$executeRaw` for atomic field-to-field comparison as specified in the design doc.

**Step 3: Implement POST /api/billing/redeem**

```typescript
const schema = z.object({ code: z.string().min(1) });
```

- `requireUserSession()`
- Validate body
- Call `redeemPromoCode(session.user.id, code)`
- Return new balance

**Step 4: Run tests**

Run: `cd packages/server && pnpm test src/lib/services/__tests__/promo-service.test.ts`

**Step 5: Commit**

```bash
git add packages/server/src/lib/services/promo-service.ts \
       packages/server/src/lib/services/__tests__/promo-service.test.ts \
       packages/server/src/app/api/billing/redeem/route.ts
git commit -m "feat(billing): add promo code redemption with atomic guards"
```

---

## Phase 4: Stripe Integration

### Task 7: Stripe Setup & Webhook Handler

**Files:**
- Run: `cd packages/server && pnpm add stripe`
- Create: `packages/server/src/lib/stripe.ts`
- Create: `packages/server/src/app/api/billing/webhook/route.ts`

**Step 1: Install Stripe SDK**

Run: `cd packages/server && pnpm add stripe`

**Step 2: Create Stripe client singleton**

Create `packages/server/src/lib/stripe.ts`:

```typescript
import Stripe from 'stripe';

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is not set');
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-01-27.acacia', // use latest stable at implementation time
  typescript: true,
});
```

**Step 3: Implement webhook handler with insert-first idempotency**

Create `packages/server/src/app/api/billing/webhook/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { stripe } from '@/lib/stripe';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';
import type Stripe from 'stripe';

const log = billingLogger;

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err) {
    log.error({ err }, 'Webhook signature verification failed');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  try {
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
          await handleInvoicePaid(tx, event);
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
  } catch (err: any) {
    // P2002 on StripeEvent PK = already processed (idempotent)
    // IMPORTANT: check meta.target to avoid swallowing unrelated unique violations
    if (err?.code === 'P2002' && err?.meta?.target?.includes('StripeEvent_pkey')) {
      log.debug({ eventId: event.id }, 'Webhook event already processed');
      return NextResponse.json({ received: true });
    }
    log.error({ err, eventId: event.id }, 'Webhook processing failed');
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// Handler stubs — implemented in subsequent tasks
async function handleCheckoutCompleted(tx: any, event: Stripe.Event) {
  // Task 8: Credit pack purchase
}

async function handleInvoicePaid(tx: any, event: Stripe.Event) {
  // Task 9: Subscription renewal
}

async function handleSubscriptionUpdated(tx: any, event: Stripe.Event) {
  // Task 10: Plan changes
}

async function handleSubscriptionDeleted(tx: any, event: Stripe.Event) {
  // Task 10: Cancellation
}
```

**Important:** This route must NOT use the default body parser. Add to `route.ts`:
```typescript
export const dynamic = 'force-dynamic';
```

**Step 4: Add env vars to .env.example**

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

**Step 5: Commit**

```bash
git add packages/server/src/lib/stripe.ts \
       packages/server/src/app/api/billing/webhook/route.ts \
       packages/server/package.json pnpm-lock.yaml
git commit -m "feat(billing): add Stripe SDK, webhook handler with insert-first idempotency"
```

---

### Task 8: Credit Pack Checkout

**Files:**
- Create: `packages/server/src/app/api/billing/checkout/route.ts`
- Modify: `packages/server/src/app/api/billing/webhook/route.ts` (implement `handleCheckoutCompleted`)

**Step 1: Implement POST /api/billing/checkout**

```typescript
const schema = z.object({ packId: z.string() });
```

- Look up `CreditPack` by id (must be active)
- Get or create Stripe customer (`stripeCustomerId` on User)
- Create Stripe Checkout Session with `mode: 'payment'`, `metadata: { userId, packId }`
- Return `{ url: session.url }` for redirect

**Step 2: Implement handleCheckoutCompleted in webhook**

- Extract `userId`, `packId` from session metadata
- Look up pack's credit amount
- Increment `permanentCredits` on User
- Create `CreditTransaction(PACK_PURCHASE)`

**Step 3: Commit**

```bash
git add packages/server/src/app/api/billing/checkout/route.ts \
       packages/server/src/app/api/billing/webhook/route.ts
git commit -m "feat(billing): add credit pack checkout via Stripe"
```

---

### Task 9: Subscription Flow

**Files:**
- Create: `packages/server/src/app/api/billing/subscribe/route.ts`
- Create: `packages/server/src/app/api/billing/cancel-subscription/route.ts`
- Modify: `packages/server/src/app/api/billing/webhook/route.ts` (implement remaining handlers)

**Step 1: Implement POST /api/billing/subscribe**

- Look up `Subscription` by id (must be active)
- Create Stripe Checkout Session with `mode: 'subscription'`, metadata
- Return `{ url: session.url }`

**Step 2: Implement handleInvoicePaid**

- Find `UserSubscription` by `stripeSubscriptionId`
- If exists: expire old subscription credits, renew
- If not: create `UserSubscription`
- Set `subscriptionCredits = plan.creditsPerMonth`
- Set `subscriptionExpiresAt = currentPeriodEnd`

**Step 3: Implement handleSubscriptionUpdated (upgrade/downgrade)**

- Detect plan change by comparing old vs new price
- **Upgrade**: immediate delta credit addition
- **Downgrade**: update record only, new amount on next `invoice.paid`

**Step 4: Implement handleSubscriptionDeleted**

- Set `UserSubscription.status = CANCELLED`
- Don't zero subscription credits — they stay until expiry

**Step 5: Implement POST /api/billing/cancel-subscription**

- `requireUserSession()`
- Find user's `UserSubscription`
- Call `stripe.subscriptions.cancel(stripeSubscriptionId)` or `update` with `cancel_at_period_end: true`

**Step 6: Commit**

```bash
git add packages/server/src/app/api/billing/subscribe/route.ts \
       packages/server/src/app/api/billing/cancel-subscription/route.ts \
       packages/server/src/app/api/billing/webhook/route.ts
git commit -m "feat(billing): add subscription flow — subscribe, renew, upgrade, downgrade, cancel"
```

---

## Phase 5: Pipeline Integration

### Task 10: Pre-analysis Balance Check & Reservation

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/analyze/route.ts`

**Step 1: Add credit check and reservation inside the existing transaction**

The current route creates job + sets PROCESSING in one `$transaction`. Reservation must be in the **same transaction** to avoid orphaned PROCESSING state.

Before the `$transaction`:
1. Estimate billable commits (total scope minus cache hits via `CommitAnalysis` lookup)
2. Call `getAvailableBalance(userId)` — lightweight, can be outside tx
3. If `available < estimated` → return `apiError` with deficit info, don't start

Inside the existing `$transaction` (after creating job, before setting PROCESSING):
4. Block if user already has a RUNNING/PENDING job (one analysis at a time):
   ```typescript
   const activeJob = await tx.analysisJob.findFirst({
     where: { order: { userId: session.user.id }, status: { in: ['PENDING', 'RUNNING'] } },
   });
   if (activeJob) throw new Error('ANALYSIS_ALREADY_RUNNING');
   ```
5. Reserve credits atomically (inline, not separate function call):
   ```typescript
   const reserved = await tx.$executeRaw`
     UPDATE "User" SET "reservedCredits" = "reservedCredits" + ${estimated}
     WHERE id = ${userId}
       AND ("permanentCredits" + "subscriptionCredits" - "reservedCredits") >= ${estimated}
   `;
   if (reserved === 0) throw new Error('INSUFFICIENT_CREDITS');
   await tx.analysisJob.update({ where: { id: newJob.id }, data: { creditsReserved: estimated } });
   ```
6. If anything throws, the entire transaction rolls back — no orphaned PROCESSING status

Catch block:
```typescript
} catch (err: any) {
  if (err.message === 'ANALYSIS_ALREADY_RUNNING') return apiError('Analysis already in progress', 409);
  if (err.message === 'INSUFFICIENT_CREDITS') return apiError('Insufficient credits', 402);
  throw err;
}
```

**Step 2: Commit**

```bash
git add packages/server/src/app/api/orders/[id]/analyze/route.ts
git commit -m "feat(billing): add pre-analysis credit check and reservation"
```

---

### Task 11: Per-commit Debit in Analysis Worker

**Files:**
- Modify: `packages/server/src/lib/services/analysis-worker.ts`

**Step 1: Find the commit processing loop**

In `processAnalysisJob`, locate where each commit is processed and `CommitAnalysis` is saved.

**Step 2: Add debit call after commit processing**

For each commit:
1. Check if it's a cache hit (existing `CommitAnalysis` with same `commitHash` + `llmModel`)
2. If cache hit: call `accountCachedCommit(userId, jobId)`, skip LLM
3. If new commit: after LLM + save, call `debitCredit(userId, jobId, orderId)`
4. If `debitCredit` returns `null` → reservation exhausted → set order status `INSUFFICIENT_CREDITS`, stop

**Step 3: Add release call on job completion/failure**

At the end of `processAnalysisJob` (both success and catch block):
```typescript
await releaseReservedCredits(userId, jobId, orderId);
```

**Step 4: Commit**

```bash
git add packages/server/src/lib/services/analysis-worker.ts
git commit -m "feat(billing): integrate per-commit credit debit into analysis pipeline"
```

---

## Phase 6: Billing API & Balance

### Task 12: Balance & Transaction History API

**Files:**
- Create: `packages/server/src/app/api/billing/balance/route.ts`
- Create: `packages/server/src/app/api/billing/transactions/route.ts`

**Step 1: GET /api/billing/balance**

```typescript
import { getAvailableBalance } from '@/lib/services/credit-service';
```

- `requireUserSession()`
- Return `getAvailableBalance(session.user.id)` + subscription info

**Step 2: GET /api/billing/transactions**

- Paginated query on `CreditTransaction` where `userId`
- Optional filter by `type`
- Return with pagination metadata

**Step 3: Commit**

```bash
git add packages/server/src/app/api/billing/balance/route.ts \
       packages/server/src/app/api/billing/transactions/route.ts
git commit -m "feat(billing): add balance and transaction history API endpoints"
```

---

### Task 13: Admin Credit Adjustment API

**Files:**
- Create: `packages/server/src/app/api/admin/credits/adjust/route.ts`

**Step 1: Implement POST /api/admin/credits/adjust**

```typescript
const schema = z.object({
  userId: z.string(),
  amount: z.number().int(), // positive or negative
  reason: z.string().min(1).max(200),
});
```

- `requireAdmin()`
- Update user's `permanentCredits`
- Create `CreditTransaction(ADMIN_ADJUSTMENT)`
- Create `AuditLog` entry

**Step 2: Commit**

```bash
git add packages/server/src/app/api/admin/credits/adjust/route.ts
git commit -m "feat(billing): add admin credit adjustment API"
```

---

## Phase 7: User UI

### Task 14: Balance Display in Header

**Files:**
- Modify: `packages/server/src/components/layout/header.tsx`

**Step 1: Add balance query**

Use `useQuery` to fetch `/api/billing/balance`. Display in header:
```
Credits: {available} ({subscription} sub + {permanent} perm)
```
If `reserved > 0`: show `({reserved} reserved)`.

Refresh every 30 seconds while analysis is running (or use `refetchInterval` conditionally).

**Step 2: Commit**

```bash
git add packages/server/src/components/layout/header.tsx
git commit -m "feat(billing): display credit balance in header"
```

---

### Task 15: Billing Page

**Files:**
- Create: `packages/server/src/app/(dashboard)/billing/page.tsx`

**Step 1: Build billing page with sections**

Follow existing dashboard page patterns. Sections:

1. **Balance card** — permanent, subscription (with expiry), reserved, available
2. **Active subscription** — plan name, credits/month, next renewal, cancel button
3. **Credit packs** — 3 cards with "Buy" button (redirects to Stripe Checkout)
4. **Subscriptions** — 3 cards with "2x value" badge, "Subscribe" button
5. **Promo code** — input field + "Redeem" button
6. **Transaction history** — table with pagination, type filter

Use shadcn/ui `Card`, `Button`, `Input`, `Table`, `Badge` components.

Fetch data from:
- `/api/billing/balance`
- `/api/billing/transactions?page=1`

Mutations:
- `POST /api/billing/checkout` → redirect to `data.url`
- `POST /api/billing/subscribe` → redirect to `data.url`
- `POST /api/billing/cancel-subscription`
- `POST /api/billing/redeem` → invalidate balance query

**Step 2: Add route to sidebar navigation**

Modify `packages/server/src/components/layout/sidebar.tsx` — add "Billing" link.

**Step 3: Commit**

```bash
git add packages/server/src/app/(dashboard)/billing/page.tsx \
       packages/server/src/components/layout/sidebar.tsx
git commit -m "feat(billing): add billing page with packs, subscriptions, promo, transactions"
```

---

### Task 16: Referral Section in Billing Page

**Files:**
- Modify: `packages/server/src/app/(dashboard)/billing/page.tsx`

**Step 1: Add referral section**

Below promo code section:
- Referral link with copy-to-clipboard button
- Stats: invited X of Y, earned N credits
- List of invited users (masked email, date)

Fetch from `/api/referral`.

**Step 2: Commit**

```bash
git add packages/server/src/app/(dashboard)/billing/page.tsx
git commit -m "feat(billing): add referral section to billing page"
```

---

### Task 17: Analysis Flow Credit Check UI

**Files:**
- Modify: order analysis confirmation UI (find the component that triggers analysis)

**Step 1: Add credit preview before analysis**

In the analysis trigger UI:
- Show "~N credits will be used. Available: M"
- If `M < N`: show deficit, disable analyze button, show "Buy credits" link
- If `M >= N`: show confirmation, enable analyze button

**Step 2: Handle INSUFFICIENT_CREDITS status**

In the order detail page, when status is `INSUFFICIENT_CREDITS`:
- Show "Analysis paused — insufficient credits"
- Show how many commits were processed vs total
- Show "Top up and resume" button

**Step 3: Commit**

```bash
git add <modified-files>
git commit -m "feat(billing): add credit check UI in analysis flow"
```

---

## Phase 8: Admin UI

### Task 18: Admin Promo Codes Page

**Files:**
- Create: `packages/server/src/app/(dashboard)/admin/promo-codes/page.tsx`

**Step 1: Build promo codes admin page**

Follow existing admin page patterns from `/admin/orders/page.tsx`:
- Table with columns: Code, Credits, Used/Limit, Expires, Status, Actions
- "Create Promo Code" button → dialog/form
- Edit/deactivate actions
- Search by code

**Step 2: Add to admin sidebar**

Modify admin layout or navigation to include "Promo Codes" link.

**Step 3: Commit**

```bash
git add packages/server/src/app/(dashboard)/admin/promo-codes/page.tsx
git commit -m "feat(billing): add admin promo codes management page"
```

---

### Task 19: Admin Users — Balance Column & Adjustment

**Files:**
- Modify: `packages/server/src/app/(dashboard)/admin/users/page.tsx`
- Modify: `packages/server/src/app/api/admin/users/route.ts`

**Step 1: Add balance columns to users API response**

In the admin users API, include `permanentCredits`, `subscriptionCredits` in the response.

**Step 2: Add balance column to users table**

Show "Credits" column with `permanent + subscription` total.

**Step 3: Add "Adjust Credits" action**

Button in user row → dialog with amount input (+/-) and reason field.
Calls `POST /api/admin/credits/adjust`.

**Step 4: Commit**

```bash
git add packages/server/src/app/(dashboard)/admin/users/page.tsx \
       packages/server/src/app/api/admin/users/route.ts
git commit -m "feat(billing): add balance column and credit adjustment to admin users"
```

---

### Task 20: Admin Billing Stats Page

**Files:**
- Create: `packages/server/src/app/api/admin/billing/stats/route.ts`
- Create: `packages/server/src/app/(dashboard)/admin/billing/page.tsx`

**Step 1: Implement GET /api/admin/billing/stats**

Aggregate queries:
- Total revenue (SUM of pack purchases + subscriptions from CreditTransaction)
- Active subscriptions count
- Credits sold (total), credits consumed (total)
- Credits in circulation (SUM of all users' permanent + subscription)
- Recent transactions (last 50)

**Step 2: Build admin billing page**

- Revenue cards (total, this month)
- Active subscriptions count
- Credits overview (sold vs consumed)
- Recharts chart: daily revenue over last 30 days

**Step 3: Add to admin navigation**

**Step 4: Commit**

```bash
git add packages/server/src/app/api/admin/billing/stats/route.ts \
       packages/server/src/app/(dashboard)/admin/billing/page.tsx
git commit -m "feat(billing): add admin billing stats page"
```

---

## Phase 9: Seed Data & Final Integration

### Task 21: Seed Credit Packs and Subscriptions

**Files:**
- Modify: `packages/server/prisma/seed.ts`

**Step 1: Add seed data**

```typescript
// Credit Packs
const packs = [
  { name: 'Starter', credits: 500, priceUsd: 9.00, stripePriceId: 'price_starter_placeholder', sortOrder: 1 },
  { name: 'Pro', credits: 2000, priceUsd: 29.00, stripePriceId: 'price_pro_placeholder', sortOrder: 2 },
  { name: 'Business', credits: 10000, priceUsd: 99.00, stripePriceId: 'price_business_placeholder', sortOrder: 3 },
];

// Subscriptions
const subs = [
  { name: 'Basic', creditsPerMonth: 1000, priceUsd: 9.00, stripePriceId: 'price_sub_basic_placeholder', sortOrder: 1 },
  { name: 'Pro', creditsPerMonth: 4000, priceUsd: 29.00, stripePriceId: 'price_sub_pro_placeholder', sortOrder: 2 },
  { name: 'Business', creditsPerMonth: 20000, priceUsd: 99.00, stripePriceId: 'price_sub_business_placeholder', sortOrder: 3 },
];
```

Use `upsert` by `stripePriceId` for idempotent seeding.

**Note:** `stripePriceId` values are placeholders. Replace with real Stripe Price IDs after creating products in Stripe Dashboard.

**Step 2: Update SystemSettings seed with billing defaults**

Add `defaultFreeCredits: 100`, `referralBonusMultiplier: 2`, `maxReferralsPerUser: 20` to the settings upsert.

**Step 3: Run seed**

Run: `cd packages/server && pnpm db:seed`

**Step 4: Commit**

```bash
git add packages/server/prisma/seed.ts
git commit -m "feat(billing): seed credit packs, subscriptions, and billing settings"
```

---

### Task 22: Middleware — Protect Billing Routes

**Files:**
- Modify: `packages/server/middleware.ts`

**Step 1: Add billing routes to middleware matcher**

Add `'/billing/:path*'` to the matcher array so billing pages require authentication.

**Step 2: Commit**

```bash
git add packages/server/middleware.ts
git commit -m "feat(billing): add billing routes to auth middleware"
```

---

### Task 23: Integration Tests for Critical Paths

**Files:**
- Create: `packages/server/src/lib/services/__tests__/credit-flow.integration.test.ts`

**Step 1: Write integration tests**

Test the critical scenarios from the design doc (test scenarios 1-14). Key tests:

1. **Reserve → debit → release cycle**: reserve 10, debit 7, release returns 3
2. **Debit bounded by reservation**: debit returns null after `creditsConsumed == creditsReserved`
3. **Expiry guard**: set `subscriptionExpiresAt` to past, debit falls through to permanent
4. **Concurrent promo redemption**: parallel calls with global limit → only one succeeds
5. **Release idempotency**: calling release twice → second call is no-op

**Step 2: Run tests**

Run: `cd packages/server && pnpm test src/lib/services/__tests__/credit-flow.integration.test.ts`

**Step 3: Commit**

```bash
git add packages/server/src/lib/services/__tests__/credit-flow.integration.test.ts
git commit -m "test(billing): add integration tests for critical credit flow paths"
```

---

## Task Dependency Graph

```
Task 1 (Schema)
  ├── Task 2 (Credit Service)
  │     ├── Task 10 (Pre-analysis Check)
  │     │     └── Task 11 (Pipeline Debit)
  │     └── Task 12 (Balance API)
  │           └── Task 14 (Header Balance)
  │                 └── Task 15 (Billing Page)
  │                       └── Task 16 (Referral Section)
  ├── Task 3 (Registration + Referral Service)
  │     └── Task 4 (Referral API)
  ├── Task 5 (Admin Promo API)
  │     ├── Task 6 (Promo Redemption)
  │     └── Task 18 (Admin Promo Page)
  ├── Task 7 (Stripe Setup)
  │     ├── Task 8 (Pack Checkout)
  │     └── Task 9 (Subscription Flow)
  ├── Task 13 (Admin Credit Adjust)
  │     └── Task 19 (Admin Users Extension)
  ├── Task 20 (Admin Billing Stats)
  ├── Task 21 (Seed Data)
  └── Task 22 (Middleware)

Task 23 (Integration Tests) — depends on Tasks 2, 6, 7
Task 17 (Analysis Flow UI) — depends on Tasks 10, 15
```

## Parallel Execution Groups

These task groups can be worked on independently after Task 1:

- **Group A** (Credit core): Tasks 2 → 10 → 11
- **Group B** (Auth + Referral): Tasks 3 → 4
- **Group C** (Promos): Tasks 5 → 6
- **Group D** (Stripe): Tasks 7 → 8 → 9
- **Group E** (Admin): Tasks 13, 18, 19, 20
- **Group F** (User UI): Tasks 12 → 14 → 15 → 16 → 17
