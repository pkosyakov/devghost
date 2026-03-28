# Benchmark Modal Support — Design Spec

## Goal

Make benchmarks work in production (`PIPELINE_MODE=modal`) by dispatching them to the Modal worker, and restrict benchmark access to admin users only.

## Background

Benchmarks currently call `processAnalysisJob()` directly, which spawns a local Python subprocess via `spawnPipeline`. On Vercel serverless there is no Python runtime, so benchmarks fail in production. Regular analysis already dispatches to Modal via webhook — benchmarks need the same path.

## Scope

1. **Admin-only access** — API routes and UI tab
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

- `POST /api/orders/[id]/benchmark` — replace `requireUserSession()` with `requireAdmin()`. Remove `userId` filter from order query (admin sees all orders).
- `GET /api/orders/[id]/benchmark` — same: `requireAdmin()`, no userId filter.
- `GET /api/orders/[id]/benchmark/compare` — check `session.user.role === 'ADMIN'` (this route uses `auth()` directly). Remove userId filter.

### UI

- The "Benchmark" tab on the order page renders only when `session.user.role === 'ADMIN'`.
- This is the sole entry point to benchmark UI. Hiding the tab is sufficient.

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

### Write CommitAnalysis with jobId

`save_commit_analyses()` in `db.py` currently writes `job_id = NULL`. For benchmarks, pass `job_id = <benchmark_job_id>`.

Add an optional `job_id` parameter to `save_commit_analyses()`.

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
- **Worker crash mid-benchmark:** job stays `RUNNING`, watchdog marks `FAILED_RETRYABLE` after timeout
- **Pipeline error on individual commit:** commit gets `method: 'error'`, benchmark continues (failFast is already passed from endpoint)

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
| `packages/server/src/app/api/orders/[id]/benchmark/compare/route.ts` | Admin auth |
| `packages/server/src/components/benchmark-matrix.tsx` | Admin-only tab rendering |
| `packages/modal/worker.py` | Benchmark mode branching |
| `packages/modal/db.py` | `save_commit_analyses()` jobId param |
