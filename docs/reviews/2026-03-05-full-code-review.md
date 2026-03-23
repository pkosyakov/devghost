# DevGhost — Full Code Review

**Date:** 2026-03-05
**Scope:** Entire project (242 source files)
**Reviewers:** 4 parallel code-reviewer agents (API/Security, Services/Business Logic, Frontend, Infrastructure/Schema)
**Meta-review:** Verified by independent code-reviewer agent against actual source code

## Overall Assessment

The project demonstrates mature engineering: strict TypeScript, Decimal.js for financial calculations, atomic SQL operations in the credit system, solid security architecture (auth helpers, Zod validation, Prisma parameterized queries, Stripe webhook verification). i18n coverage is good, components are cleanly decomposed.

**Found: 6 Critical, 16 Important, 15 Suggestions**

### Verification Summary

All findings were verified against source code by an independent meta-reviewer:
- **24 of 37** findings fully confirmed
- **6** partially correct (severity adjusted or context added)
- **1** plausible but not fully verified
- **6** not verified (out of meta-reviewer scope)
- **0 false positives**

Two findings were downgraded from Critical to Important after verification (C7 → I15, C8 → I16).

---

## CRITICAL (6)

### C1. GitHub Access Token Stored in Plaintext
**Verification: CONFIRMED**

**Files:** `prisma/schema.prisma:26`, `src/lib/auth.ts:63-65`

The GitHub OAuth access token (with `repo` scope) is stored as a plaintext string in the database. If the database is compromised (Supabase breach, SQL injection, backup leak), all users' GitHub tokens are exposed, giving an attacker read/write access to private repositories.

```prisma
githubAccessToken String?
```

No encryption wrapper exists anywhere in the codebase.

**Recommendation:** Encrypt tokens at rest using AES-256-GCM via `crypto.createCipheriv`. Store encrypted value + IV. Decrypt only when needed in API routes. The encryption key should be an environment variable.

---

### C2. OpenRouter API Key Stored in Database
**Verification: CONFIRMED (with nuance)**

**File:** `prisma/schema.prisma:72`

The `SystemSettings` model stores the OpenRouter API key as plaintext in the database.

```prisma
openrouterApiKey String @default("")
```

**Nuance:** The API surface is already partially protected — the GET endpoint uses `formatSettings()` which replaces the actual key with `'***'` or `'(env)'`. The key is never returned verbatim to the admin panel. The risk is DB-level exposure (backup leak, SQL injection, direct DB access).

**Recommendation:** Remove the API key from the database entirely. Use environment variables exclusively (`process.env.OPENROUTER_API_KEY`). The admin panel should display a masked version and only accept updates via deployment environment configuration.

---

### C3. OpenRouter API Key Leaked to Audit Log
**Verification: CONFIRMED**

**File:** `src/app/api/admin/llm-settings/route.ts:151-157`

When an admin updates LLM settings, the raw `parsed.data` object is written directly into the `AuditLog` table. The stripping on lines 115-117 only deletes masked placeholder values (`'***'` or `'(env)'`), not actual new keys. So if an admin submits a new API key, the raw key is persisted in the AuditLog, visible to any admin via `GET /api/admin/audit`.

```typescript
await auditLog({
  details: data,  // <-- contains openrouterApiKey in plaintext when new key is set
});
```

**Recommendation:** Redact `openrouterApiKey` from the `details` object before audit logging:

```typescript
const auditDetails = { ...data };
if (auditDetails.openrouterApiKey) {
  auditDetails.openrouterApiKey = '***';
}
```

---

### C4. Shared Package Types Diverge from Prisma Schema
**Verification: CONFIRMED**

**File:** `packages/shared/src/types.ts:7-16`

Prisma `OrderStatus` enum has 7 values including `INSUFFICIENT_CREDITS`. Shared types list only 6 (missing `INSUFFICIENT_CREDITS`). `ORDER_STATUSES` in `packages/shared/src/constants.ts:32-39` also missing it.

Prisma `AnalysisJobStatus` enum has 8 values: `PENDING`, `RUNNING`, `LLM_COMPLETE`, `COMPLETED`, `FAILED`, `FAILED_RETRYABLE`, `FAILED_FATAL`, `CANCELLED`. Shared types have only 4: `'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'`. Missing: `LLM_COMPLETE`, `FAILED_RETRYABLE`, `FAILED_FATAL`, `CANCELLED`.

TypeScript union types won't catch valid statuses, causing potential runtime mishandling.

**Recommendation:** Synchronize types manually or generate from Prisma schema.

---

### C5. Publication Metrics Calculates Ghost% Differently from Main Service
**Verification: CONFIRMED**

**File:** `src/lib/services/publication-metrics.ts:57-59`

Two divergences from the canonical `ghost-metrics-service.ts`:

1. **Work days:** Uses raw unique commit dates (`new Set(...).size`) instead of `spreadEffort().dayMap.size` from the spreading algorithm.
2. **Share:** Uses effort-ratio (`totalEffort / totalEffortAll`) instead of `calcAutoShare()` (commit-ratio).

Ghost% on public/explore pages WILL differ from order detail pages for the same data.

**Recommendation:** Use `spreadEffort()` and `calcAutoShare()` from `@devghost/shared` to match canonical computation path. If intentionally simplified, document explicitly.

---

### C6. In-Memory Stores Don't Persist in Production (Serverless)
**Verification: CONFIRMED (with context)**

**Files:** `src/lib/services/job-registry.ts:21-23`, `src/lib/services/pipeline-log-store.ts:39-42`

The `globalThis` persistence is only activated in non-production mode. In production on Vercel (serverless), each request may run in a different isolate:
- `requestCancel()` may write to one isolate's registry but the worker runs in another.
- `getPipelineLogs()` polled by SSE progress endpoint may return empty from a different isolate.

**Context:** In production, `PIPELINE_MODE=modal` is the expected mode, which uses the database for progress tracking, not in-memory stores. This issue primarily affects `PIPELINE_MODE=local` in production, which is implicitly treated as dev-only.

**Recommendation:** Document explicitly that `PIPELINE_MODE=local` is dev-only, or move cancel flags and pipeline logs to Redis/database for production local mode.

---

## IMPORTANT (16)

### I1. No Rate Limiting on Login Endpoint
**Verification: PARTIALLY CORRECT**

**File:** `src/lib/auth.ts:102-125`

Rate limiting infrastructure exists (`src/lib/rate-limit.ts` with an `auth` tier of 5 requests/minute) and is applied to `POST /api/auth/register`. However, the login path through NextAuth's Credentials `authorize()` callback does NOT use `checkRateLimit` because NextAuth doesn't expose the `NextRequest` object to the `authorize` callback.

A blocked user is correctly rejected in `authorize()` via `isBlocked` check, but brute force of valid accounts is unprotected.

**Recommendation:** Add rate limiting at the middleware level for `POST /api/auth/callback/credentials`, or use Vercel Edge middleware with IP-based throttling.

---

### I2. Missing Composite Database Indexes
**Verification: CONFIRMED**

**File:** `prisma/schema.prisma:370-372`

`AnalysisJob` has separate indexes on `orderId` and `status`, but common queries filter by both. The watchdog queries `WHERE status = 'RUNNING' AND heartbeatAt < ...`.

**Recommendation:** Add composite indexes:
```prisma
@@index([orderId, status])
@@index([status, heartbeatAt])
```

---

### I3. CSP Allows `unsafe-eval` for Scripts
**Verification: CONFIRMED**

**File:** `next.config.mjs:52`

```javascript
"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
```

Note: Next.js development mode requires `unsafe-eval` for Fast Refresh. The conditional approach is appropriate.

**Recommendation:** Limit to development only:
```javascript
`script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ""}`,
```

---

### I4. JWT Callback Queries DB on Every Request
**Verification: CONFIRMED**

**File:** `src/lib/auth.ts:47-53`

The JWT callback refreshes the user's role from the database on every authenticated request.

**Recommendation:** Cache role in JWT with TTL refresh (e.g., every 5 minutes):
```typescript
const ROLE_REFRESH_INTERVAL = 5 * 60;
if (token.email && (!token.roleRefreshedAt ||
    Date.now() / 1000 - token.roleRefreshedAt > ROLE_REFRESH_INTERVAL)) {
  // refresh from DB
  token.roleRefreshedAt = Date.now() / 1000;
}
```

---

### I5. Inconsistent Auth Pattern — `auth()` Instead of `requireUserSession()`
**Verification: CONFIRMED (all 5 routes verified)**

Multiple routes use raw `auth()` instead of the standard helper, bypassing `isBlocked` check:

- `src/app/api/demo/route.ts` — line 11: `const session = await auth();`
- `src/app/api/cache/route.ts` — imports `auth` directly
- `src/app/api/orders/[id]/ground-truth/route.ts` — line 29: `const session = await auth();`
- `src/app/api/github/connect/route.ts` — custom `getUserFromSession()` calls `auth()`
- `src/app/api/github/repos/route.ts` — custom `getUserWithToken()` calls `auth()`

**Recommendation:** Refactor all routes to use `requireUserSession()` or `getUserSession()`.

---

### I6. `console.log`/`console.error` in Server Code Instead of Pino
**Verification: CONFIRMED (undercounted — 22+ instances)**

CLAUDE.md explicitly states to never use console.log in server code. The original report listed 8 files; meta-review found additional files including `user/profile/route.ts`, `github/period-stats/route.ts`, `github/repos/date-range/route.ts`, `orders/[id]/developer-settings/route.ts`. Total: 22+ instances across 12+ files.

**Recommendation:** Replace all with appropriate pino logger.

---

### I7. Error Messages Leak Internal Details
**Verification: CONFIRMED**

**File:** `src/app/api/orders/[id]/mapping/route.ts:38-41`

```typescript
return apiError(
  error instanceof Error ? error.message : 'Failed to save mapping',
  500
);
```

Prisma error messages can contain table names, column names, and constraint details. Note: most invalid inputs are caught by Zod first, reducing but not eliminating the risk.

**Recommendation:** Always return generic error message to client. Log details server-side only.

---

### I8. Missing Rate Limiting on SSE Explore/Search Endpoints
**Verification: CONFIRMED**

**Files:** `api/github/search/route.ts`, `api/github/public/route.ts`

Neither imports `checkRateLimit`. The search endpoint makes up to 50+ outbound GitHub API calls per single inbound request. `/api/github/public` is completely unauthenticated.

**Recommendation:** Add rate limiting to both endpoints. Limit concurrent SSE connections per user/IP.

---

### I9. Inconsistent Data Fetching: useEffect+fetch vs TanStack Query
**Verification: CONFIRMED**

Several pages manually manage loading/error states while TanStack Query is available:

- `dashboard/page.tsx` (lines 54-92)
- `orders/page.tsx` (lines 61-80)
- `settings/page.tsx` (lines 60-79)
- `components/github-connect-button.tsx` (lines 23-51)

**Impact:** No caching, no background refetching, no deduplication. Dashboard doesn't share cache with sidebar's recent orders query.

**Recommendation:** Migrate to `useQuery` consistently.

---

### I10. Order Detail Page is a 1200+ Line Monolith
**Verification: CONFIRMED**

**File:** `src/app/[locale]/(dashboard)/orders/[id]/page.tsx`

18+ `useState` hooks, 7+ `useQuery`/`useMutation` calls, 5+ `useEffect` hooks. The `eslint-disable-next-line react-hooks/exhaustive-deps` at line 478 is a symptom of stale closure risk.

**Recommendation:** Extract per-status sub-components (`DraftPanel`, `DeveloperDeduplicationPanel`, `AnalysisProgressPanel`, `CompletedResultsPanel`) and use custom hooks for analysis-related state.

---

### I11. Stale Closure in explore-grid Debounce
**Verification: CONFIRMED (low practical impact)**

**File:** `src/components/explore-grid.tsx:56-63`

```typescript
useEffect(() => {
  const timeout = setTimeout(() => {
    setDebouncedSearch(search);
    if (search !== debouncedSearch) setPage(1); // <-- stale debouncedSearch
  }, 300);
  return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [search]);
```

The `debouncedSearch` comparison is stale, but `setPage(1)` is called on every debounce trigger regardless, which happens to be correct behavior. The comparison is meaningless but harmless.

**Fix:** Remove stale comparison, always reset page:
```typescript
useEffect(() => {
  const timeout = setTimeout(() => {
    setDebouncedSearch(search);
    setPage(1);
  }, 300);
  return () => clearTimeout(timeout);
}, [search]);
```

---

### I12. Hardcoded English Strings in Components
**Verification: CONFIRMED**

Components lacking `useTranslations`:

- `components/effort-calendar.tsx` — "Effort Calendar", "No effort distribution data available", etc.
- `components/pipeline-log.tsx` — "Pipeline Log", "Copied!", "Copy"
- `components/ghost-heatmap.tsx` — all table headers
- `components/error-boundary.tsx` — "Something went wrong", "Try Again"
- `components/developer-card.tsx` — "Primary", "commits"
- `components/comment-section.tsx` — "just now", "ago", "Anonymous", "Comments", etc.

---

### I13. Demo Endpoint: No Rate Limit + Bypasses isBlocked
**Verification: CONFIRMED (with mitigation)**

**File:** `src/app/api/demo/route.ts`

Uses `auth()` directly instead of `requireUserSession()`. No rate limiting.

**Mitigation:** The endpoint deletes previous demo orders before creating new ones (line 30), so a user can't accumulate thousands of records. However, unlimited DB write operations per request remain a concern, and blocked users can still access it.

**Recommendation:** Use `requireUserSession()` + add rate limiting.

---

### I14. DailyEffort Rows Not Cleaned Up on Pipeline Failure
**Verification: PLAUSIBLE (not fully verified)**

**File:** `src/lib/services/analysis-worker.ts`

On true failure (non-PipelineError), order is marked FAILED but DailyEffort rows from previous runs may remain. User sees stale metrics until re-run.

**Recommendation:** Clear DailyEffort/OrderMetric on FAILED status, or document as expected behavior.

---

### I15. Unbounded IN Clause in Cross-Order Cache Lookup
**Verification: PARTIALLY CORRECT — downgraded from Critical**

**File:** `src/lib/services/analysis-worker.ts:1000-1006`

The IN clause with potentially large arrays is real. However:
- `shas` is per-repository within a single order, typically dozens to low thousands
- The `commitHash` column has an index (`@@index([commitHash, repository])`)
- PostgreSQL handles IN clauses of several thousand items without significant issues

```typescript
const where: Prisma.CommitAnalysisWhereInput = {
  commitHash: { in: shas },
};
```

**Recommendation:** Batch IN clauses to chunks of 1000 as a defensive measure:

```typescript
const CHUNK_SIZE = 1000;
const allRows: CachedCommitRow[] = [];
for (let i = 0; i < shas.length; i += CHUNK_SIZE) {
  const chunk = shas.slice(i, i + CHUNK_SIZE);
  const rows = await prisma.commitAnalysis.findMany({
    where: { ...where, commitHash: { in: chunk } },
  });
  allRows.push(...rows);
}
```

---

### I16. `window.location.origin` Used in Render Body
**Verification: PARTIALLY CORRECT — downgraded from Critical**

**File:** `src/app/[locale]/(dashboard)/billing/page.tsx:298-300`

```typescript
const referralLink = referralData?.referralCode
  ? `${window.location.origin}/register?ref=${referralData.referralCode}`
  : '';
```

The component has `'use client'` directive. During Next.js SSR pre-render, `referralData?.referralCode` comes from `useQuery` which returns `undefined`, so the ternary evaluates to `''` and `window` is never accessed. The code is effectively safe due to the data dependency, but it's a fragile pattern — if `referralData` were ever available during SSR (e.g., via `initialData`), it would crash.

**Recommendation:** Move to `useState`/`useEffect` pattern consistent with `share-link-card.tsx:14-19`.

---

## SUGGESTIONS (15)

### S1. `debitBatch` — N Sequential Transactions Instead of Bulk
**Verified.** `analysis-worker.ts:53-72` — For 500 commits, 500 sequential DB transactions. Create bulk debit function.

### S2. `getOrCreateStripeCustomer` Race Condition
**Verified (already mitigated).** `stripe.ts:57-79` — The race condition is documented in code (line 64) and mitigated with `updateMany WHERE stripeCustomerId = null` CAS guard. Orphaned Stripe customers remain the only residual risk. For higher scale, consider advisory lock.

### S3. `findFirst` + `update` Instead of `upsert` in OrderMetric
**Verified.** `ghost-metrics-service.ts:146-185` — Two queries where `upsert` with composite unique constraint could do one.

### S4. Duplicated Pipeline Processing Logic (~200 lines)
`analysis-worker.ts` — Standard repo loop vs LAST_N phase 2 loop are nearly identical. Extract `processRepoCommits()` helper.

### S5. `killProcessTree` Duplicated in 2 Files
**Verified.** `pipeline-bridge.ts:134-144` and `job-registry.ts:53-65` — Nearly identical implementations. Extract to shared utility.

### S6. Failed Clone Not Cleaned Up
**Verified.** `git-operations.ts:136-150` — Partial `.git` directory left on disk after clone failure. Delete `repoPath` on error.

### S7. `formatDate` Hardcoded to `ru-RU` Locale
**Verified.** `utils.ts:10` — Inconsistent with i18n system. Should accept locale parameter.

### S8. Comment Cascade Runs AFTER Delete
**Verified.** `db.ts:26-46` — Delete runs first, then comment cleanup. Orphan comments are harmless but ordering should be reversed or wrapped in `$transaction`.

### S9. Seed Script Uses Placeholder Stripe Price IDs
**Verified.** `seed.ts:49-51` — `price_*_placeholder` strings. Add validation in checkout route that rejects placeholders.

### S10. Duplicated `statusColors` Map in 4 Files
**Verified (undercounted).** Found in `dashboard/page.tsx`, `orders/[id]/page.tsx`, `sidebar.tsx`, AND `admin/orders/page.tsx`. Extract to `@/lib/constants.ts`.

### S11. GitHub Search/Public — ~700 Lines Duplicated Code
`api/github/search/route.ts` and `api/github/public/route.ts` — Shared helpers (`ghFetch`, `getContributorsCount`, `getActivityScore`, `getFullTimeStats`, `calcFullTime`, GraphQL search, SSE formatting) are duplicated. Extract to `lib/github-explore-utils.ts`.

### S12. `upsert` with `update: {} as any` in llm-config
**Verified.** `llm-config.ts:42-57` — `as any` casts bypass type safety. Use `findFirst` + conditional `create` or properly type the payload.

### S13. Modal Worker Swallows Missing Commits
`modal/worker.py:446-470` — If SHA doesn't match any input commit, returns row with empty author fields. Log warning or skip.

### S14. Missing Accessible Labels
`pipeline-log.tsx`, `ghost-heatmap.tsx`, `ghost-developer-table.tsx`, `share-link-card.tsx` — Missing `aria-label`, `aria-sort`, keyboard accessibility on interactive elements.

### S15. `DeveloperCard` Memo Ineffective
`developer-card.tsx:148` — `memo()` is defeated by inline lambda wrappers at call site (e.g., `() => handleToggleMerge(group.id)`), creating new function references each render.

---

## What Was Done Well

- **Credit system atomicity** — CTE-based atomic operations with CAS guards, crash-safe per-repo accounting
- **GitHub token security** — never exposed to client session, sanitized from error messages and logs
- **Stripe webhook** — signature verification + insert-first idempotency via StripeEvent PK
- **Effort spreading algorithm** — Decimal.js throughout, penny-spread remainder, sum invariants, 20+ tests
- **Structured logging** — pino child loggers with context, sensitive field redaction, daily rotation
- **Auth helpers** — `requireUserSession`/`requireAdmin`/`getOrderWithAuth` — clean, consistent pattern
- **i18n infrastructure** — next-intl with `[locale]` routing and locale-aware date formatting
- **TanStack Query** in complex pages — proper queryKey organization, enabled flags, cache invalidation
- **Security headers** — HSTS, X-Frame-Options, Permissions-Policy, Referrer-Policy (OWASP baseline)
- **Modal package** — CVE-2024-32002 mitigation, token sanitization, optimistic locking for job acquisition
- **Zod validation** — thorough and consistent across billing, orders, publications, and profile routes
- **Admin safeguards** — self-modification protection, last-admin prevention
- **Promo code system** — race condition handling with field-to-field SQL comparison + DB unique constraints
- **Providers pattern** — QueryClient correctly created inside `useState` to avoid sharing between requests
- **No `dangerouslySetInnerHTML`** — no XSS vectors in frontend code
- **Rate limiting infrastructure** — Upstash-based with graceful degradation (fail-open), applied to registration, billing, analysis
