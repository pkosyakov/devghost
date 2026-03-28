# Benchmark Modal Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make benchmarks run in production via Modal dispatch and restrict all benchmark functionality to admin users.

**Architecture:** When `PIPELINE_MODE=modal`, the benchmark POST endpoint saves pipeline flags on the AnalysisJob and triggers Modal via webhook (same pattern as `/api/orders/[id]/analyze`). The Modal worker detects `job.type === 'benchmark'` and branches: skip order mutations, pin commits to base analysis set, write CommitAnalysis with jobId, use benchmark-aware rollback, set COMPLETED directly (no post-processing). All benchmark API routes and UI are gated to admin role.

**Tech Stack:** Next.js API routes (TypeScript), Modal worker (Python), PostgreSQL via Prisma (TS) and psycopg2 (Python)

**Spec:** `docs/superpowers/specs/2026-03-29-benchmark-modal-support-design.md`

---

### Task 1: Admin-only benchmark API routes

Convert all 5 benchmark route handlers from `requireUserSession()` to `requireAdmin()`, removing userId-based order filtering.

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/benchmark/route.ts:18-30,268-279`
- Modify: `packages/server/src/app/api/orders/[id]/benchmark/[jobId]/route.ts:1-19,130-144`
- Modify: `packages/server/src/app/api/orders/[id]/benchmark/compare/route.ts:1-31`
- Modify: `packages/server/src/app/api/orders/[id]/benchmark/__tests__/route.test.ts:16`
- Create: `packages/server/src/app/api/orders/[id]/benchmark/__tests__/admin-guard.test.ts`

- [ ] **Step 1: Write admin guard tests**

Create `packages/server/src/app/api/orders/[id]/benchmark/__tests__/admin-guard.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Shared mock setup
const mockRequireAdmin = vi.fn();
const mockOrderFindFirst = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    order: { findFirst: (...a: unknown[]) => mockOrderFindFirst(...a) },
    analysisJob: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'j1' }),
    },
    commitAnalysis: { findMany: vi.fn().mockResolvedValue([]) },
    groundTruth: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireAdmin: (...a: unknown[]) => mockRequireAdmin(...a),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
  apiResponse: vi.fn((data: unknown) => new Response(JSON.stringify({ data }), { status: 200 })),
  apiError: vi.fn((msg: string, status: number) => new Response(JSON.stringify({ error: msg }), { status })),
  parseBody: vi.fn(async (req: NextRequest) => ({ success: true, data: await req.json() })),
}));

vi.mock('@/lib/llm-config', () => ({
  getLlmConfig: vi.fn().mockResolvedValue({
    provider: 'openrouter',
    ollama: { url: 'http://localhost:11434', model: 'test' },
    openrouter: { apiKey: 'sk-test', model: 'test', providerOrder: [], providerIgnore: [], allowFallbacks: false, requireParameters: true },
  }),
}));

vi.mock('@/lib/services/model-context', () => ({
  DEFAULT_CTX: 32768,
  clampContext: vi.fn((v: number) => v),
  resolveModelContext: vi.fn().mockResolvedValue(null),
  computeEffectiveContext: vi.fn((v: number) => v),
}));

vi.mock('@/lib/services/analysis-worker', () => ({
  processAnalysisJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/services/pipeline-bridge', () => ({
  checkOllamaHealth: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { analysisLogger: mockLogger };
});

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/services/job-registry', () => ({
  requestCancel: vi.fn(),
}));

describe('Benchmark admin guard', () => {
  const forbidden = new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POST /benchmark returns 403 for non-admin', async () => {
    mockRequireAdmin.mockResolvedValue(forbidden);
    const { POST } = await import('../route');
    const req = new NextRequest('http://localhost/api/orders/o1/benchmark', {
      method: 'POST',
      body: JSON.stringify({ provider: 'openrouter', model: 'test' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'o1' }) });
    expect(res.status).toBe(403);
  });

  it('GET /benchmark returns 403 for non-admin', async () => {
    mockRequireAdmin.mockResolvedValue(forbidden);
    const { GET } = await import('../route');
    const req = new NextRequest('http://localhost/api/orders/o1/benchmark');
    const res = await GET(req, { params: Promise.resolve({ id: 'o1' }) });
    expect(res.status).toBe(403);
  });

  it('GET /benchmark/compare returns 403 for non-admin', async () => {
    mockRequireAdmin.mockResolvedValue(forbidden);
    const { GET } = await import('../compare/route');
    const req = new NextRequest('http://localhost/api/orders/o1/benchmark/compare');
    const res = await GET(req, { params: Promise.resolve({ id: 'o1' }) });
    expect(res.status).toBe(403);
  });

  it('GET /benchmark/[jobId] returns 403 for non-admin', async () => {
    mockRequireAdmin.mockResolvedValue(forbidden);
    const { GET } = await import('../[jobId]/route');
    const req = new NextRequest('http://localhost/api/orders/o1/benchmark/j1');
    const res = await GET(req, { params: Promise.resolve({ id: 'o1', jobId: 'j1' }) });
    expect(res.status).toBe(403);
  });

  it('DELETE /benchmark/[jobId] returns 403 for non-admin', async () => {
    mockRequireAdmin.mockResolvedValue(forbidden);
    const { DELETE } = await import('../[jobId]/route');
    const req = new NextRequest('http://localhost/api/orders/o1/benchmark/j1', { method: 'DELETE' });
    const res = await DELETE(req, { params: Promise.resolve({ id: 'o1', jobId: 'j1' }) });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test -- src/app/api/orders/\\[id\\]/benchmark/__tests__/admin-guard.test.ts`
Expected: FAIL — routes still use `requireUserSession`, not `requireAdmin`

- [ ] **Step 3: Convert benchmark/route.ts POST handler to requireAdmin**

In `packages/server/src/app/api/orders/[id]/benchmark/route.ts`:

Replace the import line:
```typescript
import { apiResponse, apiError, parseBody, requireUserSession, isErrorResponse } from '@/lib/api-utils';
```
with:
```typescript
import { apiResponse, apiError, parseBody, requireAdmin, isErrorResponse } from '@/lib/api-utils';
```

Replace POST handler auth section (lines 19-31):
```typescript
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, benchmarkSchema);
  if (!parsed.success) return parsed.error;
  const body = parsed.data;
  const { provider, model } = body;

  const isAdmin = session.user.role === 'ADMIN';
  const order = await prisma.order.findFirst({
    where: { id, ...(isAdmin ? {} : { userId: session.user.id }) },
  });
```
with:
```typescript
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, benchmarkSchema);
  if (!parsed.success) return parsed.error;
  const body = parsed.data;
  const { provider, model } = body;

  const order = await prisma.order.findFirst({
    where: { id },
  });
```

Replace GET handler auth section (lines 270-279):
```typescript
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const isAdminGet = session.user.role === 'ADMIN';
  const order = await prisma.order.findFirst({
    where: { id, ...(isAdminGet ? {} : { userId: session.user.id }) },
    select: { id: true },
  });
```
with:
```typescript
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const order = await prisma.order.findFirst({
    where: { id },
    select: { id: true },
  });
```

- [ ] **Step 4: Convert benchmark/[jobId]/route.ts to requireAdmin**

In `packages/server/src/app/api/orders/[id]/benchmark/[jobId]/route.ts`:

Replace the import:
```typescript
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
```
with:
```typescript
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
```

In GET handler, replace:
```typescript
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  // Verify ownership and benchmark job
  const benchmarkJob = await prisma.analysisJob.findFirst({
    where: { id: jobId, orderId: id, type: 'benchmark', order: { userId: session.user.id } },
  });
```
with:
```typescript
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const benchmarkJob = await prisma.analysisJob.findFirst({
    where: { id: jobId, orderId: id, type: 'benchmark' },
  });
```

In DELETE handler, replace:
```typescript
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  // Verify ownership
  const job = await prisma.analysisJob.findFirst({
    where: { id: jobId, orderId: id, type: 'benchmark', order: { userId: session.user.id } },
    select: { id: true, status: true },
  });
```
with:
```typescript
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const job = await prisma.analysisJob.findFirst({
    where: { id: jobId, orderId: id, type: 'benchmark' },
    select: { id: true, status: true },
  });
```

- [ ] **Step 5: Convert benchmark/compare/route.ts to requireAdmin**

In `packages/server/src/app/api/orders/[id]/benchmark/compare/route.ts`:

Add import at the top (after existing imports):
```typescript
import { requireAdmin, isErrorResponse } from '@/lib/api-utils';
```

Remove the `auth` import:
```typescript
import { auth } from '@/lib/auth';
```

Replace the auth section in GET (lines 19-31):
```typescript
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;

  const isAdmin = (session.user as any).role === 'ADMIN';
  const order = await prisma.order.findFirst({
    where: { id, ...(isAdmin ? {} : { userId: session.user.id }) },
  });
```
with:
```typescript
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const order = await prisma.order.findFirst({
    where: { id },
  });
```

- [ ] **Step 6: Fix existing benchmark route test mock to use requireAdmin**

In `packages/server/src/app/api/orders/[id]/benchmark/__tests__/route.test.ts`, update the mock:

Replace:
```typescript
vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'test@test.com', role: 'USER' } }),
```
with:
```typescript
vi.mock('@/lib/api-utils', () => ({
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'test@test.com', role: 'ADMIN' } }),
```

- [ ] **Step 7: Fix existing compare route test mock to use requireAdmin**

In `packages/server/src/app/api/orders/[id]/benchmark/compare/__tests__/route.test.ts`, update the mock:

Replace:
```typescript
vi.mock('@/lib/auth', () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
}));
```
with:
```typescript
vi.mock('@/lib/api-utils', () => ({
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'test@test.com', role: 'ADMIN' } }),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
}));
```

- [ ] **Step 8: Run all benchmark tests**

Run: `cd packages/server && pnpm test -- src/app/api/orders/\\[id\\]/benchmark/`
Expected: ALL PASS

- [ ] **Step 9: Verify TypeScript compiles**

Run: `cd packages/server && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/app/api/orders/\[id\]/benchmark/route.ts \
       packages/server/src/app/api/orders/\[id\]/benchmark/\[jobId\]/route.ts \
       packages/server/src/app/api/orders/\[id\]/benchmark/compare/route.ts \
       packages/server/src/app/api/orders/\[id\]/benchmark/__tests__/ \
       packages/server/src/app/api/orders/\[id\]/benchmark/compare/__tests__/
git commit -m "feat(benchmark): restrict all benchmark routes to admin role"
```

---

### Task 2: Page-level admin gating for benchmark UI

Gate all benchmark-related state, queries, and components behind `isAdmin` on the order detail page. Non-admin users must see no benchmark UI and trigger no benchmark API calls.

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx:341-343,544-580,1740-1792,1880-1887,1949-1951`

**Context:** The `isAdmin` variable already exists at line 321: `const isAdmin = session?.user?.role === 'ADMIN';`. State variables (`benchmarkJobId`, `benchmarkLog`, `benchmarkLogSinceRef`) stay as-is — they're cheap. The gating targets queries and renders.

- [ ] **Step 1: Gate benchmark progress query**

Wrap the benchmark progress query (around line 544) by changing its `enabled` condition:

Replace:
```typescript
  enabled: !!benchmarkJobId,
```
with:
```typescript
  enabled: isAdmin && !!benchmarkJobId,
```

- [ ] **Step 2: Gate benchmark runs query**

Wrap the benchmark runs query (around line 572) by changing its `enabled` condition:

Replace:
```typescript
  enabled: order?.status === 'COMPLETED',
```
with:
```typescript
  enabled: isAdmin && order?.status === 'COMPLETED',
```

- [ ] **Step 3: Gate BenchmarkLauncher render**

Wrap the `<BenchmarkLauncher>` component (around line 1740):

Replace:
```tsx
            <BenchmarkLauncher
```
with:
```tsx
            {isAdmin && <BenchmarkLauncher
```

And after the closing `/>` of BenchmarkLauncher (around line 1754), add:
```tsx
            }
```

- [ ] **Step 4: Gate inline benchmark progress block**

Wrap the benchmark progress card (around line 1756). Find the condition `{benchmarkJobId && benchmarkProgress && (` and replace with:
```tsx
            {isAdmin && benchmarkJobId && benchmarkProgress && (
```

- [ ] **Step 5: Gate benchmark tab header**

Wrap the TabsTrigger for benchmark (around line 1880):

Replace:
```tsx
              <TabsTrigger value="benchmark">
```
with:
```tsx
              {isAdmin && <TabsTrigger value="benchmark">
```

After the closing `</TabsTrigger>` (around line 1887), add:
```tsx
              }
```

- [ ] **Step 6: Gate benchmark tab content**

Wrap the TabsContent for benchmark (around line 1949):

Replace:
```tsx
              <TabsContent value="benchmark">
                <BenchmarkMatrix orderId={id} />
              </TabsContent>
```
with:
```tsx
              {isAdmin && (
                <TabsContent value="benchmark">
                  <BenchmarkMatrix orderId={id} />
                </TabsContent>
              )}
```

- [ ] **Step 7: Verify TypeScript compiles**

Run: `cd packages/server && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add "packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx"
git commit -m "feat(benchmark): gate all benchmark UI behind admin role"
```

---

### Task 3: setup_llm_env() — FD v3 from snapshot

Propagate FD v3 config from the job's LLM config snapshot to environment variables, so the pipeline uses snapshot values instead of Modal Secret defaults.

**Files:**
- Modify: `packages/modal/worker.py:1318-1371`

- [ ] **Step 1: Add FD v3 propagation to setup_llm_env**

In `packages/modal/worker.py`, find the `setup_llm_env` function. After the block that sets FD v2 defaults from Modal env vars (the `for env_key, default in [...]` loop ending around line 1370), add FD v3 snapshot overrides:

Replace the end of `setup_llm_env` (the `for env_key, default` block, lines 1361-1371):
```python
    for env_key, default in [
        ("FD_V2_BRANCH", "B"),
        ("FD_V2_MIN_FILES", "50"),
        ("FD_V2_HOLISTIC", "true"),
        ("FD_LARGE_LLM_PROVIDER", ""),
        ("FD_LARGE_LLM_MODEL", ""),
        ("FD_V3_ENABLED", ""),
    ]:
        if env_key not in os.environ:
            os.environ[env_key] = default
```
with:
```python
    for env_key, default in [
        ("FD_V2_BRANCH", "B"),
        ("FD_V2_MIN_FILES", "50"),
        ("FD_V2_HOLISTIC", "true"),
        ("FD_LARGE_LLM_PROVIDER", ""),
        ("FD_LARGE_LLM_MODEL", ""),
        ("FD_V3_ENABLED", ""),
    ]:
        if env_key not in os.environ:
            os.environ[env_key] = default

    # FD v3 config from snapshot (overrides Modal Secret values when present).
    # Benchmarks snapshot FD config at launch time — this ensures the worker
    # uses the same FD routing as intended, not whatever the Secret currently has.
    if llm_config.get("fdV3Enabled") is not None:
        os.environ["FD_V3_ENABLED"] = str(llm_config["fdV3Enabled"]).lower()
    if llm_config.get("fdLargeModel"):
        os.environ["FD_LARGE_LLM_MODEL"] = llm_config["fdLargeModel"]
    if llm_config.get("fdLargeProvider"):
        os.environ["FD_LARGE_LLM_PROVIDER"] = llm_config["fdLargeProvider"]
```

- [ ] **Step 2: Verify no syntax errors**

Run: `cd packages/modal && python -c "import ast; ast.parse(open('worker.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add packages/modal/worker.py
git commit -m "feat(modal): propagate FD v3 config from snapshot in setup_llm_env"
```

---

### Task 4: db.py — benchmark-aware helpers

Add three DB functions: `get_base_commit_shas()` for commit pinning, `delete_benchmark_analyses()` for rollback, and extend `save_commit_analyses()` with an optional `job_id` parameter.

**Files:**
- Modify: `packages/modal/db.py:328-360`

- [ ] **Step 1: Add get_base_commit_shas function**

In `packages/modal/db.py`, after the `delete_analyses_since` function (after line 322), add:

```python
def get_base_commit_shas(conn, order_id: str, repository: str) -> set[str]:
    """Get commit SHAs from the original analysis (jobId IS NULL) for benchmark pinning."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT "commitHash" FROM "CommitAnalysis"
            WHERE "orderId" = %s AND "jobId" IS NULL AND repository = %s
        """, (order_id, repository))
        return {row[0] for row in cur.fetchall()}
```

- [ ] **Step 2: Add delete_benchmark_analyses function**

After `get_base_commit_shas`, add:

```python
def delete_benchmark_analyses(conn, order_id: str, job_id: str) -> int:
    """Delete all CommitAnalysis rows for a benchmark job (rollback on failure)."""
    with conn.cursor() as cur:
        cur.execute(
            'DELETE FROM "CommitAnalysis" WHERE "orderId" = %s AND "jobId" = %s',
            (order_id, job_id),
        )
        deleted = cur.rowcount or 0
    conn.commit()
    return deleted
```

- [ ] **Step 3: Extend save_commit_analyses with optional job_id**

Replace the existing `save_commit_analyses` function:

```python
def save_commit_analyses(conn, analyses: list[dict]):
    """Batch insert CommitAnalysis rows."""
    with conn.cursor() as cur:
        for a in analyses:
            cur.execute("""
                INSERT INTO "CommitAnalysis" (
                    id, "orderId", "commitHash", "commitMessage",
                    "authorEmail", "authorName", "authorDate", repository,
                    additions, deletions, "filesCount",
                    "effortHours", category, complexity, confidence,
                    method, "llmModel", "analyzedAt"
                ) VALUES (
                    gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()
                ) ON CONFLICT ("orderId", "commitHash") WHERE "jobId" IS NULL DO NOTHING
            """, (
                a["order_id"], a["commit_hash"], a["commit_message"],
                a["author_email"], a["author_name"], a["author_date"],
                a["repository"],
                a["additions"], a["deletions"], a["files_count"],
                a["effort_hours"], a["category"], a["complexity"],
                a["confidence"], a["method"], a["llm_model"],
            ))
    conn.commit()
```

with:

```python
def save_commit_analyses(conn, analyses: list[dict], job_id: str | None = None):
    """Batch insert CommitAnalysis rows.

    When job_id is provided (benchmarks), rows are written with that jobId and use
    the composite unique constraint (orderId, commitHash, jobId) for conflict handling.
    When job_id is None (regular analysis), rows use the partial index WHERE jobId IS NULL.
    """
    with conn.cursor() as cur:
        for a in analyses:
            if job_id is not None:
                cur.execute("""
                    INSERT INTO "CommitAnalysis" (
                        id, "orderId", "jobId", "commitHash", "commitMessage",
                        "authorEmail", "authorName", "authorDate", repository,
                        additions, deletions, "filesCount",
                        "effortHours", category, complexity, confidence,
                        method, "llmModel", "analyzedAt"
                    ) VALUES (
                        gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()
                    ) ON CONFLICT ("orderId", "commitHash", "jobId") DO NOTHING
                """, (
                    a["order_id"], job_id, a["commit_hash"], a["commit_message"],
                    a["author_email"], a["author_name"], a["author_date"],
                    a["repository"],
                    a["additions"], a["deletions"], a["files_count"],
                    a["effort_hours"], a["category"], a["complexity"],
                    a["confidence"], a["method"], a["llm_model"],
                ))
            else:
                cur.execute("""
                    INSERT INTO "CommitAnalysis" (
                        id, "orderId", "commitHash", "commitMessage",
                        "authorEmail", "authorName", "authorDate", repository,
                        additions, deletions, "filesCount",
                        "effortHours", category, complexity, confidence,
                        method, "llmModel", "analyzedAt"
                    ) VALUES (
                        gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()
                    ) ON CONFLICT ("orderId", "commitHash") WHERE "jobId" IS NULL DO NOTHING
                """, (
                    a["order_id"], a["commit_hash"], a["commit_message"],
                    a["author_email"], a["author_name"], a["author_date"],
                    a["repository"],
                    a["additions"], a["deletions"], a["files_count"],
                    a["effort_hours"], a["category"], a["complexity"],
                    a["confidence"], a["method"], a["llm_model"],
                ))
    conn.commit()
```

- [ ] **Step 4: Update db.py imports in worker.py**

In `packages/modal/worker.py`, update the import block (line 53-61) to include the new functions:

Replace:
```python
from db import (
    connect_db, acquire_job, load_order, load_github_token,
    load_demo_live_settings,
    get_existing_shas, lookup_cached_commits, copy_cached_to_order,
    save_commit_analyses, update_progress, update_heartbeat,
    set_job_status, set_job_error, increment_total_commits,
    update_llm_usage, account_cached_batch, delete_existing_analyses, delete_analyses_since,
    append_job_event,
)
```
with:
```python
from db import (
    connect_db, acquire_job, load_order, load_github_token,
    load_demo_live_settings,
    get_existing_shas, get_base_commit_shas, lookup_cached_commits, copy_cached_to_order,
    save_commit_analyses, update_progress, update_heartbeat,
    set_job_status, set_job_error, increment_total_commits,
    update_llm_usage, account_cached_batch, delete_existing_analyses, delete_analyses_since,
    delete_benchmark_analyses,
    append_job_event,
)
```

- [ ] **Step 5: Verify no syntax errors**

Run: `cd packages/modal && python -c "import ast; ast.parse(open('db.py').read()); ast.parse(open('worker.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add packages/modal/db.py packages/modal/worker.py
git commit -m "feat(modal): add benchmark DB helpers — job_id save, base commit pinning, rollback"
```

---

### Task 5: Benchmark endpoint — Modal dispatch

When `PIPELINE_MODE=modal`, dispatch benchmarks to Modal via webhook instead of calling `processAnalysisJob()` locally. Save pipeline flags on the job for the Modal worker to read.

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/benchmark/route.ts:237-262`

- [ ] **Step 1: Write Modal dispatch test**

In `packages/server/src/app/api/orders/[id]/benchmark/__tests__/route.test.ts`, add a new test block after the existing tests:

```typescript
  it('dispatches to Modal when PIPELINE_MODE=modal', async () => {
    process.env.PIPELINE_MODE = 'modal';
    process.env.MODAL_ENDPOINT_URL = 'https://modal.test/trigger';
    process.env.MODAL_WEBHOOK_SECRET = 'test-secret';

    mockOrderFindFirst.mockResolvedValue({ id: 'order-1', status: 'COMPLETED' });
    mockJobFindFirst
      .mockResolvedValueOnce(null)   // no running job
      .mockResolvedValueOnce({ id: 'base-job' })  // base job
      .mockResolvedValueOnce(null);  // no previous same model
    mockJobCreate.mockResolvedValue({ id: 'modal-job' });

    // Mock prisma.analysisJob.update for saving flags + modalCallId
    const mockJobUpdate = vi.fn().mockResolvedValue({});
    const db = (await import('@/lib/db')).default;
    (db.analysisJob as any).update = mockJobUpdate;

    // Mock fetch: OpenRouter catalog + preflight + Modal trigger
    (global.fetch as any) = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'qwen/qwen3-coder-next', context_length: 32768 }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ modal_call_id: 'mc-1' }) });

    const req = makeRequest({ provider: 'openrouter', model: 'qwen/qwen3-coder-next' });
    const res = await POST(req, { params: Promise.resolve({ id: 'order-1' }) });
    expect(res.status).toBe(200);

    // Verify Modal was triggered (3rd fetch call)
    const fetchCalls = (global.fetch as any).mock.calls;
    const modalCall = fetchCalls[2];
    expect(modalCall[0]).toBe('https://modal.test/trigger');
    const modalBody = JSON.parse(modalCall[1].body);
    expect(modalBody.job_id).toBe('modal-job');
    expect(modalBody.auth_token).toBe('test-secret');

    // Verify pipeline flags saved
    const updateCall = mockJobUpdate.mock.calls[0];
    expect(updateCall[0].data.executionMode).toBe('modal');
    expect(updateCall[0].data.cacheMode).toBe('off');
    expect(updateCall[0].data.skipBilling).toBe(true);

    // processAnalysisJob should NOT be called
    const { processAnalysisJob } = await import('@/lib/services/analysis-worker');
    expect(processAnalysisJob).not.toHaveBeenCalled();

    delete process.env.PIPELINE_MODE;
    delete process.env.MODAL_ENDPOINT_URL;
    delete process.env.MODAL_WEBHOOK_SECRET;
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test -- src/app/api/orders/\\[id\\]/benchmark/__tests__/route.test.ts`
Expected: FAIL — no Modal dispatch logic exists yet

- [ ] **Step 3: Implement Modal dispatch in POST handler**

In `packages/server/src/app/api/orders/[id]/benchmark/route.ts`, add the `analysisLogger` import if not already present:

```typescript
import { analysisLogger } from '@/lib/logger';
```

Replace the fire-and-forget section (around lines 250-262):

```typescript
  // Fire-and-forget — return immediately, client polls /progress
  processAnalysisJob(job.id, {
    isBenchmark: true,
    llmConfigOverride: resolvedConfig,
    noLlmCache: !!previousSameModelRun,
    contextLength: effectiveContextLength,
    failFast: true,
    promptRepeat: !!body.promptRepeat,
  }).catch((err) => {
    analysisLogger.error({ err, jobId: job.id, orderId: id }, 'Benchmark failed');
  });

  return apiResponse({ jobId: job.id, status: 'PENDING' });
```

with:

```typescript
  const pipelineMode = process.env.PIPELINE_MODE || 'local';

  if (pipelineMode === 'modal') {
    // Save pipeline flags for Modal worker to read
    await prisma.analysisJob.update({
      where: { id: job.id },
      data: {
        executionMode: 'modal',
        cacheMode: 'off',
        skipBilling: true,
      },
    });

    // Trigger Modal — if fails, job stays PENDING, watchdog retries
    try {
      const resp = await fetch(process.env.MODAL_ENDPOINT_URL!, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: job.id,
          auth_token: process.env.MODAL_WEBHOOK_SECRET,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        await prisma.analysisJob.update({
          where: { id: job.id },
          data: { modalCallId: data.modal_call_id },
        });
      } else {
        analysisLogger.warn(
          { status: resp.status, jobId: job.id },
          'Modal benchmark trigger failed — job stays PENDING for watchdog retry',
        );
      }
    } catch (err) {
      analysisLogger.warn(
        { err, jobId: job.id },
        'Modal benchmark trigger network error — job stays PENDING for watchdog retry',
      );
    }
  } else {
    // Local mode — fire-and-forget, client polls /progress
    processAnalysisJob(job.id, {
      isBenchmark: true,
      llmConfigOverride: resolvedConfig,
      noLlmCache: !!previousSameModelRun,
      contextLength: effectiveContextLength,
      failFast: true,
      promptRepeat: !!body.promptRepeat,
    }).catch((err) => {
      analysisLogger.error({ err, jobId: job.id, orderId: id }, 'Benchmark failed');
    });
  }

  return apiResponse({ jobId: job.id, status: 'PENDING' });
```

- [ ] **Step 4: Run tests**

Run: `cd packages/server && pnpm test -- src/app/api/orders/\\[id\\]/benchmark/__tests__/route.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd packages/server && npx tsc --noEmit 2>&1 | head -20`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/app/api/orders/\[id\]/benchmark/route.ts \
       packages/server/src/app/api/orders/\[id\]/benchmark/__tests__/route.test.ts
git commit -m "feat(benchmark): dispatch to Modal when PIPELINE_MODE=modal"
```

---

### Task 6: Modal worker — benchmark mode

Add benchmark awareness to `run_analysis()` in the Modal worker: detect benchmark jobs, skip order mutations, pin commits to base set, write with jobId, use benchmark-specific rollback, set COMPLETED directly, and suppress order-level error state.

**Files:**
- Modify: `packages/modal/worker.py:162-631` (run_analysis function)
- Modify: `packages/modal/worker.py:634-943` (_process_repo_commits function)
- Modify: `packages/modal/db.py:505-528` (set_job_error function)

- [ ] **Step 1: Add skip_order_update param to set_job_error**

In `packages/modal/db.py`, modify `set_job_error`:

Replace:
```python
def set_job_error(conn, job_id: str, error_msg: str, fatal: bool = False):
    """Mark job as failed (retryable or fatal)."""
    status = "FAILED_FATAL" if fatal else "FAILED_RETRYABLE"
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE "AnalysisJob"
            SET status = %s, error = %s, "completedAt" = NOW(), "updatedAt" = NOW()
            WHERE id = %s
        """, (status, error_msg[:2000], job_id))  # Truncate error to avoid DB overflow
        if fatal:
            cur.execute(
                """
                UPDATE "Order"
                SET status = 'FAILED',
                    "errorMessage" = %s,
                    "updatedAt" = NOW()
                WHERE id = (SELECT "orderId" FROM "AnalysisJob" WHERE id = %s)
                """,
                (error_msg[:1000], job_id),
            )
    conn.commit()
```
with:
```python
def set_job_error(conn, job_id: str, error_msg: str, fatal: bool = False,
                  skip_order_update: bool = False):
    """Mark job as failed (retryable or fatal).

    When skip_order_update is True (benchmarks), the Order status is NOT set to FAILED.
    Benchmark failures should not affect the underlying order.
    """
    status = "FAILED_FATAL" if fatal else "FAILED_RETRYABLE"
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE "AnalysisJob"
            SET status = %s, error = %s, "completedAt" = NOW(), "updatedAt" = NOW()
            WHERE id = %s
        """, (status, error_msg[:2000], job_id))  # Truncate error to avoid DB overflow
        if fatal and not skip_order_update:
            cur.execute(
                """
                UPDATE "Order"
                SET status = 'FAILED',
                    "errorMessage" = %s,
                    "updatedAt" = NOW()
                WHERE id = (SELECT "orderId" FROM "AnalysisJob" WHERE id = %s)
                """,
                (error_msg[:1000], job_id),
            )
    conn.commit()
```

- [ ] **Step 2: Extend set_job_status for COMPLETED finalization**

In `packages/modal/db.py`, modify `set_job_status` to set `completedAt` and `currentStep` when status is `COMPLETED` (benchmarks finalize directly, unlike regular analysis which goes through `LLM_COMPLETE` → watchdog → `COMPLETED`):

Replace:
```python
    if status == "LLM_COMPLETE":
        updates.append('"currentStep" = %s')
        params.append("llm_complete")
```
with:
```python
    if status == "LLM_COMPLETE":
        updates.append('"currentStep" = %s')
        params.append("llm_complete")
    elif status == "COMPLETED":
        updates.append('"completedAt" = NOW()')
        updates.append('"currentStep" = %s')
        params.append("completed")
```

- [ ] **Step 3: Add benchmark params to _process_repo_commits**

In `packages/modal/worker.py`, modify the `_process_repo_commits` signature (line 634):

Replace:
```python
def _process_repo_commits(
    conn, job_id, order, repo_full_name, repo_path, language,
    commits, cache_mode, current_llm_model, llm_config,
    rate_limiter, total_analyzed, total_cache_hits,
    repo_idx, total_repos, skip_billing=False, demo_live_mode=False,
    demo_live_chunk_size=DEMO_LIVE_CHUNK_SIZE_ENV_FALLBACK,
):
```
with:
```python
def _process_repo_commits(
    conn, job_id, order, repo_full_name, repo_path, language,
    commits, cache_mode, current_llm_model, llm_config,
    rate_limiter, total_analyzed, total_cache_hits,
    repo_idx, total_repos, skip_billing=False, demo_live_mode=False,
    demo_live_chunk_size=DEMO_LIVE_CHUNK_SIZE_ENV_FALLBACK,
    is_benchmark=False, benchmark_job_id=None,
):
```

- [ ] **Step 4: Replace dedup with commit pinning for benchmarks**

In `_process_repo_commits`, replace the intra-order dedup block (around lines 661-675):

Replace:
```python
    # Intra-order dedup
    existing_shas = get_existing_shas(conn, order["id"], repo_full_name)
    commits = [c for c in commits if c["sha"] not in existing_shas]
    append_job_event(
        conn,
        job_id,
        "Intra-order deduplication complete",
        phase="dedup",
        code="REPO_DEDUP_DONE",
        repo_name=repo_full_name,
        payload={
            "existingCount": len(existing_shas),
            "remainingCount": len(commits),
        },
    )
```
with:
```python
    # Intra-order dedup / benchmark commit pinning
    if is_benchmark:
        # Pin to base analysis set — only analyze commits the original analyzed
        base_shas = get_base_commit_shas(conn, order["id"], repo_full_name)
        commits = [c for c in commits if c["sha"] in base_shas]
        append_job_event(
            conn,
            job_id,
            "Benchmark commit pinning complete",
            phase="dedup",
            code="BENCHMARK_PIN_DONE",
            repo_name=repo_full_name,
            payload={
                "baseShaCount": len(base_shas),
                "pinnedCount": len(commits),
            },
        )
    else:
        existing_shas = get_existing_shas(conn, order["id"], repo_full_name)
        commits = [c for c in commits if c["sha"] not in existing_shas]
        append_job_event(
            conn,
            job_id,
            "Intra-order deduplication complete",
            phase="dedup",
            code="REPO_DEDUP_DONE",
            repo_name=repo_full_name,
            payload={
                "existingCount": len(existing_shas),
                "remainingCount": len(commits),
            },
        )
```

- [ ] **Step 5: Pass job_id to save_commit_analyses for benchmarks**

In `_process_repo_commits`, find the `save_commit_analyses` call (around line 856):

Replace:
```python
        if analyses:
            save_commit_analyses(conn, analyses)
```
with:
```python
        if analyses:
            save_commit_analyses(conn, analyses, job_id=benchmark_job_id)
```

- [ ] **Step 6: Add is_benchmark detection to run_analysis**

In `run_analysis()`, after the `order_id` / `job_started_at` extraction (around line 173-174), add:

```python
    is_benchmark = job.get("type") == "benchmark"
```

- [ ] **Step 7: Skip force_recalculate and demo_live_mode for benchmarks**

In `run_analysis()`, after `setup_llm_env(llm_config)` (around line 230), modify the force_recalculate and demo_live reads:

Replace:
```python
        cache_mode = job.get("cacheMode") or job.get("cache_mode") or "model"
```
with:
```python
        cache_mode = "off" if is_benchmark else (job.get("cacheMode") or job.get("cache_mode") or "model")
```

After the `force_recalculate` variable (line 225), add a guard:

Replace:
```python
        skip_billing = job.get("skipBilling", False)
        force_recalculate = job.get("forceRecalculate", False)
        demo_live_mode, demo_live_chunk_size = load_demo_live_settings(conn)
```
with:
```python
        skip_billing = True if is_benchmark else job.get("skipBilling", False)
        force_recalculate = False if is_benchmark else job.get("forceRecalculate", False)
        if is_benchmark:
            demo_live_mode, demo_live_chunk_size = False, 1
        else:
            demo_live_mode, demo_live_chunk_size = load_demo_live_settings(conn)
```

- [ ] **Step 8: Skip order currentRepoName for benchmarks**

In `run_analysis()`, find the `update_progress` call with `repo_name` (line 320):

Replace:
```python
            update_progress(conn, job_id, step="cloning", repo_name=repo_full_name)
```
with:
```python
            update_progress(conn, job_id, step="cloning",
                            repo_name=None if is_benchmark else repo_full_name)
```

Also replace the next `update_progress` call (line 330):
```python
            update_progress(conn, job_id, step="extracting")
```
(This one doesn't pass repo_name, so no change needed.)

- [ ] **Step 9: Pass benchmark params to _process_repo_commits calls**

Find all calls to `_process_repo_commits` in `run_analysis()`. There are two:

First call (around line 464, non-LAST_N path):
Replace:
```python
            total_analyzed, total_cache_hits = _process_repo_commits(
                conn, job_id, order, repo_full_name, repo_path, language,
                commits, cache_mode, current_llm_model, llm_config,
                rate_limiter, total_analyzed, total_cache_hits,
                repo_idx, len(repos), skip_billing=skip_billing,
                demo_live_mode=demo_live_mode,
                demo_live_chunk_size=demo_live_chunk_size,
            )
```
with:
```python
            total_analyzed, total_cache_hits = _process_repo_commits(
                conn, job_id, order, repo_full_name, repo_path, language,
                commits, cache_mode, current_llm_model, llm_config,
                rate_limiter, total_analyzed, total_cache_hits,
                repo_idx, len(repos), skip_billing=skip_billing,
                demo_live_mode=demo_live_mode,
                demo_live_chunk_size=demo_live_chunk_size,
                is_benchmark=is_benchmark,
                benchmark_job_id=job_id if is_benchmark else None,
            )
```

Second call (around line 507, LAST_N path):
Replace:
```python
                total_analyzed, total_cache_hits = _process_repo_commits(
                    conn, job_id, order, er["repo_full_name"], er["repo_path"],
                    er["language"], repo_commits, cache_mode, current_llm_model,
                    llm_config, rate_limiter, total_analyzed, total_cache_hits,
                    er["repo_idx"], len(repos), skip_billing=skip_billing,
                    demo_live_mode=demo_live_mode,
                    demo_live_chunk_size=demo_live_chunk_size,
                )
```
with:
```python
                total_analyzed, total_cache_hits = _process_repo_commits(
                    conn, job_id, order, er["repo_full_name"], er["repo_path"],
                    er["language"], repo_commits, cache_mode, current_llm_model,
                    llm_config, rate_limiter, total_analyzed, total_cache_hits,
                    er["repo_idx"], len(repos), skip_billing=skip_billing,
                    demo_live_mode=demo_live_mode,
                    demo_live_chunk_size=demo_live_chunk_size,
                    is_benchmark=is_benchmark,
                    benchmark_job_id=job_id if is_benchmark else None,
                )
```

- [ ] **Step 10: Set COMPLETED for benchmarks instead of LLM_COMPLETE**

Replace the completion block (around lines 532-542):

```python
        # All done
        set_job_status(conn, job_id, "LLM_COMPLETE", progress=95)
        append_job_event(
            conn,
            job_id,
            "Modal worker finished; waiting for post-processing",
            phase="worker",
            code="WORKER_LLM_COMPLETE",
            payload={"progress": 95},
        )
        _try_trigger_watchdog_post_processing(conn, job_id)
```

with:

```python
        # All done
        if is_benchmark:
            # Benchmarks complete directly — no post-processing (metrics, DailyEffort)
            set_job_status(conn, job_id, "COMPLETED", progress=100)
            append_job_event(
                conn,
                job_id,
                "Benchmark completed",
                phase="worker",
                code="BENCHMARK_COMPLETED",
                payload={"progress": 100, "totalAnalyzed": total_analyzed},
            )
        else:
            set_job_status(conn, job_id, "LLM_COMPLETE", progress=95)
            append_job_event(
                conn,
                job_id,
                "Modal worker finished; waiting for post-processing",
                phase="worker",
                code="WORKER_LLM_COMPLETE",
                payload={"progress": 95},
            )
            _try_trigger_watchdog_post_processing(conn, job_id)
```

- [ ] **Step 11: Use benchmark rollback in exception handler**

In the exception handler (around lines 564-590), replace the rollback block:

```python
        rollback_deleted = 0
        if order_id and job_started_at:
            try:
                rollback_deleted = delete_analyses_since(conn, order_id, job_started_at)
                if rollback_deleted > 0:
                    append_job_event(
                        conn,
                        job_id,
                        "Rolled back partial analyses from failed run",
                        level="warn",
                        phase="worker",
                        code="ANALYSES_ROLLBACK_OK",
                        payload={"deletedCount": rollback_deleted},
                    )
            except Exception as rollback_err:
                try:
                    append_job_event(
                        conn,
                        job_id,
                        "Rollback of partial analyses failed",
                        level="warn",
                        phase="worker",
                        code="ANALYSES_ROLLBACK_FAILED",
                        payload={"error": str(rollback_err)[:300]},
                    )
                except Exception:
                    pass
```

with:

```python
        rollback_deleted = 0
        if order_id:
            try:
                if is_benchmark:
                    rollback_deleted = delete_benchmark_analyses(conn, order_id, job_id)
                elif job_started_at:
                    rollback_deleted = delete_analyses_since(conn, order_id, job_started_at)
                if rollback_deleted > 0:
                    append_job_event(
                        conn,
                        job_id,
                        "Rolled back partial analyses from failed run",
                        level="warn",
                        phase="worker",
                        code="ANALYSES_ROLLBACK_OK",
                        payload={"deletedCount": rollback_deleted, "benchmark": is_benchmark},
                    )
            except Exception as rollback_err:
                try:
                    append_job_event(
                        conn,
                        job_id,
                        "Rollback of partial analyses failed",
                        level="warn",
                        phase="worker",
                        code="ANALYSES_ROLLBACK_FAILED",
                        payload={"error": str(rollback_err)[:300]},
                    )
                except Exception:
                    pass
```

- [ ] **Step 12: Pass skip_order_update for benchmarks in set_job_error call**

In the exception handler, find the `set_job_error` call (around line 610):

Replace:
```python
            set_job_error(conn, job_id, error_msg, fatal=is_fatal)
```
with:
```python
            set_job_error(conn, job_id, error_msg, fatal=is_fatal,
                          skip_order_update=is_benchmark)
```

Also the fallback call (around line 614):
Replace:
```python
                set_job_error(fresh_conn, job_id, error_msg, fatal=is_fatal)
```
with:
```python
                set_job_error(fresh_conn, job_id, error_msg, fatal=is_fatal,
                              skip_order_update=is_benchmark)
```

- [ ] **Step 13: Verify no syntax errors**

Run: `cd packages/modal && python -c "import ast; ast.parse(open('worker.py').read()); ast.parse(open('db.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 14: Commit**

```bash
git add packages/modal/worker.py packages/modal/db.py
git commit -m "feat(modal): add benchmark mode — skip order mutations, pin commits, jobId writes, rollback"
```

---

### Task 7: Deploy and E2E verification

Deploy the updated Modal worker and Vercel app, then run a benchmark on the production order to verify end-to-end flow.

**Files:** No code changes — deployment and verification only.

- [ ] **Step 1: Deploy Modal worker**

Run: `cd packages/modal && modal deploy app.py`
Expected: Successful deployment with `devghost-trigger` app updated.

- [ ] **Step 2: Deploy to Vercel production**

Run: `cd packages/server && npx vercel --prod`
Expected: Successful deployment to `devghost.pro`.

- [ ] **Step 3: Run benchmark via UI**

1. Log in as admin at `https://devghost.pro`
2. Navigate to the target order (e.g., `cmn561qu00001jv043sg35pd6`)
3. Open the Benchmark tab
4. Launch a benchmark with the current model
5. Watch progress — should advance through cloning → extracting → analyzing → completed

- [ ] **Step 4: Verify benchmark results**

1. After completion, check the Benchmark comparison matrix shows results
2. Verify CommitAnalysis rows have `jobId` set (not null) — check via Prisma Studio or direct SQL
3. Verify the Order status is still `COMPLETED` (not changed by the benchmark)
4. Verify a non-admin user cannot see the Benchmark tab or access benchmark API routes

- [ ] **Step 5: Verify failure rollback (optional)**

If possible, trigger a controlled failure (e.g., use an invalid model) and verify:
1. Job status becomes `FAILED_FATAL`
2. Order status remains `COMPLETED`
3. No partial CommitAnalysis rows remain for that jobId
