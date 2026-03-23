# Scope Expansion — Design Document

**Date**: 2026-02-22
**Updated**: 2026-02-23 (review fixes)
**Status**: Approved
**Author**: hands

## Problem

When an order is completed (e.g. `ykosyakov/proseona` with LAST_N_COMMITS=100), there is no way to expand or narrow the analysis scope without triggering a full re-analysis that deletes all existing CommitAnalysis records and re-runs the entire LLM pipeline from scratch. This wastes tokens and time.

## Goals

1. Allow users to change analysis scope on a completed order (expand or narrow)
2. Preserve all previously analyzed commits physically — never delete CommitAnalysis records on scope change
3. Support incremental analysis: only run LLM on commits not yet analyzed in this order
4. Give users control over cache: option to force recalculate all in-scope commits
5. Support all period modes: LAST_N_COMMITS, ALL_TIME, DATE_RANGE, SELECTED_YEARS

## Non-Goals

- Adding/removing repositories from an existing order (separate feature)
- Changing developer mapping during scope edit
- Modifying commits analyzed in other orders

---

## Design

### 1. Data Model — Immutable CommitAnalysis

**Core principle**: CommitAnalysis records are immutable once created. Scope determines which records participate in metrics calculation, not which records exist.

**Changes to `analysis-worker.ts`:**
- Remove `prisma.commitAnalysis.deleteMany()` from the re-analysis flow (currently line ~135)
- Before running the pipeline, compute the diff between new scope commits and existing CommitAnalysis
- Only send new (unanalyzed) commits through LLM/cache pipeline

**No schema changes required.** Existing fields are sufficient:
- `CommitAnalysis.authorDate` — used for scope filtering
- `CommitAnalysis.commitHash` — used for diff calculation
- `Order.analysisPeriodMode`, `analysisCommitLimit`, `analysisStartDate`, `analysisEndDate`, `analysisYears` — scope configuration

### 2. Smart Analyze Pipeline

#### Normal flow (expand/narrow/re-run):

```
1. Extract commits from git by NEW scope         → newScopeSet (Set<sha>)
2. Find existing SUCCESSFUL CommitAnalysis        → existingSet (Set<sha>)
      in THIS order (method != 'error')
3. Compute diff:
   - toAnalyze   = newScopeSet - existingSet      → run through LLM/cache
   - toKeep      = newScopeSet ∩ existingSet       → nothing to do
   - outOfScope  = existingSet - newScopeSet       → keep physically, exclude from metrics
4. If toAnalyze is empty:
   → skip pipeline, go directly to step 6          (valid for narrow / re-run same scope)
5. For toAnalyze: check cross-order cache → LLM for remainder
   Save new CommitAnalysis records
6. Recalculate metrics using ONLY newScopeSet commits
7. Mark job COMPLETED (even if toAnalyze was 0)
```

**Critical**: Step 2 excludes `method='error'` commits from `existingSet` so they get retried on next run instead of being permanently stuck.

**Critical**: Step 4 handles `toAnalyze=0` as a valid path (pure metrics recalculation). The current `totalAnalyzed === 0` throw in `analysis-worker.ts:448` must be changed to allow this.

#### Force recalculate flow (checkbox "Recalculate all commits"):

```
1. Extract commits from git by new scope          → newScopeSet
2. Delete CommitAnalysis for newScopeSet commits in THIS order only
3. Run ALL through LLM (skip cross-order cache)
4. Save new CommitAnalysis records
5. Recalculate metrics
```

#### Key implementation detail — diff with error retry:

```typescript
// Exclude error commits so they get retried
const existing = await prisma.commitAnalysis.findMany({
  where: { orderId, jobId: null, method: { not: 'error' } },
  select: { commitHash: true },
});
const existingSet = new Set(existing.map(c => c.commitHash));
const toAnalyze = newScopeCommits.filter(c => !existingSet.has(c.sha));

// toAnalyze.length === 0 is valid (narrow scope, re-run same scope)
// → skip pipeline, proceed to metrics recalculation
```

### 3. LAST_N_COMMITS Semantics — Global N

**Decision**: LAST_N_COMMITS means **N commits globally across all repositories**, sorted by `authorDate DESC`.

This applies uniformly to both extraction and metrics:

**Extraction phase** (multi-repo):
1. Extract ALL commits from each repo (no `--max-count` per repo)
2. Merge into a single list, sort by `authorDate DESC`
3. Take top N globally

**Metrics phase**:
```typescript
case 'LAST_N_COMMITS':
  return prisma.commitAnalysis.findMany({
    where: base,
    orderBy: { authorDate: 'desc' },
    take: order.analysisCommitLimit!,
  });
```

Both use the same semantics: global top N by date. For a single-repo order this is equivalent to the current `--max-count` behavior.

**Migration note**: Current extraction uses `--max-count` per repo in `buildCommitScope()`. This must change to extract all commits per repo, then truncate globally. For multi-repo orders with large histories, consider extracting a generous per-repo limit (e.g. `2*N`) as optimization, then taking global top N from the merged result.

### 4. Metrics — Scope-Filtered Calculation

`GhostMetricsService.calculateAndSave()` currently fetches all CommitAnalysis for the order. Change to fetch only in-scope commits via a shared `getInScopeCommits()` function:

```typescript
function getInScopeCommits(orderId: string, order: Order) {
  const base = { orderId, jobId: null, method: { not: 'error' } };

  switch (order.analysisPeriodMode) {
    case 'ALL_TIME':
      return prisma.commitAnalysis.findMany({ where: base });

    case 'DATE_RANGE':
      return prisma.commitAnalysis.findMany({
        where: {
          ...base,
          authorDate: { gte: order.analysisStartDate, lte: order.analysisEndDate },
        },
      });

    case 'SELECTED_YEARS':
      if (order.analysisYears.length === 0) {
        return []; // guard: empty years = no commits
      }
      return prisma.$queryRaw`
        SELECT * FROM "CommitAnalysis"
        WHERE "orderId" = ${orderId}
          AND "jobId" IS NULL
          AND "method" != 'error'
          AND EXTRACT(YEAR FROM "authorDate") IN (${Prisma.join(order.analysisYears)})
      `;

    case 'LAST_N_COMMITS':
      return prisma.commitAnalysis.findMany({
        where: base,
        orderBy: { authorDate: 'desc' },
        take: order.analysisCommitLimit!,
      });
  }
}
```

**This function is reused by**: metrics calculation, commits API, effort-timeline API (see section 6).

**OrderMetric and DailyEffort** — deleted and recalculated each time (unchanged), but input data is now the filtered in-scope set.

**`Order.totalCommits`** — updated to reflect in-scope count, not total CommitAnalysis count.

**Validation**: `SELECTED_YEARS` with empty `analysisYears` returns empty set (guard against `Prisma.join([])` SQL error). API validation in `PUT /api/orders/[id]` should also reject `SELECTED_YEARS` with empty array.

### 5. UI — Edit Scope Panel

**Location**: Order detail page (`/orders/[id]`), status COMPLETED.

**New button**: "Edit Scope" next to existing "Re-analyze".

**Panel** (collapsible card, appears between header and metrics):

```
┌─────────────────────────────────────────────────────┐
│ Analysis Scope                                       │
│                                                      │
│ Mode: [LAST_N_COMMITS ▼]                            │
│                                                      │
│ Commit limit: [200        ]  (current: 100)         │
│   — or —                                             │
│ Date range: [____] to [____]      (if DATE_RANGE)   │
│   — or —                                             │
│ Years: [2024] [2025] [2026]  (if SELECTED_YEARS)    │
│                                                      │
│ ☐ Recalculate all commits (ignore cache)             │
│                                                      │
│ Summary: Will analyze 100 new commits                │
│          (100 already cached)                        │
│                                                      │
│ [Save & Analyze]  [Cancel]                           │
└─────────────────────────────────────────────────────┘
```

**Summary line** — computed client-side or via a lightweight API call:
- Expanding: "Will analyze 100 new commits (100 already cached)"
- Narrowing: "Will recalculate metrics for 100 commits (100 remain out of scope)"
- Force recalculate: "Will re-analyze all 200 commits from scratch"

**Flow:**
1. Click "Edit Scope" → panel opens
2. User changes settings
3. Click "Save & Analyze" → `PUT /api/orders/[id]` (update scope) → `POST /api/orders/[id]/analyze` (start)
4. Order transitions to PROCESSING, UI shows progress as usual

**"Re-analyze" button** (existing) — behavior changes: now uses smart diff (no delete), re-analyzes with current scope. Force recalculate only available through Edit Scope panel.

### 6. Scope Filter in All Read Endpoints

All endpoints and UI tabs that read CommitAnalysis must apply the same scope filter. Out-of-scope commits are **not shown** (they exist in DB but are invisible to the user).

**Endpoints to update:**

| Endpoint | Current behavior | Change |
|----------|-----------------|--------|
| `GET /api/orders/[id]/commits` | `{ orderId, jobId: null }` | Add scope filter via `getInScopeCommits()` |
| `GET /api/orders/[id]/effort-timeline` | `{ orderId, jobId: null }` | Add scope filter via `getInScopeCommits()` |
| `GhostMetricsService.calculateAndSave()` | All commits | Use `getInScopeCommits()` |

**Implementation**: Extract `getInScopeCommits()` into a shared utility (e.g. `packages/server/src/lib/services/scope-filter.ts`) so all consumers use the same logic.

### 7. Edge Cases

**Mixed LLM models**: When scope expands and a different model is active, old commits keep their model, new commits get the current model. `CommitAnalysis.llmModel` tracks this. For uniformity, user can check "Recalculate all".

**Error commits retried**: Commits with `method='error'` are excluded from `existingSet`, so they are included in `toAnalyze` on the next run. This means transient LLM failures self-heal on re-run without force recalculate.

**Zero new commits (toAnalyze=0)**: Valid path. Pipeline is skipped, metrics are recalculated from existing in-scope CommitAnalysis, job completes successfully. This happens on: scope narrowing, re-run of same scope, scope change where all new commits were previously analyzed.

**Repository changes**: Not supported in this feature. Changing repos requires a new order.

**Concurrent runs**: Existing guard — second analysis is rejected while one is RUNNING. No changes needed.

**Cross-order cache with force recalculate**: Force = skip cache lookup + delete this order's CommitAnalysis in scope. Other orders' data is untouched.

**totalCommits on Order**: Always reflects in-scope count after analysis completes.

**SELECTED_YEARS with empty array**: Guarded in both `getInScopeCommits()` (returns empty set) and API validation (rejects request).

---

## Files to Modify

| File | Change |
|------|--------|
| `packages/server/src/lib/services/analysis-worker.ts` | Remove deleteMany for CommitAnalysis; add SHA diff logic (excluding error commits); handle toAnalyze=0 as valid path; change LAST_N_COMMITS extraction to global N |
| `packages/server/src/lib/services/ghost-metrics-service.ts` | Use `getInScopeCommits()` for metrics input |
| New: `packages/server/src/lib/services/scope-filter.ts` | Shared `getInScopeCommits()` used by metrics, commits API, timeline API |
| `packages/server/src/app/api/orders/[id]/analyze/route.ts` | Pass `forceRecalculate` flag from request body |
| `packages/server/src/app/api/orders/[id]/route.ts` | Add validation: SELECTED_YEARS requires non-empty analysisYears |
| `packages/server/src/app/api/orders/[id]/commits/route.ts` | Apply scope filter via `getInScopeCommits()` |
| `packages/server/src/app/api/orders/[id]/effort-timeline/route.ts` | Apply scope filter via `getInScopeCommits()` |
| `packages/server/src/app/(dashboard)/orders/[id]/page.tsx` | Add Edit Scope button + collapsible panel |
| New: `packages/server/src/components/edit-scope-panel.tsx` | Scope editing form component |
