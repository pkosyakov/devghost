# Scope Expansion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to change analysis scope (expand/narrow) on completed orders without losing previously analyzed commits, and only run LLM on truly new commits.

**Architecture:** Immutable CommitAnalysis records + scope-filtered metrics. A shared `getInScopeCommits()` utility provides consistent filtering across metrics calculation, commits API, and timeline API. The analysis worker computes a SHA diff to determine which commits need LLM analysis vs which already exist.

**Tech Stack:** Next.js API routes, Prisma ORM (PostgreSQL), React + TanStack Query, shadcn/ui components.

**Design doc:** `docs/plans/2026-02-22-scope-expansion-design.md`

---

### Task 1: Shared scope filter utility — `scope-filter.ts`

**Files:**
- Create: `packages/server/src/lib/services/scope-filter.ts`
- Create: `packages/server/src/lib/services/__tests__/scope-filter.test.ts`

This is the foundation that everything else depends on. All consumers (metrics, commits API, timeline API, worker diff) will use this.

**Step 1: Write the failing test**

```typescript
// packages/server/src/lib/services/__tests__/scope-filter.test.ts
import { describe, it, expect } from 'vitest';
import { buildScopeWhereClause } from '../scope-filter';

describe('buildScopeWhereClause', () => {
  it('ALL_TIME returns base filter only', () => {
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'ALL_TIME',
      analysisYears: [],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
    });
    expect(where).toEqual({
      orderId: 'order-1',
      jobId: null,
      method: { not: 'error' },
    });
  });

  it('DATE_RANGE adds authorDate filter', () => {
    const start = new Date('2025-01-01');
    const end = new Date('2025-12-31');
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'DATE_RANGE',
      analysisYears: [],
      analysisStartDate: start,
      analysisEndDate: end,
      analysisCommitLimit: null,
    });
    expect(where).toEqual({
      orderId: 'order-1',
      jobId: null,
      method: { not: 'error' },
      authorDate: { gte: start, lte: end },
    });
  });

  it('LAST_N_COMMITS returns base filter (limit applied separately)', () => {
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'LAST_N_COMMITS',
      analysisYears: [],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: 100,
    });
    expect(where).toEqual({
      orderId: 'order-1',
      jobId: null,
      method: { not: 'error' },
    });
  });

  it('SELECTED_YEARS with empty array returns impossible filter', () => {
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'SELECTED_YEARS',
      analysisYears: [],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
    });
    expect(where.orderId).toBe('__impossible__');
  });

  it('SELECTED_YEARS builds OR of per-year date ranges', () => {
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'SELECTED_YEARS',
      analysisYears: [2022, 2024],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
    });
    // Must NOT include 2023 — OR of two disjoint year ranges
    expect(where).toEqual({
      orderId: 'order-1',
      jobId: null,
      method: { not: 'error' },
      OR: [
        { authorDate: { gte: new Date('2022-01-01T00:00:00Z'), lt: new Date('2023-01-01T00:00:00Z') } },
        { authorDate: { gte: new Date('2024-01-01T00:00:00Z'), lt: new Date('2025-01-01T00:00:00Z') } },
      ],
    });
  });

  it('SELECTED_YEARS with contiguous years still uses per-year OR', () => {
    const where = buildScopeWhereClause('order-1', {
      analysisPeriodMode: 'SELECTED_YEARS',
      analysisYears: [2024, 2025],
      analysisStartDate: null,
      analysisEndDate: null,
      analysisCommitLimit: null,
    });
    expect(where.OR).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/server && pnpm test -- --run src/lib/services/__tests__/scope-filter.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// packages/server/src/lib/services/scope-filter.ts
import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';

/**
 * Order scope fields needed for filtering.
 */
export interface ScopeConfig {
  analysisPeriodMode: string;
  analysisYears: number[];
  analysisStartDate: Date | null;
  analysisEndDate: Date | null;
  analysisCommitLimit: number | null;
}

/**
 * Build Prisma WHERE clause for in-scope CommitAnalysis records.
 * For LAST_N_COMMITS, the limit is applied via orderBy+take, not WHERE.
 * For SELECTED_YEARS, builds OR of per-year date ranges (handles gaps like [2022, 2024]).
 */
export function buildScopeWhereClause(
  orderId: string,
  scope: ScopeConfig,
): Prisma.CommitAnalysisWhereInput {
  const base: Prisma.CommitAnalysisWhereInput = {
    orderId,
    jobId: null,
    method: { not: 'error' },
  };

  switch (scope.analysisPeriodMode) {
    case 'DATE_RANGE':
      if (scope.analysisStartDate && scope.analysisEndDate) {
        return { ...base, authorDate: { gte: scope.analysisStartDate, lte: scope.analysisEndDate } };
      }
      return base;

    case 'SELECTED_YEARS':
      if (scope.analysisYears.length === 0) {
        return { orderId: '__impossible__', jobId: null }; // returns 0 rows
      }
      return {
        ...base,
        OR: scope.analysisYears.map(year => ({
          authorDate: {
            gte: new Date(`${year}-01-01T00:00:00Z`),
            lt: new Date(`${year + 1}-01-01T00:00:00Z`),
          },
        })),
      };

    case 'LAST_N_COMMITS':
    case 'ALL_TIME':
    default:
      return base;
  }
}

/**
 * Fetch in-scope CommitAnalysis records for an order.
 * Single source of truth for metrics, commits API, and timeline API.
 */
export async function getInScopeCommits(
  orderId: string,
  scope: ScopeConfig,
  options?: {
    select?: Prisma.CommitAnalysisSelect;
    orderBy?: Prisma.CommitAnalysisOrderByWithRelationInput;
    skip?: number;
    take?: number;
  },
) {
  const where = buildScopeWhereClause(orderId, scope);

  // For LAST_N_COMMITS: apply global limit via take (sorted by date DESC)
  const isLastN = scope.analysisPeriodMode === 'LAST_N_COMMITS' && scope.analysisCommitLimit;
  const effectiveOrderBy = options?.orderBy ?? (isLastN ? { authorDate: 'desc' as const } : undefined);
  const effectiveTake = isLastN && !options?.take ? scope.analysisCommitLimit! : options?.take;

  return prisma.commitAnalysis.findMany({
    where,
    select: options?.select,
    orderBy: effectiveOrderBy,
    skip: options?.skip,
    take: effectiveTake,
  });
}

/**
 * Count in-scope commits (for pagination, totalCommits update).
 * For LAST_N_COMMITS: returns min(actual count, limit).
 */
export async function countInScopeCommits(
  orderId: string,
  scope: ScopeConfig,
): Promise<number> {
  const where = buildScopeWhereClause(orderId, scope);
  const count = await prisma.commitAnalysis.count({ where });

  if (scope.analysisPeriodMode === 'LAST_N_COMMITS' && scope.analysisCommitLimit) {
    return Math.min(count, scope.analysisCommitLimit);
  }
  return count;
}

/**
 * Get in-scope commit SHAs as Set. Used by worker to compute diff.
 */
export async function getInScopeShas(
  orderId: string,
  scope: ScopeConfig,
): Promise<Set<string>> {
  const commits = await getInScopeCommits(orderId, scope, {
    select: { commitHash: true },
  });
  return new Set(commits.map((c: { commitHash: string }) => c.commitHash));
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/server && pnpm test -- --run src/lib/services/__tests__/scope-filter.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/server/src/lib/services/scope-filter.ts packages/server/src/lib/services/__tests__/scope-filter.test.ts
git commit -m "feat(scope): add shared scope filter utility with tests"
```

---

### Task 2: Atomic analyze endpoint with scope update + forceRecalculate

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/analyze/route.ts`
- Modify: `packages/server/src/lib/services/analysis-worker.ts` (lines 58-66)

Instead of two separate calls (PUT scope + POST analyze), make the analyze endpoint handle both atomically.

**Step 1: Extend analyze route to accept scope fields and forceRecalculate**

```typescript
// packages/server/src/app/api/orders/[id]/analyze/route.ts
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { analysisLogger } from '@/lib/logger';

interface AnalyzeRequestBody {
  cacheMode?: string;
  forceRecalculate?: boolean;
  // Optional scope update fields — if present, update order before analyzing
  analysisPeriodMode?: string;
  analysisStartDate?: string;
  analysisEndDate?: string;
  analysisCommitLimit?: number | null;
  analysisYears?: number[];
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const order = await prisma.order.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!order) return apiError('Order not found', 404);

  if (order.status === 'PROCESSING') {
    return apiError('Analysis already in progress', 409);
  }

  const body = await request.json().catch(() => ({})) as AnalyzeRequestBody;
  const cacheMode = (['any', 'model', 'off'] as const).find(m => m === body.cacheMode) ?? 'model';

  // Atomic: update scope + create job + set PROCESSING in one transaction
  const hasScopeUpdate = body.analysisPeriodMode !== undefined;

  const job = await prisma.$transaction(async (tx) => {
    // 1. Update scope if provided
    if (hasScopeUpdate) {
      const scopeData: Record<string, unknown> = {};
      if (body.analysisPeriodMode !== undefined) scopeData.analysisPeriodMode = body.analysisPeriodMode;
      if (body.analysisStartDate !== undefined) scopeData.analysisStartDate = new Date(body.analysisStartDate);
      if (body.analysisEndDate !== undefined) scopeData.analysisEndDate = new Date(body.analysisEndDate);
      if (body.analysisCommitLimit !== undefined) scopeData.analysisCommitLimit = body.analysisCommitLimit;
      if (body.analysisYears !== undefined) scopeData.analysisYears = body.analysisYears;
      await tx.order.update({ where: { id }, data: scopeData });
    }

    // 2. Create job
    const newJob = await tx.analysisJob.create({
      data: { orderId: id, status: 'PENDING' },
    });

    // 3. Set order to PROCESSING
    await tx.order.update({
      where: { id },
      data: { status: 'PROCESSING' },
    });

    return newJob;
  });

  processAnalysisJob(job.id, {
    cacheMode,
    forceRecalculate: body.forceRecalculate === true,
  }).catch((error) => {
    analysisLogger.error({ err: error, jobId: job.id, orderId: id }, 'Pipeline failed');
  });

  return apiResponse({ jobId: job.id, status: 'PROCESSING' });
}
```

**Step 2: Add `forceRecalculate` to worker options interface**

In `packages/server/src/lib/services/analysis-worker.ts`, add to `AnalysisJobOptions` (line 58-66):

```typescript
interface AnalysisJobOptions {
  isBenchmark?: boolean;
  llmConfigOverride?: LlmConfig;
  noLlmCache?: boolean;
  contextLength?: number;
  failFast?: boolean;
  promptRepeat?: boolean;
  cacheMode?: 'any' | 'model' | 'off';
  forceRecalculate?: boolean;  // delete in-scope commits and re-analyze from scratch
}
```

**Step 3: Commit**

```bash
git add packages/server/src/app/api/orders/[id]/analyze/route.ts packages/server/src/lib/services/analysis-worker.ts
git commit -m "feat(scope): atomic analyze endpoint with scope update + forceRecalculate

Single transaction: update scope → create job → set PROCESSING.
No partial state if any step fails."
```

---

### Task 3: Replace deleteMany with smart diff in analysis worker

This is the core change. Replace the "delete all + re-analyze all" logic with "diff + analyze only new".

**Files:**
- Modify: `packages/server/src/lib/services/analysis-worker.ts` (lines 134-139, 264-300, 448-451)

**Step 1: Replace deleteMany block (lines 134-139)**

```typescript
// Before (lines 134-139):
if (!options.isBenchmark) {
  const deletedCommits = await prisma.commitAnalysis.deleteMany({ where: { orderId: order.id, jobId: null } });
  const deletedMetrics = await prisma.orderMetric.deleteMany({ where: { orderId: order.id } });
  log.info({ deletedCommits: deletedCommits.count, deletedMetrics: deletedMetrics.count }, 'Cleared old data');
}

// After:
if (!options.isBenchmark) {
  // Always clear metrics + DailyEffort — they'll be recalculated from in-scope commits
  const deletedMetrics = await prisma.orderMetric.deleteMany({ where: { orderId: order.id } });
  const deletedEffort = await prisma.dailyEffort.deleteMany({ where: { orderId: order.id } });
  log.info({ deletedMetrics: deletedMetrics.count, deletedEffort: deletedEffort.count }, 'Cleared old metrics and effort');

  if (options.forceRecalculate) {
    // Force: delete only IN-SCOPE CommitAnalysis, preserve out-of-scope
    const scopeConfig: ScopeConfig = {
      analysisPeriodMode: order.analysisPeriodMode,
      analysisYears: order.analysisYears,
      analysisStartDate: order.analysisStartDate,
      analysisEndDate: order.analysisEndDate,
      analysisCommitLimit: order.analysisCommitLimit,
    };
    const inScopeShas = await getInScopeShas(order.id, scopeConfig);
    if (inScopeShas.size > 0) {
      const deletedCommits = await prisma.commitAnalysis.deleteMany({
        where: { orderId: order.id, jobId: null, commitHash: { in: [...inScopeShas] } },
      });
      log.info({ deletedCommits: deletedCommits.count }, 'Force recalculate — cleared in-scope commits');
    }
  }
}
```

Add import at the top of the file:
```typescript
import { type ScopeConfig, getInScopeShas } from '@/lib/services/scope-filter';
```

**Step 2: Add intra-order dedup after cross-order cache (after line ~262)**

Insert after the `commits.length === 0` → continue block, before the cross-order cache block:

```typescript
      // Intra-order dedup: skip commits already analyzed in THIS order (unless force)
      if (!options.forceRecalculate && !options.isBenchmark) {
        const existingInOrder = await prisma.commitAnalysis.findMany({
          where: { orderId: order.id, jobId: null, method: { not: 'error' }, commitHash: { in: commits.map(c => c.sha) } },
          select: { commitHash: true },
        });
        const existingSet = new Set(existingInOrder.map(c => c.commitHash));
        if (existingSet.size > 0) {
          rlog.info({ existing: existingSet.size, total: commits.length }, 'Intra-order dedup — skipping already analyzed');
          totalAnalyzed += existingSet.size;
          commits = commits.filter(c => !existingSet.has(c.sha));
        }
      }

      if (commits.length === 0) {
        rlog.info('All commits already in order, skipping pipeline');
        if (!options.isBenchmark) {
          await prisma.order.update({
            where: { id: order.id },
            data: { repositoriesProcessed: { increment: 1 } },
          });
        }
        continue;
      }
```

**Step 3: Fix totalAnalyzed === 0 guard (lines 448-451)**

```typescript
// Before (lines 448-451):
if (totalAnalyzed === 0) {
  throw new Error('No commits were analyzed — all repositories failed or had no commits in the selected period');
}

// After:
if (totalAnalyzed === 0) {
  // Check if there are ANY successful CommitAnalysis for this order (narrow/re-run scenario)
  const existingCount = await prisma.commitAnalysis.count({
    where: { orderId: order.id, jobId: null, method: { not: 'error' } },
  });
  if (existingCount === 0) {
    throw new Error('No commits were analyzed — all repositories failed or had no commits in the selected period');
  }
  log.info({ existingCount }, 'No new commits to analyze — proceeding to metrics recalculation');
}
```

**Step 4: Run tests**

Run: `cd packages/server && pnpm test -- --run`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/server/src/lib/services/analysis-worker.ts
git commit -m "feat(scope): replace deleteMany with smart diff in analysis worker

- Keep CommitAnalysis immutable (forceRecalculate deletes only in-scope)
- Add intra-order dedup: skip commits already analyzed in this order
- Allow toAnalyze=0 path for scope narrowing / same-scope re-run
- Clear all DailyEffort upfront to prevent stale rows from excluded devs"
```

---

### Task 4: Change LAST_N_COMMITS extraction to global N with pre-pipeline truncation

**Files:**
- Modify: `packages/server/src/lib/services/analysis-worker.ts` (lines 741-779, and extraction flow)

Currently `buildCommitScope` returns `{ maxCount: N }` which is applied per-repo via `git log --max-count=N`. For global N semantics, we need to extract from all repos, merge, sort, and truncate BEFORE sending to pipeline to avoid wasting LLM tokens.

**Step 1: Change buildCommitScope for LAST_N_COMMITS**

```typescript
// In buildCommitScope (lines 748-753), replace:
if (
  order.analysisPeriodMode === 'LAST_N_COMMITS' &&
  order.analysisCommitLimit
) {
  return { maxCount: order.analysisCommitLimit };
}

// With:
if (
  order.analysisPeriodMode === 'LAST_N_COMMITS' &&
  order.analysisCommitLimit
) {
  // Per-repo: extract generous buffer. Global truncation happens after merge.
  // Use 2x limit for git extraction efficiency (cheap git op, avoids full history load).
  return { maxCount: order.analysisCommitLimit * 2 };
}
```

**Step 2: Add global truncation BEFORE pipeline, AFTER extraction**

In the repo processing loop, after extracting commits and after intra-order dedup, but BEFORE the cross-order cache and pipeline steps, add a "global budget" mechanism.

Add a variable before the repo loop:

```typescript
// For LAST_N_COMMITS: track global budget across repos
const isLastN = order.analysisPeriodMode === 'LAST_N_COMMITS' && order.analysisCommitLimit;
let globalBudgetRemaining = isLastN ? order.analysisCommitLimit! : Infinity;
```

Inside the repo loop, after intra-order dedup, before cross-order cache:

```typescript
      // Global LAST_N truncation: limit total commits sent to pipeline across all repos
      if (isLastN && commits.length > 0) {
        if (globalBudgetRemaining <= 0) {
          rlog.info({ budget: 0 }, 'Global commit budget exhausted, skipping repo');
          continue;
        }
        if (commits.length > globalBudgetRemaining) {
          // Sort by date DESC, take only what fits in budget
          commits.sort((a, b) => new Date(b.authorDate).getTime() - new Date(a.authorDate).getTime());
          commits = commits.slice(0, globalBudgetRemaining);
          rlog.info({ truncatedTo: commits.length }, 'Truncated to global budget');
        }
      }
```

After the pipeline processes and saves results for this repo, deduct from budget:

```typescript
      // Deduct from global budget
      if (isLastN) {
        globalBudgetRemaining -= analyzedInThisRepo;
      }
```

This ensures total LLM calls across all repos never exceed N (the commit limit).

**Step 3: Commit**

```bash
git add packages/server/src/lib/services/analysis-worker.ts
git commit -m "feat(scope): LAST_N_COMMITS global truncation before pipeline

Pre-pipeline budget prevents wasting LLM tokens on out-of-scope commits.
Git extraction uses 2x buffer (cheap), but pipeline receives at most N total."
```

---

### Task 5: Wire scope filter into ghost-metrics-service + clear all DailyEffort

**Files:**
- Modify: `packages/server/src/lib/services/ghost-metrics-service.ts` (lines 27-38, 121-124)

**Step 1: Replace CommitAnalysis include with scope-filtered query**

```typescript
// Before (lines 32-38):
const order = await prisma.order.findFirst({
  where: { id: orderId, userId },
  include: {
    commitAnalyses: {
      where: { jobId: null },
    },
  },
});

// After:
import { getInScopeCommits, type ScopeConfig } from '@/lib/services/scope-filter';

const order = await prisma.order.findFirst({
  where: { id: orderId, userId },
});
if (!order) throw new Error(`Order not found: ${orderId}`);

const scopeConfig: ScopeConfig = {
  analysisPeriodMode: order.analysisPeriodMode,
  analysisYears: order.analysisYears,
  analysisStartDate: order.analysisStartDate,
  analysisEndDate: order.analysisEndDate,
  analysisCommitLimit: order.analysisCommitLimit,
};

const commitAnalyses = await getInScopeCommits(orderId, scopeConfig);
```

Then replace all `order.commitAnalyses` with `commitAnalyses` in the function body.

**Step 2: Remove per-developer DailyEffort delete**

Since Task 3 already clears ALL DailyEffort for the order upfront (before metrics calculation), the per-developer `deleteMany` in ghost-metrics-service (lines 121-124) is now redundant. Remove it to avoid redundant queries:

```typescript
// Remove these lines (121-124):
// await prisma.dailyEffort.deleteMany({
//   where: { orderId, developerEmail: email },
// });
```

The upfront delete in analysis-worker ensures no stale DailyEffort rows from developers who fell out of scope.

**Step 3: Run tests**

Run: `cd packages/server && pnpm test -- --run`
Expected: PASS

**Step 4: Commit**

```bash
git add packages/server/src/lib/services/ghost-metrics-service.ts
git commit -m "feat(scope): wire scope filter into ghost metrics calculation

- Use getInScopeCommits() instead of include: commitAnalyses
- Remove per-developer DailyEffort delete (cleared upfront in worker)"
```

---

### Task 6: Wire scope filter into commits API

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/commits/route.ts`

**Step 1: Extend `getOrderWithAuth` to include scope fields and apply filter**

The route currently uses `getOrderWithAuth(id, { select: { id: true, status: true } })`. Extend the select to include scope config fields:

```typescript
import { buildScopeWhereClause, type ScopeConfig } from '@/lib/services/scope-filter';

const result = await getOrderWithAuth(id, {
  select: {
    id: true,
    status: true,
    analysisPeriodMode: true,
    analysisYears: true,
    analysisStartDate: true,
    analysisEndDate: true,
    analysisCommitLimit: true,
  },
});
if (!result.success) {
  return orderAuthError(result);
}
const order = result.order;

const scopeWhere = buildScopeWhereClause(id, order as unknown as ScopeConfig);
```

Replace the existing WHERE clause construction (lines 64-81):

```typescript
// Merge scope filter with user filters
const where: Prisma.CommitAnalysisWhereInput = {
  ...scopeWhere,
  ...(authorEmail && { authorEmail }),
  ...(category && { category }),
  ...(complexity && { complexity }),
};

// For LAST_N_COMMITS: pre-fetch in-scope SHAs, then paginate within them
if (order.analysisPeriodMode === 'LAST_N_COMMITS' && order.analysisCommitLimit) {
  const inScopeShas = await prisma.commitAnalysis.findMany({
    where: scopeWhere,
    orderBy: { authorDate: 'desc' as const },
    take: order.analysisCommitLimit,
    select: { commitHash: true },
  });
  where.commitHash = { in: inScopeShas.map((c: { commitHash: string }) => c.commitHash) };
}
```

**Step 2: Commit**

```bash
git add packages/server/src/app/api/orders/[id]/commits/route.ts
git commit -m "feat(scope): apply scope filter to commits API endpoint"
```

---

### Task 7: Wire scope filter into effort-timeline API

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/effort-timeline/route.ts`

**Step 1: Scope-filter the developer distinct query**

The DailyEffort data is already clean (cleared upfront in Task 3, recalculated from in-scope commits in Task 5). But the developer list query on CommitAnalysis needs scope filtering.

For LAST_N_COMMITS, we need a two-step: get in-scope SHAs first, then get distinct developers from those.

```typescript
import { buildScopeWhereClause, type ScopeConfig } from '@/lib/services/scope-filter';

// Fetch order scope config (extend existing order fetch)
const order = await prisma.order.findFirst({
  where: { id, userId: session.user.id },
  select: {
    analysisPeriodMode: true,
    analysisYears: true,
    analysisStartDate: true,
    analysisEndDate: true,
    analysisCommitLimit: true,
  },
});

const scopeWhere = buildScopeWhereClause(id, order as unknown as ScopeConfig);

// For LAST_N_COMMITS: get in-scope SHAs first
let developerWhere: Prisma.CommitAnalysisWhereInput = scopeWhere;
if (order.analysisPeriodMode === 'LAST_N_COMMITS' && order.analysisCommitLimit) {
  const inScopeShas = await prisma.commitAnalysis.findMany({
    where: scopeWhere,
    orderBy: { authorDate: 'desc' as const },
    take: order.analysisCommitLimit,
    select: { commitHash: true },
  });
  developerWhere = { ...scopeWhere, commitHash: { in: inScopeShas.map(c => c.commitHash) } };
}

// Replace the developer distinct query:
prisma.commitAnalysis.findMany({
  where: developerWhere,
  select: { authorEmail: true, authorName: true },
  distinct: ['authorEmail'],
})
```

**Step 2: Commit**

```bash
git add packages/server/src/app/api/orders/[id]/effort-timeline/route.ts
git commit -m "feat(scope): apply scope filter to effort-timeline API endpoint"
```

---

### Task 8: Update totalCommits on Order after analysis

**Files:**
- Modify: `packages/server/src/lib/services/analysis-worker.ts` (COMPLETED section, ~line 470+)

**Step 1: Count in-scope commits and set totalCommits**

After metrics are calculated, before marking COMPLETED:

```typescript
import { countInScopeCommits } from '@/lib/services/scope-filter';

// After metrics calculation:
const scopeConfig: ScopeConfig = {
  analysisPeriodMode: order.analysisPeriodMode,
  analysisYears: order.analysisYears,
  analysisStartDate: order.analysisStartDate,
  analysisEndDate: order.analysisEndDate,
  analysisCommitLimit: order.analysisCommitLimit,
};
const inScopeCount = await countInScopeCommits(order.id, scopeConfig);

// In the order update that marks COMPLETED, set totalCommits:
await prisma.order.update({
  where: { id: order.id },
  data: {
    status: 'COMPLETED',
    totalCommits: inScopeCount,
    // ... other existing fields
  },
});
```

**Step 2: Commit**

```bash
git add packages/server/src/lib/services/analysis-worker.ts
git commit -m "feat(scope): update totalCommits to in-scope count after analysis"
```

---

### Task 9: Add SELECTED_YEARS validation to PUT endpoint

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/route.ts` (after line 101)

**Step 1: Add validation block**

```typescript
// After the LAST_N_COMMITS validation block (line 101), add:
if (analysisPeriodMode === 'SELECTED_YEARS') {
  if (!analysisYears || !Array.isArray(analysisYears) || analysisYears.length === 0) {
    return apiError('At least one year is required for SELECTED_YEARS mode', 400);
  }
}
```

**Step 2: Commit**

```bash
git add packages/server/src/app/api/orders/[id]/route.ts
git commit -m "fix(scope): validate non-empty analysisYears for SELECTED_YEARS mode"
```

---

### Task 10: Edit Scope UI panel component

**Files:**
- Create: `packages/server/src/components/edit-scope-panel.tsx`

This component reuses the existing `AnalysisPeriodSelector` for the scope settings form. `AnalysisPeriodSelector` supports modes: `ALL_TIME`, `DATE_RANGE`, `LAST_N_COMMITS`. It does NOT support `SELECTED_YEARS` (which is a backend-only legacy enum not exposed in UI). If the order was somehow created with `SELECTED_YEARS`, the panel converts it to `DATE_RANGE` with the corresponding year boundaries for display.

**Step 1: Create the component**

```typescript
// packages/server/src/components/edit-scope-panel.tsx
'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Loader2, Settings2 } from 'lucide-react';
import {
  AnalysisPeriodSelector,
  type AnalysisPeriodSettings,
} from '@/components/analysis-period-selector';

interface EditScopePanelProps {
  currentSettings: AnalysisPeriodSettings;
  currentCommitCount: number;
  onSubmit: (settings: AnalysisPeriodSettings, forceRecalculate: boolean) => void;
  onCancel: () => void;
  isSubmitting: boolean;
  availableStartDate?: Date;
  availableEndDate?: Date;
}

export function EditScopePanel({
  currentSettings,
  currentCommitCount,
  onSubmit,
  onCancel,
  isSubmitting,
  availableStartDate,
  availableEndDate,
}: EditScopePanelProps) {
  const [settings, setSettings] = useState<AnalysisPeriodSettings>(currentSettings);
  const [forceRecalculate, setForceRecalculate] = useState(false);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Settings2 className="h-4 w-4" />
          Edit Analysis Scope
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <AnalysisPeriodSelector
          settings={settings}
          onChange={setSettings}
          availableStartDate={availableStartDate}
          availableEndDate={availableEndDate}
        />

        <div className="flex items-center space-x-2">
          <Checkbox
            id="force-recalculate"
            checked={forceRecalculate}
            onCheckedChange={(checked) => setForceRecalculate(checked === true)}
          />
          <Label htmlFor="force-recalculate" className="text-sm text-muted-foreground">
            Recalculate all commits (ignore cache)
          </Label>
        </div>

        <div className="flex gap-2 pt-2">
          <Button
            onClick={() => onSubmit(settings, forceRecalculate)}
            disabled={isSubmitting}
            size="sm"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save & Analyze
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
```

**Step 2: Commit**

```bash
git add packages/server/src/components/edit-scope-panel.tsx
git commit -m "feat(scope): add EditScopePanel component"
```

---

### Task 11: Integrate Edit Scope into order detail page

**Files:**
- Modify: `packages/server/src/app/(dashboard)/orders/[id]/page.tsx` (lines 994-1006, 217-236)

**Step 1: Add Edit Scope button next to Re-analyze**

After the Re-analyze button (line 1006), add:

```typescript
<Button
  variant="outline"
  size="sm"
  onClick={() => setShowEditScope(!showEditScope)}
>
  <Settings2 className="h-4 w-4 mr-2" />
  Edit Scope
</Button>
```

Add state at the top of the component:

```typescript
const [showEditScope, setShowEditScope] = useState(false);
```

**Step 2: Add EditScopePanel below header**

After the header section and before the metrics cards, render the panel when `showEditScope` is true:

```typescript
import type { AnalysisPeriodMode } from '@/hooks/use-analysis-period';

// Convert SELECTED_YEARS to DATE_RANGE for UI (SELECTED_YEARS not supported in selector)
function orderToScopeSettings(order: OrderData): AnalysisPeriodSettings {
  if (order.analysisPeriodMode === 'SELECTED_YEARS' && order.analysisYears?.length) {
    const minYear = Math.min(...order.analysisYears);
    const maxYear = Math.max(...order.analysisYears);
    return {
      mode: 'DATE_RANGE',
      startDate: new Date(`${minYear}-01-01`),
      endDate: new Date(`${maxYear}-12-31`),
    };
  }
  return {
    mode: order.analysisPeriodMode as AnalysisPeriodMode,
    startDate: order.analysisStartDate ? new Date(order.analysisStartDate) : undefined,
    endDate: order.analysisEndDate ? new Date(order.analysisEndDate) : undefined,
    commitLimit: order.analysisCommitLimit ?? undefined,
  };
}

// In JSX:
{showEditScope && order.status === 'COMPLETED' && (
  <EditScopePanel
    currentSettings={orderToScopeSettings(order)}
    currentCommitCount={order.totalCommits}
    onSubmit={handleScopeSubmit}
    onCancel={() => setShowEditScope(false)}
    isSubmitting={scopeMutation.isPending}
    availableStartDate={order.availableStartDate ? new Date(order.availableStartDate) : undefined}
    availableEndDate={order.availableEndDate ? new Date(order.availableEndDate) : undefined}
  />
)}
```

**Step 3: Add mutation — single atomic call**

```typescript
const scopeMutation = useMutation({
  mutationFn: async ({ settings, forceRecalculate }: { settings: AnalysisPeriodSettings; forceRecalculate: boolean }) => {
    const res = await fetch(`/api/orders/${id}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        analysisPeriodMode: settings.mode,
        analysisStartDate: settings.startDate?.toISOString(),
        analysisEndDate: settings.endDate?.toISOString(),
        analysisCommitLimit: settings.commitLimit,
        forceRecalculate,
      }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || 'Analysis failed');
    }
    return res.json();
  },
  onSuccess: (data) => {
    setShowEditScope(false);
    setAnalysisStarted(true);
    setAnalysisJobId(data.data?.jobId ?? null);
    setPipelineLog([]);
    logSinceRef.current = 0;
    queryClient.removeQueries({ queryKey: ['progress', id] });
    queryClient.invalidateQueries({ queryKey: ['order', id] });
    queryClient.invalidateQueries({ queryKey: ['metrics', id] });
  },
});

const handleScopeSubmit = (settings: AnalysisPeriodSettings, forceRecalculate: boolean) => {
  scopeMutation.mutate({ settings, forceRecalculate });
};
```

**Step 4: Verify manually**

1. Open completed order page
2. Click "Edit Scope"
3. Change limit from 100 to 200
4. Click "Save & Analyze"
5. Verify: order goes to PROCESSING, progress shows, completes with ~200 commits
6. Verify: only ~100 new commits went through LLM (check pipeline log)
7. Click "Edit Scope" again, change to 50 → Save & Analyze
8. Verify: no LLM calls, only metrics recalculation, completes with 50 commits

**Step 5: Commit**

```bash
git add packages/server/src/app/(dashboard)/orders/[id]/page.tsx
git commit -m "feat(scope): integrate Edit Scope panel into order detail page

Single atomic POST to /analyze with scope fields.
SELECTED_YEARS auto-converted to DATE_RANGE for UI."
```

---

## Task Dependency Graph

```
Task 1 (scope-filter.ts)
  ├─→ Task 3 (smart diff in worker) ─→ Task 4 (LAST_N global truncation)
  ├─→ Task 5 (ghost-metrics-service)
  ├─→ Task 6 (commits API)
  ├─→ Task 7 (effort-timeline API)
  └─→ Task 8 (totalCommits update)

Task 2 (atomic analyze endpoint) ─→ Task 3, Task 11

Task 9 (SELECTED_YEARS validation) — independent

Task 10 (EditScopePanel component) — independent
  └─→ Task 11 (integrate into page) — depends on 2, 10
```

Tasks 1, 2, 9, 10 can be started in parallel.
