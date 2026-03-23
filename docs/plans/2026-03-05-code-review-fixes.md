# Code Review Fixes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all Critical and Important issues from the 2026-03-05 code review. Suggestions are out of scope.

**Architecture:** Fixes are grouped into 12 independent tasks by domain. Each task is self-contained and can be committed separately. Order follows priority: security first, then correctness, then quality.

**Tech Stack:** Next.js 16 (App Router), Prisma, TypeScript, next-intl, TanStack Query, pino, Upstash rate limiting

**Reference:** Full review at `docs/reviews/2026-03-05-full-code-review.md`

---

### Task 1: Redact API Key from Audit Log (C3)

**Files:**
- Modify: `packages/server/src/app/api/admin/llm-settings/route.ts:150-156`

**Step 1: Add redaction before auditLog call**

At line 150, replace:
```typescript
    await auditLog({
      userId: result.user.id,
      action: 'admin.settings.update',
      targetType: 'SystemSettings',
      targetId: 'singleton',
      details: data,
    });
```
with:
```typescript
    const auditDetails = { ...data };
    if (auditDetails.openrouterApiKey) {
      auditDetails.openrouterApiKey = '***';
    }

    await auditLog({
      userId: result.user.id,
      action: 'admin.settings.update',
      targetType: 'SystemSettings',
      targetId: 'singleton',
      details: auditDetails,
    });
```

**Step 2: Commit**
```
fix(security): redact OpenRouter API key from audit log
```

---

### Task 2: Sync Shared Package Types with Prisma Schema (C4)

**Files:**
- Modify: `packages/shared/src/types.ts:7-15`
- Modify: `packages/shared/src/constants.ts:32-39`

**Step 1: Update OrderStatus type**

In `packages/shared/src/types.ts`, replace:
```typescript
export type OrderStatus =
  | 'DRAFT'
  | 'DEVELOPERS_LOADED'
  | 'READY_FOR_ANALYSIS'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED';
```
with:
```typescript
export type OrderStatus =
  | 'DRAFT'
  | 'DEVELOPERS_LOADED'
  | 'READY_FOR_ANALYSIS'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'INSUFFICIENT_CREDITS';
```

**Step 2: Update AnalysisJobStatus type**

In `packages/shared/src/types.ts`, replace:
```typescript
export type AnalysisJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
```
with:
```typescript
export type AnalysisJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'LLM_COMPLETE'
  | 'COMPLETED'
  | 'FAILED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FATAL'
  | 'CANCELLED';
```

**Step 3: Update ORDER_STATUSES constant**

In `packages/shared/src/constants.ts`, add `INSUFFICIENT_CREDITS` to the `ORDER_STATUSES` object. Match existing pattern.

**Step 4: Run build to verify no type errors**

Run: `cd packages/server && pnpm build`
Expected: No type errors from the expanded unions. If any switch/if-else is non-exhaustive, add handling for new statuses.

**Step 5: Commit**
```
fix(shared): sync OrderStatus and AnalysisJobStatus with Prisma schema
```

---

### Task 3: Fix Publication Metrics Ghost% Divergence (C5)

**Files:**
- Modify: `packages/server/src/lib/services/publication-metrics.ts`

**Step 1: Import spreading utilities**

Add imports at top:
```typescript
import { spreadEffort, calcAutoShare, calcGhostPercentRaw, calcGhostPercent } from '@devghost/shared';
```

Ensure `spreadEffort` and `calcAutoShare` are already exported from `@devghost/shared`. If not, check `packages/shared/src/index.ts` and add exports.

**Step 2: Replace work days calculation**

Replace the per-developer metrics block (around lines 51-70) that uses `uniqueDays` with the canonical spreading approach:

```typescript
// Use canonical effort spreading (matches ghost-metrics-service.ts)
const commits = devCommits.map(c => ({
  date: c.authorDate,
  effortHours: Number(c.estimatedEffort),
}));

const spreadResult = spreadEffort(commits);
const totalEffort = commits.reduce((sum, c) => sum + c.effortHours, 0);
const workDays = spreadResult.dayMap.size;
const avgDaily = workDays > 0 ? totalEffort / workDays : 0;
const overheadHours = spreadResult.totalOverhead;
```

**Step 3: Replace share calculation**

Replace effort-ratio share with commit-ratio share:
```typescript
const share = calcAutoShare(devCommits.length, totalCommitsAll);
```

Where `totalCommitsAll` is the total commit count across all developers (compute before the per-developer loop).

**Step 4: Run tests**

Run: `cd packages/server && pnpm test`

**Step 5: Commit**
```
fix(metrics): align publication metrics Ghost% with canonical spreading algorithm
```

---

### Task 4: Standardize Auth Pattern — Replace `auth()` with `requireUserSession()` (I5, I13)

**Files:**
- Modify: `packages/server/src/app/api/demo/route.ts`
- Modify: `packages/server/src/app/api/cache/route.ts`
- Modify: `packages/server/src/app/api/orders/[id]/ground-truth/route.ts`
- Modify: `packages/server/src/app/api/github/connect/route.ts`
- Modify: `packages/server/src/app/api/github/repos/route.ts`

**Step 1: Fix demo/route.ts**

Replace direct `auth()` call with `requireUserSession()`:
```typescript
import { requireUserSession, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';

export async function POST() {
  const result = await requireUserSession();
  if (isErrorResponse(result)) return result;
  const userId = result.user.id;
  // ... rest of handler using userId
}
```

Also add rate limiting:
```typescript
import { checkRateLimit } from '@/lib/rate-limit';

export async function POST(request: NextRequest) {
  const result = await requireUserSession();
  if (isErrorResponse(result)) return result;

  const rateLimited = await checkRateLimit(request, 'analysis', result.user.id);
  if (rateLimited) return rateLimited;
  // ...
}
```

**Step 2: Fix cache/route.ts**

Replace `auth()` with `requireUserSession()` for GET, keep `requireAdmin()` for DELETE (already correct pattern).

**Step 3: Fix ground-truth/route.ts**

Replace all `auth()` calls (GET, POST, DELETE) with `getOrderWithAuth()` or `requireUserSession()` as appropriate for each method.

**Step 4: Fix github/connect/route.ts**

Replace custom `getUserFromSession()` with `requireUserSession()`. Since this route needs `githubAccessToken`, extend the user query:
```typescript
const result = await requireUserSession();
if (isErrorResponse(result)) return result;

const user = await prisma.user.findUnique({
  where: { id: result.user.id },
  select: { githubAccessToken: true },
});
```

**Step 5: Fix github/repos/route.ts**

Same pattern as github/connect — replace `getUserWithToken()` with `requireUserSession()` + separate token query.

**Step 6: Run tests**

Run: `cd packages/server && pnpm test`

**Step 7: Commit**
```
fix(auth): replace direct auth() calls with requireUserSession() for isBlocked check
```

---

### Task 5: Replace All console.log/console.error with Pino Logger (I6)

**Files to modify (22+ instances across 12 files):**

**analysisLogger replacements (8 instances):**
- `src/app/api/orders/[id]/route.ts` — lines 53, 124, 146
- `src/app/api/orders/[id]/developers/route.ts` — lines 302, 312, 357
- `src/app/api/orders/[id]/mapping/route.ts` — line 37
- `src/app/api/demo/route.ts` — line 178

**gitLogger replacements (8 instances):**
- `src/app/api/github/connect/route.ts` — lines 79, 128, 148
- `src/app/api/github/repos/route.ts` — line 130
- `src/app/api/github/repos/date-range/route.ts` — lines 37, 67, 133
- `src/app/api/github/repos/[owner]/[repo]/contributors/route.ts` — line 67
- `src/app/api/github/public/route.ts` — line 196
- `src/app/api/github/period-stats/route.ts` — line 175

**logger replacements (4 instances):**
- `src/app/api/user/profile/route.ts` — lines 40, 79
- `src/app/api/orders/[id]/developer-settings/route.ts` — lines 54, 106

**Step 1: Replace all instances**

Pattern for each file — add logger import at top:
```typescript
import { analysisLogger } from '@/lib/logger';
// or: import { gitLogger } from '@/lib/logger';
// or: import { logger } from '@/lib/logger';
```

Replace `console.error('Message:', error)` with:
```typescript
analysisLogger.error({ err: error }, 'Message');
```

Replace `console.log('Message')` with:
```typescript
analysisLogger.info('Message');
```

For `console.log` with template literals containing variables:
```typescript
// Before:
console.log(`[Developers] Fetching commits from ${repo.full_name}`);
// After:
analysisLogger.info({ repo: repo.full_name }, 'Fetching commits');
```

**Step 2: Run lint**

Run: `cd packages/server && pnpm lint`

**Step 3: Commit**
```
fix(logging): replace console.log/error with pino logger in API routes
```

---

### Task 6: Fix Error Message Leak in Mapping Route (I7)

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/mapping/route.ts:35-41`

**Step 1: Replace error handling**

Replace:
```typescript
  } catch (error) {
    console.error('Save mapping error:', error);
    return apiError(
      error instanceof Error ? error.message : 'Failed to save mapping',
      500
    );
  }
```
with:
```typescript
  } catch (error) {
    analysisLogger.error({ err: error }, 'Save mapping error');
    return apiError('Failed to save mapping', 500);
  }
```

Note: The `console.error` replacement is already covered by Task 5, but the error message leak fix (returning generic message) is the key change here.

**Step 2: Grep for similar patterns in other routes**

Search for `error instanceof Error ? error.message` across all API routes and fix any other instances that leak Prisma internals.

Run: `grep -rn "error instanceof Error ? error.message" packages/server/src/app/api/`

**Step 3: Commit**
```
fix(security): return generic error messages instead of leaking internals
```

---

### Task 7: Add Rate Limiting to SSE Explore/Search Endpoints (I8)

**Files:**
- Modify: `packages/server/src/app/api/github/search/route.ts`
- Modify: `packages/server/src/app/api/github/public/route.ts`

**Step 1: Add rate limiting to github/search**

At the beginning of the GET handler, add:
```typescript
import { checkRateLimit } from '@/lib/rate-limit';

// Inside handler, after auth:
const rateLimited = await checkRateLimit(request, 'analysis', userId);
if (rateLimited) return rateLimited;
```

Use `'analysis'` tier (3/hour) since these are heavy endpoints.

**Step 2: Add rate limiting to github/public**

This endpoint is unauthenticated, so use IP-based limiting:
```typescript
import { checkRateLimit } from '@/lib/rate-limit';

// At start of handler:
const rateLimited = await checkRateLimit(request, 'analysis');
if (rateLimited) return rateLimited;
```

**Step 3: Commit**
```
fix(security): add rate limiting to SSE explore/search endpoints
```

---

### Task 8: Remove `unsafe-eval` from Production CSP (I3)

**Files:**
- Modify: `packages/server/next.config.mjs:52`

**Step 1: Make unsafe-eval conditional**

Replace:
```javascript
"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
```
with:
```javascript
`script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ""}`,
```

**Step 2: Test dev server starts**

Run: `cd packages/server && pnpm dev` — verify no CSP-related errors in console.

**Step 3: Test production build**

Run: `cd packages/server && pnpm build` — verify build succeeds.

**Step 4: Commit**
```
fix(security): restrict unsafe-eval to development CSP only
```

---

### Task 9: Add JWT Role Caching with TTL (I4)

**Files:**
- Modify: `packages/server/src/lib/auth.ts:47-53`

**Step 1: Add TTL-based role refresh**

Replace the jwt callback role refresh block:
```typescript
      if (token.email) {
        const dbUser = await prisma.user.findUnique({
          where: { email: token.email as string },
          select: { role: true },
        });
        if (dbUser) token.role = dbUser.role;
      }
```
with:
```typescript
      if (token.email) {
        const ROLE_REFRESH_INTERVAL = 5 * 60; // 5 minutes
        const now = Math.floor(Date.now() / 1000);
        const lastRefresh = (token.roleRefreshedAt as number) || 0;

        if (now - lastRefresh > ROLE_REFRESH_INTERVAL) {
          const dbUser = await prisma.user.findUnique({
            where: { email: token.email as string },
            select: { role: true },
          });
          if (dbUser) {
            token.role = dbUser.role;
            token.roleRefreshedAt = now;
          }
        }
      }
```

**Step 2: Add roleRefreshedAt to JWT type**

In `packages/server/src/types/next-auth.d.ts`, extend the JWT interface to include `roleRefreshedAt?: number`.

**Step 3: Test login flow**

Run: `cd packages/server && pnpm dev` — verify login works, role persists across page loads.

**Step 4: Commit**
```
perf(auth): cache JWT role with 5-minute TTL refresh
```

---

### Task 10: Add Composite Database Indexes (I2)

**Files:**
- Modify: `packages/server/prisma/schema.prisma` — AnalysisJob model

**Step 1: Add composite indexes**

In the AnalysisJob model, replace:
```prisma
  @@index([orderId])
  @@index([status])
```
with:
```prisma
  @@index([orderId, status])
  @@index([status, heartbeatAt])
  @@index([status])
```

Keep `@@index([status])` for queries that filter by status alone. Remove `@@index([orderId])` since it's covered by the composite.

**Step 2: Push schema changes**

Run: `cd packages/server && pnpm db:push`

**Step 3: Commit**
```
perf(db): add composite indexes on AnalysisJob for common query patterns
```

---

### Task 11: Fix Frontend Issues (I9 partial, I11, I15, I16)

**Files:**
- Modify: `packages/server/src/components/explore-grid.tsx:56-63`
- Modify: `packages/server/src/app/[locale]/(dashboard)/billing/page.tsx:298-300`
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/page.tsx:82-83`

**Step 1: Fix stale closure in explore-grid debounce (I11)**

In `explore-grid.tsx`, replace:
```typescript
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(search);
      if (search !== debouncedSearch) setPage(1);
    }, 300);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
```
with:
```typescript
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timeout);
  }, [search]);
```

**Step 2: Fix window.location.origin in billing page (I16)**

In `billing/page.tsx`, replace:
```typescript
  const referralLink = referralData?.referralCode
    ? `${window.location.origin}/register?ref=${referralData.referralCode}`
    : '';
```
with:
```typescript
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const referralLink = referralData?.referralCode && origin
    ? `${origin}/register?ref=${referralData.referralCode}`
    : '';
```

Make sure `useState` and `useEffect` are imported from `'react'`.

**Step 3: Replace window.confirm with AlertDialog in orders page (orders/page.tsx)**

Replace `if (!confirm(t('deleteConfirm'))) return;` with an AlertDialog pattern. Add state for pending delete:

```typescript
const [deleteId, setDeleteId] = useState<string | null>(null);

const handleDelete = async () => {
  if (!deleteId) return;
  try {
    const response = await fetch(`/api/orders/${deleteId}`, { method: 'DELETE' });
    if (response.ok) {
      setOrders((prev) => prev.filter((o) => o.id !== deleteId));
    } else {
      const data = await response.json().catch(() => null);
      setError(data?.error || t('deleteError'));
    }
  } catch (err) {
    analysisLogger.error({ err }, 'Failed to delete order');
  } finally {
    setDeleteId(null);
  }
};
```

Add AlertDialog in the JSX (import from `@/components/ui/alert-dialog`):
```tsx
<AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
      <AlertDialogDescription>{t('deleteConfirm')}</AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
      <AlertDialogAction onClick={handleDelete}>{t('delete')}</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

Update the delete button in the orders list to call `setDeleteId(order.id)` instead of `handleDelete(order.id)`.

**Step 4: Run dev server and verify**

Run: `cd packages/server && pnpm dev`
- Check explore page search works
- Check billing page referral link renders
- Check orders page delete shows dialog

**Step 5: Commit**
```
fix(ui): fix stale closure, SSR-safe referral link, and delete confirmation dialog
```

---

### Task 12: Document In-Memory Stores Limitation (C6)

**Files:**
- Modify: `packages/server/src/lib/services/job-registry.ts`
- Modify: `packages/server/src/lib/services/pipeline-log-store.ts`

**Step 1: Add documentation comments**

At the top of `job-registry.ts`, after imports, add:
```typescript
/**
 * In-memory job registry for tracking active analysis jobs.
 *
 * IMPORTANT: This store only works within a single process/isolate.
 * In production on Vercel (serverless), PIPELINE_MODE=modal is required —
 * it uses the database for job tracking, not this in-memory registry.
 * Cancel and progress features via this registry are dev-only (PIPELINE_MODE=local).
 */
```

At the top of `pipeline-log-store.ts`, after imports, add:
```typescript
/**
 * In-memory pipeline log store for SSE progress streaming.
 *
 * IMPORTANT: This store only works within a single process/isolate.
 * In production, PIPELINE_MODE=modal uses database-based progress tracking.
 * SSE log streaming via this store is dev-only (PIPELINE_MODE=local).
 */
```

**Step 2: Commit**
```
docs: document in-memory store limitations for serverless environments
```

---

## Summary

| Task | Fixes | Priority | Estimated Scope |
|------|-------|----------|-----------------|
| 1 | C3 (API key in audit log) | Critical | 1 file, 5 lines |
| 2 | C4 (type sync) | Critical | 2 files, 10 lines |
| 3 | C5 (metrics divergence) | Critical | 1 file, 20 lines |
| 4 | I5, I13 (auth pattern) | Important | 5 files, ~50 lines |
| 5 | I6 (console.log) | Important | 12 files, 22 replacements |
| 6 | I7 (error leak) | Important | 1+ files, 5 lines |
| 7 | I8 (rate limiting) | Important | 2 files, 10 lines |
| 8 | I3 (CSP unsafe-eval) | Important | 1 file, 1 line |
| 9 | I4 (JWT caching) | Important | 2 files, 15 lines |
| 10 | I2 (DB indexes) | Important | 1 file, 3 lines |
| 11 | I11, I15, I16 (frontend) | Important | 3 files, ~40 lines |
| 12 | C6 (documentation) | Critical | 2 files, 10 lines |

**Not included (requires separate planning):**
- C1 (GitHub token encryption) — needs crypto utility, migration, all read points updated
- C2 (OpenRouter key from DB) — needs admin panel redesign, env-only flow
- I1 (login rate limiting) — needs NextAuth architecture workaround
- I9 partial (TanStack Query migration for dashboard/orders/settings) — large refactor
- I10 (order detail decomposition) — large refactor
- I12 (i18n hardcoded strings) — needs translation keys in messages files
- I14 (DailyEffort cleanup) — needs analysis-worker.ts deep understanding
- All S1-S15 suggestions
