# Benchmark Modal Support — Design Spec

## Goal

Make benchmarks work in production (`PIPELINE_MODE=modal`) by dispatching them to the Modal worker, and restrict benchmark access to admin users only.

## Background

Benchmarks currently call `processAnalysisJob()` directly, which spawns a local Python subprocess via `spawnPipeline`. On Vercel serverless there is no Python runtime, so benchmarks fail in production. Regular analysis already dispatches to Modal via webhook — benchmarks need the same path.

## Scope

1. **Admin-only access** — API routes and UI (page-level gating)
2. **Benchmark endpoint Modal dispatch** — trigger Modal when `PIPELINE_MODE=modal`
3. **Modal worker benchmark mode** — handle `job.type === 'benchmark'` with appropriate guards
4. **`setup_llm_env()` FD v3 propagation** — set FD env vars from snapshot

## Non-Goals

- Separate Modal function for benchmarks (Approach B — rejected, too much duplication)
- Refactor worker into shared library (Approach C — rejected, overkill)
- Benchmark billing/credit deduction
- Benchmark-triggered metrics/DailyEffort recalculation

---

## 1. Admin-Only Access

### API

All benchmark routes require admin role:

- `POST /api/orders/[id]/benchmark` — replace `requireUserSession()` with `requireAdmin()`. Remove `userId` filter from order query.
- `GET /api/orders/[id]/benchmark` — same: `requireAdmin()`, no userId filter.
- `GET /api/orders/[id]/benchmark/[jobId]` — replace `requireUserSession()` with `requireAdmin()`. Remove `order: { userId }` from query.
- `DELETE /api/orders/[id]/benchmark/[jobId]` — same: `requireAdmin()`, remove userId filter.
- `GET /api/orders/[id]/benchmark/compare` — replace `auth()` check with admin check via `session.user.role === 'ADMIN'`. Remove userId filter.

### UI — Page-Level Gating

Hiding the tab alone is not sufficient. The order page (`[locale]/(dashboard)/orders/[id]/page.tsx`) eagerly fetches benchmark data and renders `BenchmarkLauncher` outside the tab content area. Non-admin users would hit 403s on the benchmark API calls.

Required changes:
- Gate **all** benchmark-related state, queries, and components behind `session.user.role === 'ADMIN'`:
  - `benchmarkJobId` state + polling query
  - `benchmarkRuns` query (`/api/orders/${id}/benchmark`)
  - `<BenchmarkLauncher>` component render
  - Inline benchmark progress block
  - `<TabsTrigger value="benchmark">` tab header
  - `<TabsContent value="benchmark">` with `<BenchmarkMatrix>`
- Non-admin users see no benchmark UI and trigger no benchmark API calls.

---

## 2. Benchmark Endpoint — Modal Dispatch

**File:** `packages/server/src/app/api/orders/[id]/benchmark/route.ts`

### Current flow

1. Create `AnalysisJob` with `type: 'benchmark'`, `llmConfigSnapshot`, `llmConfigFingerprint`, `baseJobId`
2. Call `processAnalysisJob()` fire-and-forget
3. Return `{ jobId, status: 'PENDING' }`

### New flow (when `PIPELINE_MODE=modal`)

1. Create `AnalysisJob` as now
2. Save additional fields on the job: `executionMode: 'modal'`, `cacheMode: 'off'`, `skipBilling: true`
3. POST to `MODAL_ENDPOINT_URL` with `{ job_id, auth_token }` (same trigger as analysis)
4. Return `{ jobId, status: 'PENDING' }` — client polls `/progress?jobId=...`

### Local mode (when `PIPELINE_MODE=local` or unset)

Keep existing `processAnalysisJob()` call — used for local development.

### app.py (Modal trigger)

No changes. It already spawns `run_analysis(job_id)` generically. The worker reads `job.type` from DB and branches accordingly.

---

## 3. Modal Worker — Benchmark Mode

**File:** `packages/modal/worker.py`

Add `is_benchmark = job.get('type') == 'benchmark'` after `acquire_job()`. Then point-specific branching:

### Skip order mutations

When `is_benchmark`:
- Do NOT update order-level fields: `repositoriesProcessed`, `repositoriesFailed`, `status`, `currentRepoName`
- DO update job-level progress: `progress`, `currentStep`, `totalCommits` — the UI polls these

### Skip billing

`skip_billing = True` unconditionally for benchmarks (already persisted from endpoint).

### Pin commits to base job set

After `extract_commits()`:
1. Query `CommitAnalysis WHERE orderId = X AND jobId IS NULL AND repository = Y` to get the original SHA set
2. Filter extracted commits to only those in the base set
3. Pattern exists in TS `processAnalysisJob` (lines 308-318)

New DB helper: `get_base_commit_shas(conn, order_id, repository)` in `db.py`.

### Write CommitAnalysis with jobId

`save_commit_analyses()` in `db.py` currently hardcodes `jobId` as NULL in the INSERT and uses `ON CONFLICT ("orderId", "commitHash") WHERE "jobId" IS NULL`. For benchmarks:

- Add optional `job_id` parameter to `save_commit_analyses()`
- When `job_id` is provided: include `"jobId"` in the INSERT columns, use the unique constraint `@@unique([orderId, commitHash, jobId])` for conflict handling
- The existing `ON CONFLICT ... WHERE "jobId" IS NULL` clause only applies to non-benchmark rows

### Benchmark-aware rollback on failure

The current failure path calls `delete_analyses_since(conn, order_id, started_at)` which only deletes rows with `jobId IS NULL`. For benchmarks, partial rows would be left behind.

Add `delete_benchmark_analyses(conn, order_id, job_id)` to `db.py`:
```sql
DELETE FROM "CommitAnalysis"
WHERE "orderId" = %s AND "jobId" = %s
```

In the worker exception handler, use this instead of `delete_analyses_since` when `is_benchmark`. This ensures a failed benchmark leaves no partial data — a clean retry or rerun starts fresh.

### Fail-fast semantics

Current benchmarks are strict fail-fast: the benchmark route passes `failFast: true`, and the Modal worker forces `FAIL_FAST=1` in `process_commits()`. This must be preserved for Modal benchmarks.

The worker should set `FAIL_FAST=1` for benchmark jobs, same as it does in `process_commits()`. If a single commit fails, the entire benchmark fails — this ensures comparable runs (no partial results mixing error fallbacks with real estimates).

### Completion

- Regular analysis: sets `LLM_COMPLETE` → Vercel watchdog → post-processing (metrics, DailyEffort)
- Benchmark: sets `COMPLETED` directly — no post-processing needed
- Skip cross-order cache lookup

### Skip

- `delete_existing_analyses` (force recalculate) — benchmarks are append-only
- `demo_live_mode` chunking — not relevant for benchmarks

---

## 4. `setup_llm_env()` — FD v3 from Snapshot

**File:** `packages/modal/worker.py`

Currently `setup_llm_env()` propagates standard LLM config from snapshot to `os.environ`. FD env vars (`FD_V3_ENABLED`, `FD_LARGE_LLM_MODEL`, `FD_LARGE_LLM_PROVIDER`) come from Modal Secret `devghost-llm` instead.

Add to `setup_llm_env()`:

```python
# FD v3 config from snapshot (overrides Modal Secret values when present)
if llm_config.get("fdV3Enabled") is not None:
    os.environ["FD_V3_ENABLED"] = str(llm_config["fdV3Enabled"]).lower()
if llm_config.get("fdLargeModel"):
    os.environ["FD_LARGE_LLM_MODEL"] = llm_config["fdLargeModel"]
if llm_config.get("fdLargeProvider"):
    os.environ["FD_LARGE_LLM_PROVIDER"] = llm_config["fdLargeProvider"]
```

This applies to both regular analysis (snapshot captures config at launch time) and benchmarks. If snapshot lacks FD fields (old jobs), Modal Secret values remain — no breakage.

---

## Error Handling

- **Modal trigger fails:** job stays `PENDING`, watchdog retries (same as analysis)
- **Worker crash mid-benchmark:** job stays `RUNNING`, watchdog marks `FAILED_RETRYABLE` after timeout. Rollback deletes all benchmark CommitAnalysis rows for that jobId.
- **Pipeline error on individual commit (fail-fast):** entire benchmark fails immediately. `delete_benchmark_analyses()` cleans up partial rows. Job marked `FAILED_FATAL`. User can retry from UI.

## Testing

- Unit tests for admin-only access in benchmark routes
- Integration test for Modal dispatch path (mock fetch to MODAL_ENDPOINT_URL)
- Worker benchmark mode is best tested via staging E2E (too tightly coupled to DB and pipeline for unit tests)

## Progress UI

No changes needed. The existing progress endpoint already supports `?jobId=` parameter and shows job-level progress. The benchmark UI already polls this.

## Files Changed

| File | Change |
|------|--------|
| `packages/server/src/app/api/orders/[id]/benchmark/route.ts` | Admin auth, Modal dispatch |
| `packages/server/src/app/api/orders/[id]/benchmark/[jobId]/route.ts` | Admin auth |
| `packages/server/src/app/api/orders/[id]/benchmark/compare/route.ts` | Admin auth |
| `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx` | Page-level admin gating for all benchmark UI |
| `packages/modal/worker.py` | Benchmark mode branching, fail-fast, FD v3 env |
| `packages/modal/db.py` | `save_commit_analyses()` jobId param, `get_base_commit_shas()`, `delete_benchmark_analyses()` |
