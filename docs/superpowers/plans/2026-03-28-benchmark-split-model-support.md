# Benchmark Split-Model Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the benchmark feature aware of the split-model pipeline (small commits via default model, 50+ file commits via FD v3 + large model), so the comparison matrix correctly reflects which model was used per commit and the benchmark snapshot captures the full routing config.

**Architecture:** The pipeline already routes correctly (env vars `FD_V3_ENABLED`, `FD_LARGE_LLM_MODEL` flow through `process.env` in `spawnPipeline`). Changes are limited to: (1) enriching the benchmark snapshot/fingerprint with FD v3 env config, (2) recording the actual model used per FD commit in `CommitAnalysis.llmModel`, (3) exposing split-model info in the comparison matrix API and UI.

**Tech Stack:** Next.js API routes, Prisma, React (benchmark-matrix component), Python pipeline

---

### Task 1: Enrich benchmark snapshot and fingerprint with FD v3 config

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/benchmark/route.ts:190-210`

- [ ] **Step 1: Add FD v3 env vars to snapshot**

In `benchmark/route.ts`, after line 196 (`promptRepeat: !!body.promptRepeat,`), add FD v3 config from process.env into the snapshot object:

```typescript
  // Snapshot: full config minus secrets
  const fdV3Enabled = process.env.FD_V3_ENABLED?.toLowerCase() === 'true' || process.env.FD_V3_ENABLED === '1';
  const fdLargeModel = process.env.FD_LARGE_LLM_MODEL?.trim() || null;
  const fdLargeProvider = process.env.FD_LARGE_LLM_PROVIDER?.trim().toLowerCase() || null;

  const snapshot = {
    ...resolvedConfig,
    openrouter: { ...resolvedConfig.openrouter, apiKey: '[REDACTED]' },
    contextLength: rawContextLength,
    effectiveContextLength,
    promptRepeat: !!body.promptRepeat,
    fdV3Enabled,
    fdLargeModel,
    fdLargeProvider,
  };
```

- [ ] **Step 2: Include FD v3 config in fingerprint**

Update the fingerprint computation (line 200-210) to include FD v3 fields:

```typescript
  const fpData = JSON.stringify({
    provider, model,
    contextLength: effectiveContextLength,
    fdV3Enabled,
    fdLargeModel,
    fdLargeProvider,
    ...(provider === 'openrouter' ? {
      providerOrder: resolvedConfig.openrouter.providerOrder,
      providerIgnore: resolvedConfig.openrouter.providerIgnore,
      allowFallbacks: resolvedConfig.openrouter.allowFallbacks,
      requireParameters: resolvedConfig.openrouter.requireParameters,
    } : {}),
  });
```

- [ ] **Step 3: Verify build**

Run: `cd packages/server && pnpm build 2>&1 | tail -5`
Expected: `Compiled successfully`

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/app/api/orders/\[id\]/benchmark/route.ts
git commit -m "feat(benchmark): include FD v3 config in snapshot and fingerprint"
```

---

### Task 2: Record actual large model in CommitAnalysis.llmModel for FD commits

**Files:**
- Modify: `packages/server/src/lib/services/analysis-worker.ts:949-952`

Currently FD commits get `llmModel: null`. We need to record the actual model used — for FD v3 that's `FD_LARGE_LLM_MODEL` from env, which the pipeline returns in `result.model` (or we derive from env).

- [ ] **Step 1: Check what the pipeline returns for FD commits**

Read the Python pipeline output for FD commits to confirm the `model` field:

```bash
cd packages/server/scripts/pipeline
grep -n "model.*FD\|FD.*model\|large_model\|llm_model" run_v16_pipeline.py | head -20
```

- [ ] **Step 2: Update mapToCommitAnalysis to preserve model for FD commits**

In `analysis-worker.ts`, replace the `llmModel` logic in `mapToCommitAnalysis` (around line 950):

```typescript
    method: result.method ?? null,
    llmModel: result.method === 'root_commit_skip' || result.method === 'error'
      ? null
      : result.method?.startsWith('FD')
        ? (result.model || process.env.FD_LARGE_LLM_MODEL || null)
        : llmModel,
```

This preserves the pipeline-reported model for FD commits. If the pipeline doesn't report it, falls back to the env var. Non-FD commits still use the job-level `llmModel`.

- [ ] **Step 3: Verify build**

Run: `cd packages/server && pnpm build 2>&1 | tail -5`
Expected: `Compiled successfully`

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/lib/services/analysis-worker.ts
git commit -m "feat(benchmark): record actual model for FD commits in CommitAnalysis.llmModel"
```

---

### Task 3: Expose FD v3 split info in comparison matrix API

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/benchmark/compare/route.ts:103-143`

The `runs` array needs to include FD v3 config from the snapshot, and per-commit data should include `llmModel` so the UI can show which model processed each commit.

- [ ] **Step 1: Add fdV3 fields to run objects**

In `compare/route.ts`, inside the `runs` map (around line 124-143), extract FD v3 info from the snapshot and add to the run object:

```typescript
    return {
      jobId: isOriginal ? null : job.id,
      logJobId: job.id,
      label: isOriginal ? 'Original' : `${job.llmModel || '?'} #${count}`,
      provider: job.llmProvider || '?',
      model: job.llmModel || '?',
      createdAt: job.createdAt.toISOString(),
      configFingerprint: job.llmConfigFingerprint,
      routingProfile,
      costUsd: job.totalCostUsd ? Number(job.totalCostUsd) : null,
      promptRepeat: !!snap?.promptRepeat,
      effectiveContextLength: snap?.effectiveContextLength as number | null ?? null,
      fdV3Enabled: !!snap?.fdV3Enabled,
      fdLargeModel: (snap?.fdLargeModel as string) || null,
      fdLargeProvider: (snap?.fdLargeProvider as string) || null,
      status: job.status,
      totalHours: 0,
      mae: null as number | null,
      correlation: null as number | null,
      completedCommits: 0,
      totalCommits: 0,
      fdCount: 0,
    };
```

- [ ] **Step 2: Add llmModel to commit analysis query**

In the `allAnalyses` query (line 49-55), add `llmModel` to the select:

```typescript
  const allAnalyses = await prisma.commitAnalysis.findMany({
    where: { orderId: id },
    orderBy: { id: 'asc' },
    select: { commitHash: true, commitMessage: true, repository: true,
              additions: true, deletions: true, filesCount: true,
              effortHours: true, jobId: true, method: true, llmModel: true },
  });
```

- [ ] **Step 3: Add llmModel to commit matrix**

In the commit map building (lines 147-172), add `models` alongside `methods`:

```typescript
  const commitMap = new Map<string, {
    sha: string; message: string; repository: string;
    filesChanged: number; linesAdded: number; linesDeleted: number;
    estimates: Record<string, number>;
    methods: Record<string, string>;
    models: Record<string, string>;
  }>();

  for (const a of allAnalyses) {
    if (!commitMap.has(a.commitHash)) {
      commitMap.set(a.commitHash, {
        sha: a.commitHash,
        message: a.commitMessage,
        repository: a.repository,
        filesChanged: a.filesCount,
        linesAdded: a.additions,
        linesDeleted: a.deletions,
        estimates: {},
        methods: {},
        models: {},
      });
    }
    const key = a.jobId === null ? 'original' : a.jobId;
    commitMap.get(a.commitHash)!.estimates[key] = Number(a.effortHours);
    if (a.method) {
      commitMap.get(a.commitHash)!.methods[key] = a.method;
    }
    if (a.llmModel) {
      commitMap.get(a.commitHash)!.models[key] = a.llmModel;
    }
  }
```

- [ ] **Step 4: Verify build**

Run: `cd packages/server && pnpm build 2>&1 | tail -5`
Expected: `Compiled successfully`

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/api/orders/\[id\]/benchmark/compare/route.ts
git commit -m "feat(benchmark): expose FD v3 split config and per-commit model in comparison API"
```

---

### Task 4: Update benchmark matrix UI to show split-model info

**Files:**
- Modify: `packages/server/src/components/benchmark-matrix.tsx`

Two changes: (1) column header shows FD v3 config when present, (2) per-commit FD badge shows the large model name.

- [ ] **Step 1: Update Run type to include FD v3 fields**

In `benchmark-matrix.tsx`, add to the `Run` interface (around line 33-57):

```typescript
interface Run {
  jobId: string | null;
  logJobId: string;
  label: string;
  provider: string;
  model: string;
  createdAt: string;
  configFingerprint: string | null;
  routingProfile: {
    order: string[];
    ignore: string[];
    allowFallbacks: boolean;
    requireParameters: boolean;
  } | null;
  costUsd: number | null;
  promptRepeat: boolean;
  effectiveContextLength: number | null;
  fdV3Enabled: boolean;
  fdLargeModel: string | null;
  fdLargeProvider: string | null;
  status: string;
  totalHours: number;
  mae: number | null;
  correlation: number | null;
  completedCommits: number;
  totalCommits: number;
  fdCount: number;
}
```

- [ ] **Step 2: Update Commit type to include models**

Add `models` to the `Commit` interface:

```typescript
interface Commit {
  sha: string;
  message: string;
  repository: string;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  estimates: Record<string, number>;
  methods: Record<string, string>;
  models: Record<string, string>;
  groundTruth: number | null;
}
```

- [ ] **Step 3: Show FD v3 badge in column header**

In the column header rendering (around line 654-665), add FD v3 info below the model name:

```tsx
                    <div className="flex flex-col items-center gap-1">
                      <Badge variant={providerBadgeVariant(run.provider)}>
                        {run.provider}
                      </Badge>
                      <span className="text-xs font-normal whitespace-nowrap">
                        {run.model}
                      </span>
                      {run.fdV3Enabled && run.fdLargeModel && (
                        <span className="text-[10px] text-orange-600 font-medium whitespace-nowrap">
                          50+ files: {run.fdLargeModel.split('/').pop()}
                        </span>
                      )}
                      {run.jobId !== null && (
                        <span className="text-[10px] text-muted-foreground">
                          {formatDate(run.createdAt)}
                        </span>
                      )}
```

- [ ] **Step 4: Show model name in per-commit FD tooltip**

Update the FD badge in commit rows (around line 915-921) to show the actual model in the tooltip:

```tsx
                                {isFD && (
                                  <span
                                    className="text-[9px] font-semibold text-orange-500 leading-none"
                                    title={`${method}${commit.models?.[runKey(run)] ? ` (${commit.models[runKey(run)]})` : ''}`}
                                  >
                                    FD
                                  </span>
                                )}
```

- [ ] **Step 5: Update CSV export to include models**

In the CSV export logic (around line 488-494), add model info for FD commits:

```typescript
      ...sortedRuns.map(r => {
        const v = c.estimates[runKey(r)];
        const m = c.methods?.[runKey(r)];
        const model = c.models?.[runKey(r)];
        const fd = m?.startsWith('FD') ? ` FD${model ? `(${model.split('/').pop()})` : ''}` : '';
        return v != null ? `${v.toFixed(1)}${fd}` : '';
      }),
```

- [ ] **Step 6: Verify build**

Run: `cd packages/server && pnpm build 2>&1 | tail -5`
Expected: `Compiled successfully`

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/components/benchmark-matrix.tsx
git commit -m "feat(benchmark): show split-model config in comparison matrix UI"
```

---

### Task 5: Verify Python pipeline returns model info for FD commits

**Files:**
- Modify: `packages/server/scripts/pipeline/run_v16_pipeline.py` (if needed)

The pipeline returns per-commit results as JSON. Verify that FD v3 results include a `model` field with the large model name. If not, add it.

- [ ] **Step 1: Check FD v3 result format**

```bash
cd packages/server/scripts/pipeline
grep -A 10 "estimated_hours.*method.*FD\|FD.*estimated_hours\|v3_holistic\|bulk_scaffold" run_v16_pipeline.py | head -40
```

Look for the return dict that builds the per-commit result. Check if `model` field is included.

- [ ] **Step 2: Add model field to FD result if missing**

If the FD path doesn't include `"model"` in its result dict, add it. The pattern should be:

In `run_fd_hybrid` or `run_fd_v3_holistic` result return, add:
```python
"model": FD_LARGE_LLM_MODEL or OPENROUTER_MODEL,
```

The exact location depends on what Step 1 finds. There are three FD paths:
1. `run_fd_v3_holistic` — should return `"model": FD_LARGE_LLM_MODEL`
2. `bulk_scaffold_detector` — should return `"model": FD_LARGE_LLM_MODEL`
3. `run_fd_hybrid` (legacy FD v2) — should return `"model": FD_LARGE_LLM_MODEL or OPENROUTER_MODEL`

- [ ] **Step 3: Verify the analysis-worker reads result.model**

Check that the TypeScript pipeline result type includes `model`:

```bash
grep -n "model.*PipelineCommit\|interface.*Pipeline\|type.*Pipeline" packages/server/src/lib/services/pipeline-bridge.ts | head -10
```

If the type doesn't include `model?: string`, add it to `PipelineCommitResult` (or equivalent interface).

- [ ] **Step 4: Commit**

```bash
git add packages/server/scripts/pipeline/run_v16_pipeline.py packages/server/src/lib/services/pipeline-bridge.ts
git commit -m "feat(pipeline): include model name in FD commit results"
```

---

### Task 6: Add route tests for benchmark snapshot and comparison API

**Files:**
- Create: `packages/server/src/app/api/orders/[id]/benchmark/__tests__/route.test.ts`
- Create: `packages/server/src/app/api/orders/[id]/benchmark/compare/__tests__/route.test.ts`

Tests follow existing patterns from `packages/server/src/app/api/orders/[id]/analyze/__tests__/route.test.ts` and `packages/server/src/app/api/admin/llm-settings/__tests__/route.test.ts`.

- [ ] **Step 1: Write benchmark POST route test — snapshot includes FD v3 fields**

Create `packages/server/src/app/api/orders/[id]/benchmark/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockOrderFindFirst = vi.fn();
const mockJobFindFirst = vi.fn();
const mockJobCreate = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    order: { findFirst: (...a: unknown[]) => mockOrderFindFirst(...a) },
    analysisJob: { findFirst: (...a: unknown[]) => mockJobFindFirst(...a), create: (...a: unknown[]) => mockJobCreate(...a) },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'test@test.com', role: 'USER' } }),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
  apiResponse: vi.fn((data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })),
  apiError: vi.fn((msg: string, status: number) => new Response(JSON.stringify({ success: false, error: msg }), { status })),
  parseBody: vi.fn(async (req: NextRequest) => {
    const body = await req.json();
    return { success: true, data: body };
  }),
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

// Mock fetch for OpenRouter validation
global.fetch = vi.fn()
  .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'qwen/qwen3-coder-next', context_length: 32768 }] }) })
  .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

import { POST } from '../../route';

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(new URL('http://localhost/api/orders/order-1/benchmark'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/orders/[id]/benchmark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FD_V3_ENABLED = 'true';
    process.env.FD_LARGE_LLM_MODEL = 'qwen/qwen3-coder-plus';
    process.env.FD_LARGE_LLM_PROVIDER = 'openrouter';
    // Re-mock fetch for each test
    (global.fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'qwen/qwen3-coder-next', context_length: 32768 }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
  });

  it('includes FD v3 config in snapshot', async () => {
    mockOrderFindFirst.mockResolvedValue({ id: 'order-1', status: 'COMPLETED' });
    mockJobFindFirst
      .mockResolvedValueOnce(null)  // no running job
      .mockResolvedValueOnce({ id: 'base-job' })  // base job
      .mockResolvedValueOnce(null);  // no previous same model
    mockJobCreate.mockResolvedValue({ id: 'new-job' });

    const req = makeRequest({ provider: 'openrouter', model: 'qwen/qwen3-coder-next' });
    await POST(req, { params: Promise.resolve({ id: 'order-1' }) });

    const createCall = mockJobCreate.mock.calls[0]![0];
    const snapshot = createCall.data.llmConfigSnapshot;
    expect(snapshot.fdV3Enabled).toBe(true);
    expect(snapshot.fdLargeModel).toBe('qwen/qwen3-coder-plus');
    expect(snapshot.fdLargeProvider).toBe('openrouter');
  });

  it('FD v3 config affects fingerprint', async () => {
    mockOrderFindFirst.mockResolvedValue({ id: 'order-1', status: 'COMPLETED' });
    mockJobFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'base-job' })
      .mockResolvedValueOnce(null);
    mockJobCreate.mockResolvedValue({ id: 'job-1' });

    const req1 = makeRequest({ provider: 'openrouter', model: 'qwen/qwen3-coder-next' });
    await POST(req1, { params: Promise.resolve({ id: 'order-1' }) });
    const fp1 = mockJobCreate.mock.calls[0]![0].data.llmConfigFingerprint;

    // Change FD config
    process.env.FD_LARGE_LLM_MODEL = 'qwen/qwen3-coder-32b';
    vi.clearAllMocks();
    mockOrderFindFirst.mockResolvedValue({ id: 'order-1', status: 'COMPLETED' });
    mockJobFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'base-job' }).mockResolvedValueOnce(null);
    mockJobCreate.mockResolvedValue({ id: 'job-2' });
    (global.fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'qwen/qwen3-coder-next', context_length: 32768 }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const req2 = makeRequest({ provider: 'openrouter', model: 'qwen/qwen3-coder-next' });
    await POST(req2, { params: Promise.resolve({ id: 'order-1' }) });
    const fp2 = mockJobCreate.mock.calls[0]![0].data.llmConfigFingerprint;

    expect(fp1).not.toBe(fp2);
  });
});
```

- [ ] **Step 2: Write comparison API test — split-model fields in response**

Create `packages/server/src/app/api/orders/[id]/benchmark/compare/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockOrderFindFirst = vi.fn();
const mockJobFindMany = vi.fn();
const mockCommitFindMany = vi.fn();
const mockGtFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    order: { findFirst: (...a: unknown[]) => mockOrderFindFirst(...a) },
    analysisJob: { findMany: (...a: unknown[]) => mockJobFindMany(...a) },
    commitAnalysis: { findMany: (...a: unknown[]) => mockCommitFindMany(...a) },
    groundTruth: { findMany: (...a: unknown[]) => mockGtFindMany(...a) },
  },
}));

vi.mock('@/lib/auth', () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
}));

import { GET } from '../../route';

describe('GET /api/orders/[id]/benchmark/compare', () => {
  beforeEach(() => vi.clearAllMocks());

  it('includes fdV3 fields in benchmark run', async () => {
    mockOrderFindFirst.mockResolvedValue({ id: 'order-1' });
    mockJobFindMany.mockResolvedValue([
      {
        id: 'job-analysis', type: 'analysis', status: 'COMPLETED',
        llmProvider: 'openrouter', llmModel: 'old-model', createdAt: new Date(),
        totalCostUsd: null, llmConfigFingerprint: 'fp1', llmConfigSnapshot: {},
      },
      {
        id: 'job-bench', type: 'benchmark', status: 'COMPLETED',
        llmProvider: 'openrouter', llmModel: 'qwen/qwen3-coder-next', createdAt: new Date(),
        totalCostUsd: null, llmConfigFingerprint: 'fp2',
        llmConfigSnapshot: {
          fdV3Enabled: true,
          fdLargeModel: 'qwen/qwen3-coder-plus',
          fdLargeProvider: 'openrouter',
          effectiveContextLength: 32768,
        },
      },
    ]);
    mockCommitFindMany.mockResolvedValue([
      { commitHash: 'abc', commitMessage: 'test', repository: 'repo', additions: 10, deletions: 5, filesCount: 2, effortHours: 1.0, jobId: null, method: 'llm_v16', llmModel: 'old-model' },
      { commitHash: 'abc', commitMessage: 'test', repository: 'repo', additions: 10, deletions: 5, filesCount: 2, effortHours: 1.5, jobId: 'job-bench', method: 'llm_v16', llmModel: 'qwen/qwen3-coder-next' },
      { commitHash: 'def', commitMessage: 'big', repository: 'repo', additions: 500, deletions: 100, filesCount: 80, effortHours: 5.0, jobId: null, method: 'FD_fallback', llmModel: null },
      { commitHash: 'def', commitMessage: 'big', repository: 'repo', additions: 500, deletions: 100, filesCount: 80, effortHours: 8.0, jobId: 'job-bench', method: 'FD_v3_holistic', llmModel: 'qwen/qwen3-coder-plus' },
    ]);
    mockGtFindMany.mockResolvedValue([]);

    const req = new NextRequest(new URL('http://localhost/api/orders/order-1/benchmark/compare'));
    const res = await GET(req, { params: Promise.resolve({ id: 'order-1' }) });
    const body = await res.json();

    // Benchmark run has FD v3 fields
    const benchRun = body.runs.find((r: any) => r.jobId === 'job-bench');
    expect(benchRun.fdV3Enabled).toBe(true);
    expect(benchRun.fdLargeModel).toBe('qwen/qwen3-coder-plus');
    expect(benchRun.fdLargeProvider).toBe('openrouter');

    // Original run does not
    const origRun = body.runs.find((r: any) => r.jobId === null);
    expect(origRun.fdV3Enabled).toBe(false);

    // Per-commit models are exposed
    const bigCommit = body.commits.find((c: any) => c.sha === 'def');
    expect(bigCommit.models['job-bench']).toBe('qwen/qwen3-coder-plus');
    expect(bigCommit.models['original']).toBeUndefined(); // old FD had null model
  });
});
```

- [ ] **Step 3: Run tests**

Run: `cd packages/server && pnpm test -- --run src/app/api/orders/\\[id\\]/benchmark/ 2>&1 | tail -20`
Expected: tests pass

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/app/api/orders/\[id\]/benchmark/__tests__/route.test.ts
git add packages/server/src/app/api/orders/\[id\]/benchmark/compare/__tests__/route.test.ts
git commit -m "test(benchmark): add route tests for split-model snapshot, fingerprint, and comparison"
```

---

### Task 7: End-to-end verification on staging

No code changes — manual verification on staging deployment.

- [ ] **Step 1: Deploy to staging**

```bash
cd /c/Projects/devghost && vercel deploy --yes
```

- [ ] **Step 2: Run benchmark on staging order**

Navigate to a completed order on staging, launch benchmark with `openrouter` / `qwen/qwen3-coder-next`. Wait for completion.

- [ ] **Step 3: Verify comparison matrix**

Open the benchmark comparison matrix and check:
1. Column header shows `qwen3-coder-next` + FD v3 line with `qwen3-coder-plus`
2. Commits with 50+ files show orange "FD" badge
3. FD badge tooltip includes model name `qwen/qwen3-coder-plus`
4. FD commits row shows non-zero count
5. Original column does NOT show FD v3 info (it wasn't configured then)

- [ ] **Step 4: Commit staging validation result**

Update staging checklist with Phase B results.
