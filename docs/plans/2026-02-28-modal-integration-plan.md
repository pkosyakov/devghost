# Modal Integration — Implementation Plan

## Context

DevGhost's analysis pipeline (git clone, commit parsing, LLM estimation) currently runs as a Python subprocess on Vercel, which has strict timeout limits (60s Hobby / 300s Pro). This makes it impossible to analyze large repositories. The design document (`docs/plans/2026-02-28-modal-integration-design.md`, v4) specifies moving heavy compute to Modal serverless while keeping business logic on Vercel.

This plan implements the A+ architecture: Vercel creates a durable AnalysisJob, triggers Modal via HTTP, Modal processes commits and writes results to DB, Vercel watchdog handles post-processing (Ghost%, billing).

**Branch**: `feat/modal-integration` (from `master`)

---

## Phase 1: Schema + Infrastructure Setup ✅

**Goal**: Add new DB fields and create Modal package structure. No behavior change — local pipeline still works.

### Step 1.1: Prisma schema changes ✅
**File**: `packages/server/prisma/schema.prisma`

Add to `AnalysisJob` model:
- `lockedBy String?` — Modal function call ID
- `heartbeatAt DateTime?` — last heartbeat
- `retryCount Int @default(0)`
- `maxRetries Int @default(3)`
- `executionMode String @default("local")` — "local" | "modal"
- `modalCallId String?` — Modal call ID for tracking
- `skipBilling Boolean @default(false)`
- `forceRecalculate Boolean @default(false)`

Add to `AnalysisJobStatus` enum:
- `LLM_COMPLETE` — Modal done, Vercel post-processing pending
- `FAILED_RETRYABLE` — transient failure, watchdog retries
- `FAILED_FATAL` — permanent failure

Add partial unique index (raw SQL via `prisma/partial-index-modal.sql`):
```sql
CREATE UNIQUE INDEX IF NOT EXISTS "CommitAnalysis_orderId_commitHash_noJob_key"
ON "CommitAnalysis" ("orderId", "commitHash")
WHERE "jobId" IS NULL;
```

**Run**: `cd packages/server && pnpm db:push && pnpm db:generate`

### Step 1.2: Environment variables ✅
**File**: `packages/server/.env.example`

Add:
```
PIPELINE_MODE=local              # "local" | "modal"
MODAL_ENDPOINT_URL=              # Modal web endpoint URL
MODAL_WEBHOOK_SECRET=            # Shared secret for Modal trigger
CRON_SECRET=                     # Vercel Cron auth
```

### Step 1.3: Create Modal package directory ✅
```
packages/modal/
├── app.py                # Modal App definition + trigger endpoint
├── worker.py             # run_analysis, _process_repo_commits, evaluate_chunk
├── git_ops.py            # Python port of git-operations.ts
├── db.py                 # Supabase connection helpers
├── rate_limiter.py       # OpenRouter QPS limiter
├── requirements.txt      # modal, psycopg2-binary, requests
└── README.md             # Setup instructions (secrets, deploy)
```

**Verify**: `pnpm db:push` succeeds, `pnpm db:generate` succeeds, existing tests pass (`cd packages/server && pnpm test:run`).

---

## Phase 2: Modal Python Code ✅

**Goal**: Write all Python files for the Modal worker. Each file is independently testable.

### Step 2.1: `packages/modal/requirements.txt` ✅
### Step 2.2: `packages/modal/rate_limiter.py` ✅
### Step 2.3: `packages/modal/db.py` ✅
### Step 2.4: `packages/modal/git_ops.py` ✅
### Step 2.5: `packages/modal/worker.py` ✅
### Step 2.6: `packages/modal/app.py` ✅

**Verify**: `cd packages/modal && modal run app.py` (dry run, needs Modal account).

---

## Phase 3: Vercel TypeScript Changes

**Goal**: Add PIPELINE_MODE switch to analyze route, create watchdog cron, vercel.json.

### Step 3.1: Modify analyze route
**File**: `packages/server/src/app/api/orders/[id]/analyze/route.ts`

Changes:
- After creating job in transaction, check `PIPELINE_MODE`:
  - `"modal"`: save `llmConfigSnapshot` (stripped apiKey), `executionMode`, `skipBilling`, `forceRecalculate` on job → HTTP POST to Modal endpoint → return
  - `"local"` (default): existing `processAnalysisJob()` fire-and-forget (no changes)
- If Modal trigger fails: log warning, job stays PENDING for watchdog

Reference: `packages/server/src/lib/api-utils.ts` (apiResponse, apiError patterns)

### Step 3.2: Create watchdog cron endpoint
**File**: `packages/server/src/app/api/cron/analysis-watchdog/route.ts` (new)

Steps:
1. Auth: verify `Authorization: Bearer <CRON_SECRET>`
2. Reaper: RUNNING + stale heartbeat (>10 min) → FAILED_RETRYABLE or FAILED_FATAL
3. Retry: FAILED_RETRYABLE → PENDING → re-trigger Modal
4. Orphan PENDING: no modalCallId + >2 min → re-trigger Modal
5. Recovery: stuck `post_processing` + `updatedAt` > 5 min → reset `currentStep`
6. Post-process: LLM_COMPLETE → atomic claim (`FOR UPDATE SKIP LOCKED`) → Ghost% + billing → COMPLETED

Reuses:
- `packages/server/src/lib/services/ghost-metrics-service.ts` — `getGhostMetricsService().calculateAndSave()`
- `packages/server/src/lib/services/credit-service.ts` — `releaseReservedCredits`, `debitCredit`, `isBillingEnabled`
- `packages/server/src/lib/services/scope-filter.ts` — `countInScopeCommits`
- `packages/server/src/lib/llm-config.ts` — `getLlmConfig`

### Step 3.3: Vercel cron config
**File**: `packages/server/vercel.json` (new)

```json
{
  "crons": [
    {
      "path": "/api/cron/analysis-watchdog",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

### Step 3.4: Tests

**New test files:**

`packages/server/src/app/api/orders/[id]/analyze/__tests__/route.test.ts`:
- Test PIPELINE_MODE=local (existing behavior preserved)
- Test PIPELINE_MODE=modal (llmConfigSnapshot saved, HTTP trigger called)
- Test Modal trigger failure (job stays PENDING)
- Test skipBilling/forceRecalculate flags set correctly

`packages/server/src/app/api/cron/analysis-watchdog/__tests__/route.test.ts`:
- Test auth rejection (no CRON_SECRET, wrong secret)
- Test reaper (stale heartbeat → FAILED_RETRYABLE)
- Test retry (FAILED_RETRYABLE → PENDING + re-trigger)
- Test post-processing (LLM_COMPLETE → COMPLETED)
- Test stuck post_processing recovery

Mock patterns: follow existing tests (vi.mock for Prisma, api-utils, logger).

**Verify**: `cd packages/server && pnpm test:run` — all existing + new tests pass.

---

## Phase 4: Integration + Deploy

### Step 4.1: Local verification
- Run `PIPELINE_MODE=local pnpm dev` → trigger analysis → confirm existing flow works unchanged
- No Modal needed for local mode

### Step 4.2: Modal deploy
```bash
cd packages/modal
modal secret create devghost-db DIRECT_URL="postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres"
modal secret create devghost-llm OPENROUTER_API_KEY="..." MODAL_WEBHOOK_SECRET="..." LLM_MAX_QPS="5"
modal deploy app.py
```
- Note the endpoint URL from deploy output

### Step 4.3: Vercel env vars
Add to Vercel project:
```
PIPELINE_MODE=modal
MODAL_ENDPOINT_URL=<from step 4.2>
MODAL_WEBHOOK_SECRET=<same as Modal secret>
CRON_SECRET=<generate random>
```

### Step 4.4: E2E verification
- Create test order with small repo (1-5 commits)
- Trigger analysis → confirm job goes PENDING → RUNNING → LLM_COMPLETE → COMPLETED
- Check CommitAnalysis rows created
- Check Ghost% metrics calculated
- Check credits debited correctly (non-ADMIN user)

---

## Implementation Order Summary

| Step | Files | Depends On | Risk | Status |
|------|-------|-----------|------|--------|
| 1.1 | schema.prisma | — | LOW | ✅ |
| 1.2 | .env.example | — | LOW | ✅ |
| 1.3 | packages/modal/ (dirs) | — | LOW | ✅ |
| 2.1 | requirements.txt | 1.3 | LOW | ✅ |
| 2.2 | rate_limiter.py | 1.3 | LOW | ✅ |
| 2.3 | db.py | 1.1, 1.3 | MED | ✅ |
| 2.4 | git_ops.py | 1.3 | MED | ✅ |
| 2.5 | worker.py | 2.2-2.4 | HIGH | ✅ |
| 2.6 | app.py | 2.5 | MED | ✅ |
| 3.1 | analyze/route.ts | 1.1 | MED | ✅ |
| 3.2 | watchdog/route.ts | 1.1, 3.1 | HIGH | ✅ |
| 3.3 | vercel.json | 3.2 | LOW | ✅ |
| 3.4 | *.test.ts | 3.1-3.2 | MED | ✅ |
| 4.x | deploy | all above | MED | ⬜ |
