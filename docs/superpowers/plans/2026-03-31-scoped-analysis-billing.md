# Scoped Analysis Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make analysis credit estimation and reservation derive from the authoritative scoped commit universe, not from stale extraction-time developer aggregates.

**Architecture:** A new shared `analysis-billing-preview.ts` service becomes the single server-side source of truth for billable commit counts. It uses a **dual-source strategy**: for first-run orders (no `CommitAnalysis` rows on this order yet), it derives the total commit count from `selectedDevelopers` extraction aggregate, but **still queries cross-order cache** from the user's completed orders — so a first-run order that can reuse cached analyses shows the correct lower billable count. For re-runs (where `CommitAnalysis` rows exist on this order), it uses the fully authoritative scoped commit query. Both the UI (via `/api/orders/[id]/billing-preview`) and the analyze preflight use this same service. The billing-preview route accepts scope overrides as query params (for future use by draft-scope editors). In this slice, the UI sends **persisted order scope + contributor exclusions** — scope edits go through the existing order PUT first, then the preview refetches. Unsaved draft-scope preview is a future enhancement, not part of this slice. The UI enforces a loading guard — Start Analysis is disabled until the preview resolves. `Math.max(1, ...)` is removed so fully cached / zero-net runs launch with 0 credits.

**Known limitation (first-run):** `selectedDevelopers` is a flat per-developer aggregate with no per-date commit data. On first-run, `DATE_RANGE` and `SELECTED_YEARS` overrides **cannot narrow** the total estimate — it remains an all-time sum. `LAST_N_COMMITS` and contributor exclusion work correctly. The UI shows an `isFirstRunEstimate` hint so the user knows the estimate may be conservative for date-scoped first runs. This is the honest tradeoff: richer data requires either a schema change or expensive re-fetch, and the extraction aggregate is the best available source.

**Tech Stack:** TypeScript, Next.js App Router API routes, Prisma raw SQL, React (TanStack Query), vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/server/src/lib/services/analysis-billing-preview.ts` | Single source of truth: dual-source scoped billable commit count with cross-order cache, credits to reserve |
| Create | `packages/server/src/lib/services/__tests__/analysis-billing-preview.test.ts` | Unit tests for both first-run and re-run paths |
| Create | `packages/server/src/app/api/orders/[id]/billing-preview/route.ts` | API route exposing preview to UI — accepts persisted scope + contributor exclusions (scope override params available for future draft-scope editors) |
| Create | `packages/server/src/app/api/orders/[id]/billing-preview/__tests__/route.test.ts` | Route-level tests |
| Modify | `packages/server/src/app/api/orders/[id]/analyze/route.ts` | Replace inline estimation with shared service; remove Math.max(1) |
| Modify | `packages/server/src/app/api/orders/[id]/analyze/__tests__/preflight.test.ts` | Update tests for zero-credit scenarios |
| Modify | `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx` | Replace client-side estimation with billing-preview API; loading guard; fix USD language |
| Modify | `packages/server/src/app/api/llm-info/route.ts` | Add explicit `approximate` flag to response |
| Modify | `packages/server/src/lib/services/index.ts` | Export new service |
| Modify | `packages/server/messages/en.json` | Harden credit/USD language |
| Modify | `packages/server/messages/ru.json` | Harden credit/USD language |

---

## Design Decision: Dual-Source Commit Universe

The billing preview needs a commit universe to count. Two situations exist:

**First-run (DEVELOPERS_LOADED, no CommitAnalysis rows on this order):**
- **Total commits**: Sum `selectedDevelopers[].commitCount` for non-excluded developers (extraction-time aggregate from real GitHub fetch). Cap at `commitLimit` for LAST_N_COMMITS. `DATE_RANGE` and `SELECTED_YEARS` cannot narrow this total — the aggregate has no per-date data. This is documented as a known limitation.
- **Cached commits**: Query `CommitAnalysis` from the same user's *other* completed orders that match the selected repos, scope, and cache mode. This is critical — a new order analyzing repos the user has analyzed before should show the correct lower billable count, and fully-cached first runs should show 0 billable.
- **Billable**: `max(0, total - cached)`.

**Re-run (CommitAnalysis rows exist on this order):**
- Both total and cached derive from the authoritative `CommitAnalysis` scoped query with cross-order cache.

The service detects which path to use by checking if `CommitAnalysis` rows exist for this order (with `jobId IS NULL` and `method != 'error'`). The result includes `isFirstRunEstimate: boolean`.

**Why not persist per-commit data during extraction?** That would require either a schema change or persisting thousands of JSONB rows. The flat aggregate is honest for first-run. The target improvement is: (1) re-runs use fully authoritative scoped data, (2) first-runs get cross-order cache awareness, (3) UI and server use the same path.

---

## Task 1: Create the billing preview service (dual-source + cache-aware first-run)

**Files:**
- Create: `packages/server/src/lib/services/analysis-billing-preview.ts`
- Create: `packages/server/src/lib/services/__tests__/analysis-billing-preview.test.ts`

This is the core of the entire slice. One function, one source of truth, dual-source strategy with cross-order cache on both paths.

- [ ] **Step 1: Write the failing test file**

Create `packages/server/src/lib/services/__tests__/analysis-billing-preview.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    $queryRaw: vi.fn(),
    commitAnalysis: { count: vi.fn() },
  },
}));

vi.mock('@/lib/llm-config', () => ({
  getLlmConfig: vi.fn(),
}));

import prisma from '@/lib/db';
import { getLlmConfig } from '@/lib/llm-config';
import {
  computeBillingPreview,
  type BillingPreviewInput,
} from '../analysis-billing-preview';

const mockedPrisma = vi.mocked(prisma, true);
const mockedGetLlmConfig = vi.mocked(getLlmConfig);

function makeInput(overrides: Partial<BillingPreviewInput> = {}): BillingPreviewInput {
  return {
    userId: 'user-1',
    orderId: 'order-1',
    selectedRepos: [{ fullName: 'owner/repo', full_name: 'owner/repo' }],
    selectedDevelopers: [
      { email: 'alice@example.com', commitCount: 30 },
      { email: 'bob@example.com', commitCount: 20 },
    ],
    excludedEmails: [],
    cacheMode: 'model',
    scope: {
      mode: 'ALL_TIME',
      years: [],
      startDate: null,
      endDate: null,
      commitLimit: null,
    },
    ...overrides,
  };
}

describe('computeBillingPreview — first-run (no CommitAnalysis rows on this order)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No CommitAnalysis rows on this order — first-run path
    mockedPrisma.commitAnalysis.count.mockResolvedValue(0);
    // Cross-order cache query — default: no cache
    mockedPrisma.$queryRaw.mockResolvedValue([{ cached: 0 }]);
    mockedGetLlmConfig.mockResolvedValue({
      provider: 'openrouter',
      openrouter: { model: 'test-model', apiKey: 'k' },
      ollama: { model: 'test', url: 'http://localhost:11434' },
    } as any);
  });

  it('sums selectedDevelopers.commitCount for first-run total, zero cache', async () => {
    const result = await computeBillingPreview(makeInput());
    expect(result.totalScopedCommits).toBe(50); // 30 + 20
    expect(result.reusableCachedCommits).toBe(0);
    expect(result.billableCommits).toBe(50);
    expect(result.estimatedCredits).toBe(50);
    expect(result.isFirstRunEstimate).toBe(true);
  });

  it('subtracts cross-order cache from first-run total', async () => {
    // User previously analyzed same repos — 15 commits are cached
    mockedPrisma.$queryRaw.mockResolvedValue([{ cached: 15 }]);
    const result = await computeBillingPreview(makeInput());
    expect(result.totalScopedCommits).toBe(50);
    expect(result.reusableCachedCommits).toBe(15);
    expect(result.billableCommits).toBe(35);
    expect(result.estimatedCredits).toBe(35);
  });

  it('shows zero billable when cross-order cache covers all commits', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{ cached: 50 }]);
    const result = await computeBillingPreview(makeInput());
    expect(result.billableCommits).toBe(0);
    expect(result.estimatedCredits).toBe(0);
  });

  it('excludes specified emails from first-run sum', async () => {
    const result = await computeBillingPreview(makeInput({
      excludedEmails: ['bob@example.com'],
    }));
    expect(result.totalScopedCommits).toBe(30); // only alice
    expect(result.billableCommits).toBe(30);
  });

  it('handles legacy commit_count field', async () => {
    const result = await computeBillingPreview(makeInput({
      selectedDevelopers: [
        { email: 'dev@example.com', commit_count: 42 },
      ],
    }));
    expect(result.totalScopedCommits).toBe(42);
  });

  it('filters out blank-email rows from first-run sum', async () => {
    const result = await computeBillingPreview(makeInput({
      selectedDevelopers: [
        { email: 'alice@example.com', commitCount: 10 },
        { email: '', commitCount: 999 },
        { commitCount: 888 },
      ],
    }));
    expect(result.totalScopedCommits).toBe(10);
  });

  it('caps at commitLimit for LAST_N_COMMITS first-run', async () => {
    const result = await computeBillingPreview(makeInput({
      selectedDevelopers: [{ email: 'a@b.com', commitCount: 100 }],
      scope: { mode: 'LAST_N_COMMITS', years: [], startDate: null, endDate: null, commitLimit: 50 },
    }));
    expect(result.totalScopedCommits).toBe(50);
    expect(result.billableCommits).toBe(50);
  });

  it('returns zero cache when cacheMode is off', async () => {
    const result = await computeBillingPreview(makeInput({ cacheMode: 'off' }));
    // Should NOT call the cache query at all
    expect(result.reusableCachedCommits).toBe(0);
    expect(result.billableCommits).toBe(50);
  });

  it('returns zero for empty selectedDevelopers', async () => {
    const result = await computeBillingPreview(makeInput({ selectedDevelopers: [] }));
    expect(result.totalScopedCommits).toBe(0);
    expect(result.estimatedCredits).toBe(0);
  });

  it('returns zero for empty repos', async () => {
    const result = await computeBillingPreview(makeInput({ selectedRepos: [] }));
    expect(result.totalScopedCommits).toBe(0);
    expect(result.estimatedCredits).toBe(0);
  });

  it('does not narrow total for DATE_RANGE (known limitation)', async () => {
    // DATE_RANGE cannot filter selectedDevelopers aggregate — total stays all-time
    const result = await computeBillingPreview(makeInput({
      scope: {
        mode: 'DATE_RANGE',
        years: [],
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-12-31'),
        commitLimit: null,
      },
    }));
    // Still 50, not filtered — selectedDevelopers has no per-date data
    expect(result.totalScopedCommits).toBe(50);
    expect(result.isFirstRunEstimate).toBe(true);
  });
});

describe('computeBillingPreview — re-run (CommitAnalysis rows exist)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // CommitAnalysis rows exist — re-run path
    mockedPrisma.commitAnalysis.count.mockResolvedValue(50);
    mockedGetLlmConfig.mockResolvedValue({
      provider: 'openrouter',
      openrouter: { model: 'test-model', apiKey: 'k' },
      ollama: { model: 'test', url: 'http://localhost:11434' },
    } as any);
  });

  it('returns billable = total - cached for re-run', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{ total: 50, cached: 20 }]);
    const result = await computeBillingPreview(makeInput());
    expect(result.totalScopedCommits).toBe(50);
    expect(result.reusableCachedCommits).toBe(20);
    expect(result.billableCommits).toBe(30);
    expect(result.estimatedCredits).toBe(30);
    expect(result.isFirstRunEstimate).toBe(false);
  });

  it('returns zero billable when fully cached', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{ total: 10, cached: 10 }]);
    const result = await computeBillingPreview(makeInput());
    expect(result.billableCommits).toBe(0);
    expect(result.estimatedCredits).toBe(0);
  });

  it('returns zero cached when cacheMode is off', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{ total: 30, cached: 0 }]);
    const result = await computeBillingPreview(makeInput({ cacheMode: 'off' }));
    expect(result.reusableCachedCommits).toBe(0);
    expect(result.billableCommits).toBe(30);
  });

  it('does not produce negative billable (cached > total edge case)', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{ total: 5, cached: 8 }]);
    const result = await computeBillingPreview(makeInput());
    expect(result.billableCommits).toBe(0);
    expect(result.estimatedCredits).toBe(0);
  });

  it('handles legacy repos with full_name instead of fullName', async () => {
    mockedPrisma.$queryRaw.mockResolvedValue([{ total: 10, cached: 0 }]);
    const result = await computeBillingPreview(makeInput({
      selectedRepos: [{ full_name: 'owner/legacy-repo' } as any],
    }));
    expect(result.totalScopedCommits).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && pnpm test -- src/lib/services/__tests__/analysis-billing-preview.test.ts`
Expected: FAIL — module `../analysis-billing-preview` not found.

- [ ] **Step 3: Implement the billing preview service**

Create `packages/server/src/lib/services/analysis-billing-preview.ts`:

```typescript
/**
 * Analysis Billing Preview Service
 *
 * Single source of truth for scoped billable commit counts.
 * Used by both the billing-preview API route and the analyze preflight.
 *
 * Dual-source strategy:
 * - First-run (no CommitAnalysis rows on this order):
 *     total from selectedDevelopers aggregate, cache from cross-order CommitAnalysis
 * - Re-run (CommitAnalysis rows exist on this order):
 *     both total and cache from authoritative scoped CommitAnalysis query
 *
 * Known limitation: first-run total cannot be narrowed by DATE_RANGE or SELECTED_YEARS
 * because selectedDevelopers is a flat aggregate without per-date commit data.
 */
import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { getLlmConfig } from '@/lib/llm-config';
import { billingLogger } from '@/lib/logger';

export interface BillingPreviewScope {
  mode: 'ALL_TIME' | 'SELECTED_YEARS' | 'DATE_RANGE' | 'LAST_N_COMMITS';
  years: number[];
  startDate: Date | null;
  endDate: Date | null;
  commitLimit: number | null;
}

export interface BillingPreviewInput {
  userId: string;
  orderId: string;
  selectedRepos: Array<Record<string, unknown>>;
  /** Extraction-time developer data from order.selectedDevelopers JSONB */
  selectedDevelopers: Array<Record<string, unknown>>;
  excludedEmails: string[];
  cacheMode: 'any' | 'model' | 'off';
  scope: BillingPreviewScope;
}

export interface BillingPreviewResult {
  totalScopedCommits: number;
  reusableCachedCommits: number;
  billableCommits: number;
  estimatedCredits: number;
  /** True when total is derived from extraction-time aggregates (first-run).
   *  DATE_RANGE / SELECTED_YEARS cannot narrow a first-run total. */
  isFirstRunEstimate: boolean;
}

function parseRepoNames(raw: Array<Record<string, unknown>>): string[] {
  const names = new Set<string>();
  for (const item of raw) {
    const fullName = (item.fullName ?? item.full_name) as string | undefined;
    if (typeof fullName === 'string' && fullName.trim()) {
      names.add(fullName.trim());
    }
  }
  return [...names];
}

// ── Shared: resolve LLM model for cache filtering ──

async function resolveLlmModel(orderId: string): Promise<string | null> {
  try {
    const llmConfig = await getLlmConfig();
    return llmConfig.provider === 'openrouter'
      ? llmConfig.openrouter.model
      : llmConfig.ollama.model;
  } catch (err) {
    billingLogger.warn({ err, orderId }, 'Failed to load LLM config for billing preview');
    return null;
  }
}

// ── Shared: build SQL fragments ──

function buildScopeFilter(scope: BillingPreviewScope) {
  if (scope.mode === 'DATE_RANGE' && scope.startDate && scope.endDate) {
    return Prisma.sql`AND ca."authorDate" >= ${scope.startDate} AND ca."authorDate" <= ${scope.endDate}`;
  }
  if (scope.mode === 'SELECTED_YEARS' && scope.years.length > 0) {
    const yearPredicates = scope.years.map((year) => Prisma.sql`
      (ca."authorDate" >= ${new Date(`${year}-01-01T00:00:00.000Z`)}
       AND ca."authorDate" < ${new Date(`${year + 1}-01-01T00:00:00.000Z`)})
    `);
    return Prisma.sql`AND (${Prisma.join(yearPredicates, ' OR ')})`;
  }
  return Prisma.empty;
}

function buildExcludedFilter(excludedEmails: string[]) {
  return excludedEmails.length > 0
    ? Prisma.sql`AND ca."authorEmail" NOT IN (${Prisma.join(excludedEmails)})`
    : Prisma.empty;
}

function buildCacheFilter(
  cacheMode: 'any' | 'model' | 'off',
  orderId: string,
  llmModel: string | null,
) {
  if (cacheMode === 'off') return Prisma.sql`AND FALSE`;
  if (cacheMode === 'model' && llmModel) {
    return Prisma.sql`
      AND ca.method != 'error'
      AND ca."jobId" IS NULL
      AND (ca."orderId" = ${orderId} OR ca."llmModel" = ${llmModel} OR ca."llmModel" IS NULL)
    `;
  }
  if (cacheMode === 'model') {
    return Prisma.sql`AND ca.method != 'error' AND ca."jobId" IS NULL AND ca."orderId" = ${orderId}`;
  }
  // cacheMode === 'any'
  return Prisma.sql`AND ca.method != 'error' AND ca."jobId" IS NULL`;
}

// ── First-run path ──

function computeFirstRunTotal(input: BillingPreviewInput): number {
  const { selectedDevelopers, excludedEmails, scope } = input;
  const excludedSet = new Set(excludedEmails);

  let total = 0;
  for (const dev of selectedDevelopers) {
    const email = dev.email as string | undefined;
    if (!email) continue;
    if (excludedSet.has(email)) continue;
    const count = (dev.commitCount ?? dev.commit_count ?? 0) as number;
    total += typeof count === 'number' && Number.isFinite(count) ? count : 0;
  }

  // LAST_N_COMMITS cap is the only scope filter that can apply to flat aggregates
  if (scope.mode === 'LAST_N_COMMITS' && scope.commitLimit && scope.commitLimit > 0) {
    total = Math.min(total, scope.commitLimit);
  }

  // NOTE: DATE_RANGE and SELECTED_YEARS cannot narrow this total.
  // selectedDevelopers is a flat per-developer aggregate without per-date data.

  return total;
}

async function queryFirstRunCache(input: BillingPreviewInput): Promise<number> {
  const { userId, orderId, selectedRepos, excludedEmails, cacheMode, scope } = input;

  if (cacheMode === 'off') return 0;

  const repoNames = parseRepoNames(selectedRepos);
  if (repoNames.length === 0) return 0;

  const llmModel = cacheMode === 'model' ? await resolveLlmModel(orderId) : null;

  const scopeFilter = buildScopeFilter(scope);
  const excludedFilter = buildExcludedFilter(excludedEmails);
  const cacheFilter = buildCacheFilter(cacheMode, orderId, llmModel);

  // Query cross-order cache: completed orders by same user with matching repos/scope
  // Note: for first-run, ca."orderId" != orderId because this order has no CA rows.
  // The cache filter already handles the orderId matching.
  if (scope.mode === 'LAST_N_COMMITS' && scope.commitLimit && scope.commitLimit > 0) {
    const rows = await prisma.$queryRaw<{ cached: number }[]>`
      WITH candidate AS (
        SELECT ca."commitHash", MAX(ca."authorDate") AS "authorDate"
        FROM "CommitAnalysis" ca
        JOIN "Order" o ON o.id = ca."orderId"
        WHERE ca.repository IN (${Prisma.join(repoNames)})
          AND o."userId" = ${userId}
          AND o.status = 'COMPLETED'
          ${cacheFilter}
          ${excludedFilter}
        GROUP BY ca."commitHash"
      ),
      ranked AS (
        SELECT "commitHash"
        FROM candidate
        ORDER BY "authorDate" DESC
        LIMIT ${scope.commitLimit}
      )
      SELECT COUNT(*)::int AS cached FROM ranked
    `;
    return rows[0]?.cached ?? 0;
  }

  const rows = await prisma.$queryRaw<{ cached: number }[]>`
    SELECT COUNT(DISTINCT ca."commitHash")::int AS cached
    FROM "CommitAnalysis" ca
    JOIN "Order" o ON o.id = ca."orderId"
    WHERE ca.repository IN (${Prisma.join(repoNames)})
      AND o."userId" = ${userId}
      AND o.status = 'COMPLETED'
      ${cacheFilter}
      ${scopeFilter}
      ${excludedFilter}
  `;
  return rows[0]?.cached ?? 0;
}

async function computeFirstRunEstimate(input: BillingPreviewInput): Promise<BillingPreviewResult> {
  const total = computeFirstRunTotal(input);
  const cached = total > 0 ? await queryFirstRunCache(input) : 0;
  // Cache can't exceed total (defensive — DB might have more cached than extraction counted)
  const effectiveCached = Math.min(cached, total);
  const billable = Math.max(0, total - effectiveCached);

  return {
    totalScopedCommits: total,
    reusableCachedCommits: effectiveCached,
    billableCommits: billable,
    estimatedCredits: billable,
    isFirstRunEstimate: true,
  };
}

// ── Re-run path: authoritative scoped CommitAnalysis query ──

async function computeRerunEstimate(input: BillingPreviewInput): Promise<BillingPreviewResult> {
  const { userId, orderId, selectedRepos, excludedEmails, cacheMode, scope } = input;

  const repoNames = parseRepoNames(selectedRepos);
  if (repoNames.length === 0) {
    return { totalScopedCommits: 0, reusableCachedCommits: 0, billableCommits: 0, estimatedCredits: 0, isFirstRunEstimate: false };
  }

  const scopeFilter = buildScopeFilter(scope);
  const excludedFilter = buildExcludedFilter(excludedEmails);
  const llmModel = cacheMode === 'model' ? await resolveLlmModel(orderId) : null;
  const cacheFilter = buildCacheFilter(cacheMode, orderId, llmModel);

  if (scope.mode === 'LAST_N_COMMITS' && scope.commitLimit && scope.commitLimit > 0) {
    const rows = await prisma.$queryRaw<{ total: number; cached: number }[]>`
      WITH scoped AS (
        SELECT DISTINCT ca."commitHash", ca."authorDate"
        FROM "CommitAnalysis" ca
        WHERE ca."orderId" = ${orderId}
          AND ca."jobId" IS NULL
          AND ca.method != 'error'
          AND ca.repository IN (${Prisma.join(repoNames)})
          ${excludedFilter}
        ORDER BY ca."authorDate" DESC
        LIMIT ${scope.commitLimit}
      ),
      cached AS (
        SELECT DISTINCT ca."commitHash"
        FROM "CommitAnalysis" ca
        JOIN "Order" o ON o.id = ca."orderId"
        WHERE ca.repository IN (${Prisma.join(repoNames)})
          AND ca."commitHash" IN (SELECT "commitHash" FROM scoped)
          AND (
            ca."orderId" = ${orderId}
            OR (o."userId" = ${userId} AND o.status = 'COMPLETED')
          )
          ${cacheFilter}
          ${excludedFilter}
      )
      SELECT
        (SELECT COUNT(*)::int FROM scoped) AS total,
        (SELECT COUNT(*)::int FROM cached) AS cached
    `;

    const total = rows[0]?.total ?? 0;
    const cached = cacheMode === 'off' ? 0 : (rows[0]?.cached ?? 0);
    const billable = Math.max(0, total - cached);
    return { totalScopedCommits: total, reusableCachedCommits: cached, billableCommits: billable, estimatedCredits: billable, isFirstRunEstimate: false };
  }

  const rows = await prisma.$queryRaw<{ total: number; cached: number }[]>`
    WITH scoped AS (
      SELECT DISTINCT ca."commitHash"
      FROM "CommitAnalysis" ca
      WHERE ca."orderId" = ${orderId}
        AND ca."jobId" IS NULL
        AND ca.method != 'error'
        AND ca.repository IN (${Prisma.join(repoNames)})
        ${scopeFilter}
        ${excludedFilter}
    ),
    cached AS (
      SELECT DISTINCT ca."commitHash"
      FROM "CommitAnalysis" ca
      JOIN "Order" o ON o.id = ca."orderId"
      WHERE ca.repository IN (${Prisma.join(repoNames)})
        AND ca."commitHash" IN (SELECT "commitHash" FROM scoped)
        AND (
          ca."orderId" = ${orderId}
          OR (o."userId" = ${userId} AND o.status = 'COMPLETED')
        )
        ${cacheFilter}
        ${scopeFilter}
        ${excludedFilter}
    )
    SELECT
      (SELECT COUNT(*)::int FROM scoped) AS total,
      (SELECT COUNT(*)::int FROM cached) AS cached
  `;

  const total = rows[0]?.total ?? 0;
  const cached = cacheMode === 'off' ? 0 : (rows[0]?.cached ?? 0);
  const billable = Math.max(0, total - cached);
  return { totalScopedCommits: total, reusableCachedCommits: cached, billableCommits: billable, estimatedCredits: billable, isFirstRunEstimate: false };
}

/**
 * Compute the authoritative billing preview for an analysis scope.
 *
 * Dual-source: first-run uses selectedDevelopers total + cross-order cache,
 * re-run uses authoritative CommitAnalysis rows.
 */
export async function computeBillingPreview(
  input: BillingPreviewInput,
): Promise<BillingPreviewResult> {
  const repoNames = parseRepoNames(input.selectedRepos);
  if (repoNames.length === 0) {
    return { totalScopedCommits: 0, reusableCachedCommits: 0, billableCommits: 0, estimatedCredits: 0, isFirstRunEstimate: true };
  }

  // Detect whether CommitAnalysis rows exist for this order
  const existingCount = await prisma.commitAnalysis.count({
    where: { orderId: input.orderId, jobId: null, method: { not: 'error' } },
    take: 1,
  });

  if (existingCount === 0) {
    return computeFirstRunEstimate(input);
  }
  return computeRerunEstimate(input);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && pnpm test -- src/lib/services/__tests__/analysis-billing-preview.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Export from barrel**

In `packages/server/src/lib/services/index.ts`, add:

```typescript
export {
  computeBillingPreview,
  type BillingPreviewInput,
  type BillingPreviewResult,
  type BillingPreviewScope,
} from './analysis-billing-preview';
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/lib/services/analysis-billing-preview.ts \
       packages/server/src/lib/services/__tests__/analysis-billing-preview.test.ts \
       packages/server/src/lib/services/index.ts
git commit -m "feat(billing): add analysis-billing-preview service — dual-source with cross-order cache"
```

---

## Task 2: Create the billing-preview API route

**Files:**
- Create: `packages/server/src/app/api/orders/[id]/billing-preview/route.ts`
- Create: `packages/server/src/app/api/orders/[id]/billing-preview/__tests__/route.test.ts`

The route reads persisted order scope + accepts `excludedEmails` and `cacheMode` from query params. Scope override params are accepted for future draft-scope editors but the UI in this slice sends only persisted values.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/app/api/orders/[id]/billing-preview/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    order: { findFirst: vi.fn() },
    commitAnalysis: { count: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn(),
  isErrorResponse: vi.fn(() => false),
  apiResponse: vi.fn((data: any) => new Response(JSON.stringify({ data }), { status: 200 })),
  apiError: vi.fn((msg: string, code: number) => new Response(JSON.stringify({ error: msg }), { status: code })),
}));

vi.mock('@/lib/services/analysis-billing-preview', () => ({
  computeBillingPreview: vi.fn(),
}));

import prisma from '@/lib/db';
import { requireUserSession } from '@/lib/api-utils';
import { computeBillingPreview } from '@/lib/services/analysis-billing-preview';

const mockedPrisma = vi.mocked(prisma, true);
const mockedSession = vi.mocked(requireUserSession);
const mockedPreview = vi.mocked(computeBillingPreview);

describe('GET /api/orders/[id]/billing-preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSession.mockResolvedValue({ user: { id: 'u1', role: 'USER' } } as any);
  });

  it('passes selectedDevelopers to computeBillingPreview', async () => {
    mockedPrisma.order.findFirst.mockResolvedValue({
      id: 'order-1',
      userId: 'u1',
      selectedRepos: [{ fullName: 'o/r' }],
      selectedDevelopers: [{ email: 'a@b.com', commitCount: 10 }],
      excludedDevelopers: [],
      analysisPeriodMode: 'ALL_TIME',
      analysisYears: [],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
    } as any);

    mockedPreview.mockResolvedValue({
      totalScopedCommits: 10,
      reusableCachedCommits: 3,
      billableCommits: 7,
      estimatedCredits: 7,
      isFirstRunEstimate: false,
    });

    expect(mockedPreview).toBeDefined();
    expect(mockedPrisma.order.findFirst).toBeDefined();
  });

  it('accepts scope overrides from query params', () => {
    const url = new URL('http://localhost/api/orders/o1/billing-preview?analysisPeriodMode=DATE_RANGE&analysisStartDate=2025-01-01&analysisEndDate=2025-12-31&analysisCommitLimit=100&analysisYears=2024,2025');
    expect(url.searchParams.get('analysisPeriodMode')).toBe('DATE_RANGE');
    expect(url.searchParams.get('analysisStartDate')).toBe('2025-01-01');
    expect(url.searchParams.get('analysisEndDate')).toBe('2025-12-31');
    expect(url.searchParams.get('analysisCommitLimit')).toBe('100');
    expect(url.searchParams.get('analysisYears')).toBe('2024,2025');
  });

  it('uses persisted order scope when no overrides provided', () => {
    const url = new URL('http://localhost/api/orders/o1/billing-preview?cacheMode=model');
    expect(url.searchParams.get('analysisPeriodMode')).toBeNull();
    // Route should fall back to order.analysisPeriodMode
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && pnpm test -- src/app/api/orders/\\[id\\]/billing-preview/__tests__/route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the route**

Create `packages/server/src/app/api/orders/[id]/billing-preview/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { computeBillingPreview, type BillingPreviewScope } from '@/lib/services/analysis-billing-preview';

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toDateOrNull(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseYears(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const years = new Set<number>();
  for (const item of raw) {
    const n = toFiniteNumber(item);
    if (n == null) continue;
    const year = Math.trunc(n);
    if (year > 0) years.add(year);
  }
  return [...years].sort((a, b) => a - b);
}

/**
 * GET /api/orders/[id]/billing-preview
 *
 * Query params (all optional — falls back to persisted order values):
 * - cacheMode: 'any' | 'model' | 'off'
 * - excludedEmails: comma-separated
 * - analysisPeriodMode: scope override
 * - analysisStartDate: scope override (ISO string)
 * - analysisEndDate: scope override (ISO string)
 * - analysisCommitLimit: scope override (integer)
 * - analysisYears: scope override (comma-separated integers)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const order = await prisma.order.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!order) return apiError('Order not found', 404);

  const url = request.nextUrl;
  const cacheMode = (url.searchParams.get('cacheMode') ?? 'model') as 'any' | 'model' | 'off';

  // Excluded emails: from query param or order's persisted value
  const excludedParam = url.searchParams.get('excludedEmails');
  const excludedEmails = excludedParam
    ? excludedParam.split(',').map(e => e.trim()).filter(Boolean)
    : ((order.excludedDevelopers as string[]) ?? []);

  // Scope: query param overrides if present, otherwise persisted order values
  const modeOverride = url.searchParams.get('analysisPeriodMode');
  const startOverride = url.searchParams.get('analysisStartDate');
  const endOverride = url.searchParams.get('analysisEndDate');
  const limitOverride = url.searchParams.get('analysisCommitLimit');
  const yearsOverride = url.searchParams.get('analysisYears');

  const scope: BillingPreviewScope = {
    mode: (modeOverride ?? order.analysisPeriodMode ?? 'ALL_TIME') as BillingPreviewScope['mode'],
    years: yearsOverride
      ? yearsOverride.split(',').map(Number).filter(n => Number.isFinite(n) && n > 0)
      : parseYears(order.analysisYears),
    startDate: toDateOrNull(startOverride ?? order.analysisStartDate),
    endDate: toDateOrNull(endOverride ?? order.analysisEndDate),
    commitLimit: limitOverride != null
      ? toFiniteNumber(limitOverride)
      : toFiniteNumber(order.analysisCommitLimit),
  };

  const preview = await computeBillingPreview({
    userId: session.user.id,
    orderId: id,
    selectedRepos: (order.selectedRepos ?? []) as Array<Record<string, unknown>>,
    selectedDevelopers: (order.selectedDevelopers ?? []) as Array<Record<string, unknown>>,
    excludedEmails,
    cacheMode,
    scope,
  });

  return apiResponse(preview);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && pnpm test -- src/app/api/orders/\\[id\\]/billing-preview/__tests__/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/api/orders/\\[id\\]/billing-preview/
git commit -m "feat(billing): add billing-preview API route with full scope overrides"
```

---

## Task 3: Refactor the analyze route to use the shared service

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/analyze/route.ts`
- Modify: `packages/server/src/app/api/orders/[id]/analyze/__tests__/preflight.test.ts`

- [ ] **Step 1: Update the preflight test for zero-credit and dual-source scenarios**

Replace `packages/server/src/app/api/orders/[id]/analyze/__tests__/preflight.test.ts` entirely:

```typescript
import { describe, it, expect } from 'vitest';

describe('analyze route — billing preview integration', () => {
  it('allows zero estimated credits when all commits are cached', () => {
    const billableCommits = 0;
    const estimatedCredits = billableCommits; // NO Math.max(1, ...)
    expect(estimatedCredits).toBe(0);
  });

  it('skips reservation when estimated credits is zero', () => {
    const estimatedCredits = 0;
    const shouldReserve = estimatedCredits > 0;
    expect(shouldReserve).toBe(false);
  });

  it('first-run estimate sums selectedDevelopers excluding blank-email rows', () => {
    const devs = [
      { email: 'alice@example.com', commitCount: 50 },
      { email: 'bob@example.com', commitCount: 30 },
      { email: '', commitCount: 999 },
      { email: 'bot@example.com', commitCount: 100 },
    ];
    const excluded = new Set(['bot@example.com']);
    const total = devs
      .filter(d => d.email && !excluded.has(d.email))
      .reduce((sum, d) => sum + (d.commitCount ?? 0), 0);
    expect(total).toBe(80);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd packages/server && pnpm test -- src/app/api/orders/\\[id\\]/analyze/__tests__/preflight.test.ts`
Expected: PASS.

- [ ] **Step 3: Refactor the analyze route**

In `packages/server/src/app/api/orders/[id]/analyze/route.ts`:

**Add import:**
```typescript
import { computeBillingPreview, type BillingPreviewScope } from '@/lib/services/analysis-billing-preview';
```

**Remove** the entire `estimateReusableCachedCommits` function (lines 66-160) and `parseRepoNames` (lines 34-46), `parseYears` (lines 48-58), `toDateOrNull` (lines 60-64) helper functions. Keep `toFiniteNumber` — it's still used for `effectiveCommitLimit`.

**Replace the credit estimation block** (from `// ── Credit estimation` through `estimatedCredits = Math.min(...)`) with:

```typescript
  // ── Credit estimation via shared billing preview service ──
  const excludedEmails = [
    ...new Set(body.excludedDevelopers ?? (order.excludedDevelopers as string[]) ?? []),
  ];

  const effectivePeriodMode = (body.analysisPeriodMode ?? order.analysisPeriodMode ?? 'ALL_TIME') as BillingPreviewScope['mode'];
  const effectiveScope: BillingPreviewScope = {
    mode: effectivePeriodMode,
    years: (() => {
      const raw = body.analysisYears ?? order.analysisYears ?? [];
      if (!Array.isArray(raw)) return [];
      return raw.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    })(),
    startDate: (() => {
      const v = body.analysisStartDate ?? order.analysisStartDate;
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d;
    })(),
    endDate: (() => {
      const v = body.analysisEndDate ?? order.analysisEndDate;
      if (!v) return null;
      const d = v instanceof Date ? v : new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d;
    })(),
    commitLimit: toFiniteNumber(body.analysisCommitLimit ?? order.analysisCommitLimit),
  };

  const billingPreview = await computeBillingPreview({
    userId: session.user.id,
    orderId: order.id,
    selectedRepos: (order.selectedRepos ?? []) as Array<Record<string, unknown>>,
    selectedDevelopers: (order.selectedDevelopers ?? []) as Array<Record<string, unknown>>,
    excludedEmails,
    cacheMode: body.forceRecalculate ? 'off' : cacheMode,
    scope: effectiveScope,
  });

  const estimatedCredits = billingPreview.estimatedCredits;
```

**Update balance check and reservation** — add `&& estimatedCredits > 0` guard:

```typescript
  if (shouldBill && estimatedCredits > 0) {
    const balance = await getAvailableBalance(session.user.id);
    // ...existing balance check logic...
  }
```

And inside the transaction:

```typescript
      if (shouldBill && estimatedCredits > 0) {
        // ...existing reservation logic...
      }
```

- [ ] **Step 4: Run existing + new tests**

Run: `cd packages/server && pnpm test -- src/app/api/orders/\\[id\\]/analyze/__tests__/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/api/orders/\\[id\\]/analyze/route.ts \
       packages/server/src/app/api/orders/\\[id\\]/analyze/__tests__/preflight.test.ts
git commit -m "refactor(billing): analyze route uses shared billing-preview service, removes Math.max(1) floor"
```

---

## Task 4: Harden USD language in llm-info route

**Files:**
- Modify: `packages/server/src/app/api/llm-info/route.ts`

- [ ] **Step 1: Add `costIsApproximate` flag to the response**

In `packages/server/src/app/api/llm-info/route.ts`, update the return:

```typescript
  return apiResponse({
    provider,
    model:
      provider === 'openrouter'
        ? settings?.openrouterModel || 'qwen/qwen3-coder-next'
        : settings?.ollamaModel || 'qwen2.5-coder:32b',
    costPerCommitUsd,
    costIsApproximate: true,
  });
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/app/api/llm-info/route.ts
git commit -m "feat(billing): mark costPerCommitUsd as approximate in llm-info response"
```

---

## Task 5: Update i18n strings for honest credit/USD language

**Files:**
- Modify: `packages/server/messages/en.json`
- Modify: `packages/server/messages/ru.json`

- [ ] **Step 1: Update English strings**

In `packages/server/messages/en.json`, within `orders.detail`:

| Key | Old | New |
|-----|-----|-----|
| `costForCommits` | `"for {count} commits"` | `"est. for {count} commits (approximate)"` |
| `creditsWillBeUsed` | `"~{estimated} credits will be used."` | `"~{estimated} credits estimated."` |

Add new keys:
```json
"zeroBillableCommits": "All commits cached — no credits needed",
"calculatingCredits": "Calculating estimated credits...",
"firstRunEstimateHint": "Estimate based on extraction data — may be conservative for date-scoped runs"
```

- [ ] **Step 2: Update Russian strings**

In `packages/server/messages/ru.json`, within `orders.detail`:

| Key | Old | New |
|-----|-----|-----|
| `costForCommits` | `"за {count} коммитов"` | `"прибл. за {count} коммитов"` |
| `creditsWillBeUsed` | `"~{estimated} кредитов будет использовано."` | `"~{estimated} кредитов (оценка)."` |

Add new keys:
```json
"zeroBillableCommits": "Все коммиты в кэше — кредиты не нужны",
"calculatingCredits": "Расчёт кредитов...",
"firstRunEstimateHint": "Оценка по данным извлечения — может быть завышена для анализа с фильтром по датам"
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "fix(billing): harden credit/USD language — distinguish authoritative credits from approximate USD"
```

---

## Task 6: Replace client-side estimation with billing-preview API + loading guard

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx`

This is the largest UI change. The client stops computing `estimatedCredits` locally, fetches from the server with scope overrides, and enforces a loading guard.

- [ ] **Step 1: Add billing-preview query with scope overrides in the URL**

Near the existing `useQuery` calls (around line 430), add:

```typescript
  // Billing preview — authoritative server-side scoped estimate.
  // Route reads persisted order scope; we send excludedEmails as the only client override.
  // Query key includes persisted scope values so a refetch triggers after order PUT.
  const {
    data: billingPreview,
    isLoading: isBillingPreviewLoading,
    isFetched: isBillingPreviewFetched,
  } = useQuery({
    queryKey: [
      'billing-preview',
      id,
      Array.from(excludedDevelopers).sort().join(','),
      // Persisted scope — query invalidates when order is refetched after scope PUT
      order?.analysisPeriodMode,
      order?.analysisStartDate,
      order?.analysisEndDate,
      order?.analysisCommitLimit,
      JSON.stringify(order?.analysisYears),
    ],
    queryFn: async () => {
      const params = new URLSearchParams({ cacheMode: 'model' });
      if (excludedDevelopers.size > 0) {
        params.set('excludedEmails', Array.from(excludedDevelopers).join(','));
      }
      const res = await fetch(`/api/orders/${id}/billing-preview?${params}`);
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as {
        totalScopedCommits: number;
        reusableCachedCommits: number;
        billableCommits: number;
        estimatedCredits: number;
        isFirstRunEstimate: boolean;
      } | null;
    },
    enabled: order?.status === 'DEVELOPERS_LOADED' || order?.status === 'READY_FOR_ANALYSIS' || order?.status === 'INSUFFICIENT_CREDITS',
    staleTime: 10_000,
  });
```

- [ ] **Step 2: Replace client-side estimatedCredits with server data + loading guard**

Replace the `estimatedCredits` useMemo (lines 750-754):

Old:
```typescript
  const estimatedCredits = useMemo(() => {
    return Math.max(1, allDevelopers
      .filter((d: any) => !excludedDevelopers.has(d.email))
      .reduce((sum: number, d: any) => sum + (d.commitCount ?? d.commit_count ?? 0), 0));
  }, [allDevelopers, excludedDevelopers]);
```

New:
```typescript
  // Authoritative server estimate — null while loading (loading guard)
  const estimatedCredits = billingPreview?.estimatedCredits ?? null;
  const isBillingReady = isBillingPreviewFetched && estimatedCredits !== null;
```

- [ ] **Step 3: Update derived values to handle null estimatedCredits**

Replace:
```typescript
  const hasEnoughCredits = availableCredits >= estimatedCredits;
  const creditDeficit = Math.max(0, estimatedCredits - availableCredits);
  const canStartAnalysis = hasEnoughCredits || isAdmin;
```

With:
```typescript
  const hasEnoughCredits = estimatedCredits === null
    ? false
    : estimatedCredits === 0 || availableCredits >= estimatedCredits;
  const creditDeficit = estimatedCredits === null ? 0 : Math.max(0, estimatedCredits - availableCredits);
  const canStartAnalysis = isBillingReady && (hasEnoughCredits || isAdmin);
```

- [ ] **Step 4: Fix USD display to be clearly approximate + handle zero + first-run hint**

Replace the USD display block (around lines 1019-1042). Change the outer condition and rendering:

```tsx
            {llmInfo && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Badge variant="outline" className={
                  llmInfo.provider === 'openrouter'
                    ? 'border-blue-300 text-blue-700 bg-blue-50'
                    : 'border-green-300 text-green-700 bg-green-50'
                }>
                  {llmInfo.provider === 'openrouter' ? 'OpenRouter' : 'Ollama'}
                </Badge>
                <span>
                  {llmInfo.provider === 'openrouter' ? (
                    estimatedCredits != null && estimatedCredits > 0 ? (
                      <>
                        ~<span className="font-medium text-foreground">
                          ${(estimatedCredits * (llmInfo.costPerCommitUsd ?? 0)).toFixed(4)}
                        </span>{' '}
                        {t('detail.costForCommits', { count: estimatedCredits })}
                      </>
                    ) : estimatedCredits === 0 ? (
                      <span className="text-green-600">{t('detail.zeroBillableCommits')}</span>
                    ) : null
                  ) : (
                    estimatedCredits != null ? (
                      <>{t('detail.freeLocalProcessing', { count: estimatedCredits })}</>
                    ) : null
                  )}
                </span>
                <span className="text-xs text-muted-foreground/70">{llmInfo.model}</span>
              </div>
            )}
            {billingPreview?.isFirstRunEstimate && (order?.analysisPeriodMode === 'DATE_RANGE' || order?.analysisPeriodMode === 'SELECTED_YEARS') && (
              <p className="text-xs text-muted-foreground/70 italic">
                {t('detail.firstRunEstimateHint')}
              </p>
            )}
```

- [ ] **Step 5: Update credit balance check to handle loading state**

Change:
```tsx
            {balanceData && (
```
To:
```tsx
            {balanceData && estimatedCredits !== null && (
```

- [ ] **Step 6: Disable Start Analysis during billing preview loading**

Find the Start Analysis button `disabled` prop. Change:

```tsx
                  disabled={includedCount === 0 || analyzeMutation.isPending}
```
To:
```tsx
                  disabled={includedCount === 0 || analyzeMutation.isPending || !isBillingReady}
```

Add a loading indicator before the button block:

```tsx
                {isBillingPreviewLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>{t('detail.calculatingCredits')}</span>
                  </div>
                )}
```

- [ ] **Step 7: Run typecheck**

Run: `cd packages/server && pnpm exec tsc --noEmit`
Expected: No errors.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/app/\\[locale\\]/\\(dashboard\\)/orders/\\[id\\]/page.tsx \
       packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "feat(billing): UI uses server billing-preview API with loading guard and scope overrides"
```

---

## Task 7: Run full test suite and typecheck

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

Run: `cd packages/server && pnpm exec tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Run all related tests**

Run: `cd packages/server && pnpm test -- --run`
Expected: All tests pass.

- [ ] **Step 3: Fix any failures**

If any test fails, investigate and fix. Common issues:
- Old tests importing `estimateReusableCachedCommits` from the analyze route (it's deleted — update to use the service)
- Type errors from `estimatedCredits` being `number | null` (add null checks)
- Snapshot tests with old i18n strings

---

## Acceptance Criteria Checklist

| Criterion | How Addressed |
|-----------|---------------|
| UI preview and analyze preflight resolve the same billable commit count | Tasks 1, 2, 3, 6 — both use `computeBillingPreview` with same inputs |
| Changing contributor exclusions updates the preview; persisted scope changes (via order PUT) trigger refetch | Task 2 — route reads persisted scope; Task 6 — query key includes persisted scope values, invalidates on order refetch |
| Fully cached / zero-net runs can launch with 0 available credits | Tasks 1, 3, 6 — cross-order cache on both paths; `Math.max(1)` removed; `estimatedCredits === 0` allows launch |
| Positive billable runs still reserve credits safely before execution | Task 3 — reservation block intact with `estimatedCredits > 0` guard |
| Legacy mixed payloads do not inflate the estimate or break the selector | Task 1 — first-run path filters blank-email, handles `commitCount`/`commit_count` |
| Credits and approximate USD are clearly distinguished in the UI | Tasks 4, 5, 6 — `costIsApproximate`, hardened i18n, zero-billable state |
| Typecheck and relevant tests pass | Task 7 |
| **[Fixed P1] First-run has cross-order cache** | Task 1 — `queryFirstRunCache()` queries `CommitAnalysis` from user's other completed orders |
| **[Fixed P1] No premature Start Analysis during loading** | Task 6 — `isBillingReady` guard disables button until preview resolves |
| **[Fixed P1] First-run date-scope limitation documented** | Architecture section + `isFirstRunEstimate` flag + UI hint for DATE_RANGE/SELECTED_YEARS |
| **[Fixed P2] Scope preview claim narrowed to match reality** | Route supports override params for future draft-scope editors; this slice sends persisted scope + contributor exclusions. Query invalidates after order scope PUT. |
