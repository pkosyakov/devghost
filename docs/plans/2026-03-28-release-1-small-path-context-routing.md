# Release 1 — Small-Path Context-Aware Routing

## Context

We already decided the production model split:

- small / normal commits: `qwen/qwen3-coder-next`
- large / true overflow commits: `qwen/qwen3-coder-plus`

The most important pre-demo production problem on small commits is now isolated:

- the current production path routes some medium commits into legacy FD too early
- this happens because normal analysis still uses the Python fallback context of `32768`
- benchmark mode already resolves real model context and performs much better

Validated result on the revised 20-case GT set:

- current exact replay with `Qwen3 Next`: `44.8% MAPE`, `12/20` in-range
- same pipeline with real context length: `27.7% MAPE`, `15/20` in-range

This task is the **first production fix**. It is intentionally narrower than the full estimator rollout.


## Goal

Make normal production analysis use the real context length of the active model, so the small-path diff-based pipeline stops routing medium commits into legacy FD prematurely.


## Scope

### In scope

- context-length resolution for the active provider/model
- passing resolved context into normal analysis runs
- preserving the resolved context in job snapshots
- making Modal execution respect the saved effective context
- updating tests for affected routes/helpers

### Out of scope

- `FD v3` implementation for large commits
- replacing the small 2-pass pipeline with single-call
- prompt rewriting
- rule tuning (`complexity_floor`, `rule7_net_deletion`)
- admin UI redesign
- schema migration for separate large-path model settings


## Expected Outcome

After this PR:

- normal analysis should behave like benchmark mode with respect to context-aware routing
- `Qwen3 Next` should keep medium commits on the diff-based path when they still fit real context
- job snapshots should preserve enough context information to make local and Modal runs consistent


## References

Read these before implementing:

- `docs/production-estimator-rollout-plan.md`
- `docs/research-small-commit-qwen-next-optimization.md`
- `docs/research-small-commit-estimation-quality.md`

Key source files:

- `packages/server/src/app/api/orders/[id]/benchmark/route.ts`
- `packages/server/src/app/api/orders/[id]/analyze/route.ts`
- `packages/server/src/app/api/orders/[id]/update-analysis/route.ts`
- `packages/server/src/app/api/admin/orders/[id]/rerun/route.ts`
- `packages/server/src/lib/services/analysis-worker.ts`
- `packages/server/src/lib/services/pipeline-bridge.ts`
- `packages/modal/worker.py`
- `packages/server/scripts/pipeline/run_v16_pipeline.py`


## Problem Statement

The benchmark route already does the right thing:

- resolves actual model context for Ollama / OpenRouter
- computes `effectiveContextLength`
- passes it to `processAnalysisJob()`
- stores it in `llmConfigSnapshot`

The normal production analysis path does not do this consistently:

- local analysis starts `processAnalysisJob()` without `contextLength`
- rerun / update-analysis paths also do not propagate it
- Modal worker restores provider/model from snapshot, but does not currently restore effective context from snapshot into `MODEL_CONTEXT_LENGTH`

As a result, the Python pipeline falls back to `32768`, computes a lower `FD_THRESHOLD`, and pushes medium-overflow commits into legacy FD too early.


## Clarifications

### 1. `update-analysis/route.ts` may expand beyond its current minimal shape

Yes, this route is allowed to grow beyond its current one-line `processAnalysisJob()` call.

However, keep the expansion **strictly context-focused**:

- preserve or reconstruct `effectiveContextLength`
- persist context-related snapshot fields if needed for consistency
- pass `contextLength` into `processAnalysisJob()`

It is **not** required in this task to make `update-analysis` fully feature-parity with `analyze/route.ts` in every respect. For example:

- full cache-mode redesign is out of scope
- unrelated billing behavior changes are out of scope
- unrelated route cleanup is out of scope

If you need to touch more than context/snapshot mechanics to make the route correct, keep it minimal and explain why in the PR.

### 2. Shared helper should handle context resolution, not benchmark-specific health UX

The shared helper is meant for:

- resolving raw context length for a provider/model
- computing effective context length with the existing clamp/safety logic

It should **not** absorb benchmark-specific UX concerns such as:

- Ollama model availability checks via `/api/tags`
- OpenRouter strict-json preflight validation

Those checks stay in the benchmark route.

### 3. Modal path carries context through `llmConfigSnapshot`, not direct `processAnalysisJob()` args

Correct:

- in `PIPELINE_MODE=modal`, `analyze/route.ts` does **not** call `processAnalysisJob()` directly
- the context must therefore be persisted into `llmConfigSnapshot`
- Modal worker must read that saved context and restore `MODEL_CONTEXT_LENGTH` before Python execution

By contrast:

- in local mode, `contextLength` must be passed directly into `processAnalysisJob()`


## Implementation Requirements

### 1. Extract shared context-resolution logic

Create a shared helper in server code for:

- resolving raw model context for the active provider/model
- computing clamped / effective context length

The helper should support:

- OpenRouter model catalog lookup (`context_length`)
- Ollama `/api/show` lookup (`*.context_length`)
- safe fallback to `32768`
- the same clamping logic already used in benchmark mode

Do not duplicate the benchmark route logic again.

### 2. Reuse the helper in benchmark route

Refactor the benchmark route to use the shared helper instead of keeping provider-specific logic inline.

Requirement:

- benchmark behavior must stay functionally equivalent after refactor

### 3. Use resolved context in normal analysis route

In `analyze/route.ts`:

- resolve the active model context before launching analysis
- compute `effectiveContextLength`
- include it in the saved `llmConfigSnapshot`
- pass it to `processAnalysisJob()`

This must work for both:

- `PIPELINE_MODE=local`
- `PIPELINE_MODE=modal`

Important:

- local mode needs the value passed directly into `processAnalysisJob()`
- modal mode needs the value persisted into `llmConfigSnapshot`

### 4. Preserve context across rerun/update flows

Apply the same context behavior to:

- `update-analysis/route.ts`
- `admin/orders/[id]/rerun/route.ts`

Requirement:

- a rerun should not silently fall back to `32768` if the original job had a real effective context

If you need to choose between recomputing context from current config vs reusing snapshot context, prefer:

- snapshot context for rerun consistency
- recompute only when no usable snapshot context exists

### 5. Make Modal worker restore effective context

In `packages/modal/worker.py`:

- read `effectiveContextLength` from `llmConfigSnapshot` if present
- set `MODEL_CONTEXT_LENGTH` before calling the Python pipeline

Requirement:

- Modal warm-container behavior must remain correct
- do not rely on implicit defaults when explicit snapshot context exists

### 6. Keep snapshot semantics explicit

For analysis jobs, `llmConfigSnapshot` should contain:

- provider/model config
- redacted API key
- raw `contextLength`
- `effectiveContextLength` actually used by the pipeline

This is needed for:

- auditability
- reproducibility
- future benchmark/diagnostics consistency


## File-Level Responsibility

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/server/src/lib/services/model-context.ts` | Shared model-context resolution + effective-context computation |
| Modify | `packages/server/src/app/api/orders/[id]/benchmark/route.ts` | Reuse shared helper, keep benchmark behavior stable |
| Modify | `packages/server/src/app/api/orders/[id]/analyze/route.ts` | Resolve and persist effective context for normal analyses |
| Modify | `packages/server/src/app/api/orders/[id]/update-analysis/route.ts` | Preserve or resolve context on incremental reruns |
| Modify | `packages/server/src/app/api/admin/orders/[id]/rerun/route.ts` | Preserve or resolve context on admin reruns |
| Modify | `packages/server/src/lib/services/analysis-worker.ts` | Ensure context is consistently threaded into pipeline calls |
| Modify | `packages/modal/worker.py` | Restore effective context from snapshot into env |
| Modify | tests near affected routes/helpers | Verify local + modal behavior |


## Testing Requirements

### Required automated tests

At minimum, cover:

1. shared model-context helper
   - OpenRouter context resolution success
   - Ollama context resolution success
   - fallback behavior
   - effective context clamping

2. `analyze/route.ts`
   - local mode passes `contextLength` to `processAnalysisJob()`
   - modal mode stores snapshot with `effectiveContextLength`

3. `benchmark/route.ts`
   - existing behavior still passes `effectiveContextLength`
   - no regression in snapshot/fingerprint behavior

4. rerun/update flows
   - preserve or rehydrate effective context instead of silently using default `32768`

### Manual verification

Run at least:

1. route tests for `analyze`
2. any benchmark route tests that exist or add a focused smoke test
3. a local dry verification that `MODEL_CONTEXT_LENGTH` reaches Python when using `Qwen3 Next`

If you add a helper with network fetches, mock them in tests. Do not hit live OpenRouter/Ollama in unit tests.


## Acceptance Criteria

The task is done only if all are true:

1. Normal analysis no longer depends on the `32768` fallback when active model context is resolvable.
2. Benchmark and normal analysis use the same effective-context logic.
3. Modal runs honor `effectiveContextLength` from snapshot.
4. Local runs pass `contextLength` into `processAnalysisJob()`.
5. Tests cover the new helper and the changed route behavior.
6. No regression in benchmark snapshot semantics or existing local/modal flow behavior.


## Non-Functional Constraints

- Keep the implementation narrow. This PR is not for large-path `FD v3`.
- Do not introduce a Prisma migration in this task.
- Do not change estimator prompts in this task.
- Do not change rule-engine behavior in this task.
- Prefer one shared helper over copy-pasting context-resolution code across routes.


## Deliverables

The PR should include:

1. code changes for context-aware routing in normal analysis
2. tests
3. a short validation note in the PR description with:
   - what was tested
   - whether local and modal flows were checked
   - any remaining known gaps


## Reviewer Focus

The follow-up review will focus on:

- whether the implementation accidentally changed benchmark semantics
- whether rerun/update paths still silently lose context
- whether Modal truly restores effective context from snapshot
- whether the helper handles provider fallbacks safely
- whether the PR stayed within scope


## Branch / PR Guidance

Suggested branch:

- `codex/release1-context-routing`

Suggested PR title:

- `fix(estimator): propagate real model context into normal analysis pipeline`
