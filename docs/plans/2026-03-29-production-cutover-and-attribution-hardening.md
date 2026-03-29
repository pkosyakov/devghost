# Production Cutover and Benchmark Attribution Hardening

## Context

By now we have enough evidence to stop treating the estimator rollout as an open research problem.

Validated target state:

- `3-49 files`: diff-based estimation with `openrouter + qwen/qwen3-coder-next`
- `50+ files`: `FD v3` metadata-only estimation with `openrouter + qwen/qwen3-coder-plus`

We also now have a real production order that demonstrates the gain:

- order: `cmn561qu00001jv043sg35pd6`
- original analysis total: `8256.65h`
- full-rollout benchmark total: `3837.0h`
- delta: `-53.5%`

On the overlapping large-GT subset, the same benchmark moved from:

- old prod: `469.1% MAPE`, `0/8` in-range
- partial benchmark: `78.8% MAPE`, `1/8` in-range
- full rollout benchmark: `23.9% MAPE`, `5/8` in-range, `8/8 within 2x`

That means the next step is no longer another estimator experiment.

The next step is:

1. harden observability/attribution so benchmark and audit surfaces stay honest
2. switch production to the new pipeline in a controlled way


## Goal

Finish the rollout with two tightly scoped deliverables:

1. **Attribution hardening**
   - ensure `CommitAnalysis.llmModel` honestly reflects which model actually processed each commit, especially on FD routes
2. **Production cutover**
   - switch live production analysis to the validated split-model estimator architecture


## Why These Two Belong Together

The estimator quality problem is mostly solved.

The remaining risk is operational:

- if `llmModel` attribution is sloppy, benchmark/audit UI can claim a commit was processed by `qwen/qwen3-coder-plus` even when the route was heuristic-only or fallback
- if we cut over production without a disciplined runbook, we can still regress on deploy/config even with good model quality

So this plan is not about improving estimates further.
It is about making the rollout **trustworthy and shippable**.


## Scope

### In scope

- harden FD per-commit model attribution end-to-end
- add targeted tests for attribution correctness
- deploy the split-model estimator to production
- update production config to the validated target state
- run post-cutover smoke checks and define rollback criteria

### Out of scope

- new prompt experiments
- new GT datasets
- post-rule cleanup
- single-call simplification
- new admin UX beyond what is already merged


## Workstream A — Attribution Hardening

### Problem Statement

`CommitAnalysis.llmModel` is used in:

- benchmark comparison matrix
- commit-level audit interpretation
- cache/model attribution logic

That field must mean:

> "which model actually processed this commit"

Not:

> "which model was globally configured for some surrounding pipeline path"

The dangerous failure mode is:

- a heuristic-only or fallback FD route gets stamped as `qwen/qwen3-coder-plus`
- benchmark matrix then shows a large-model label even though no large-model call happened

That does **not** change estimated hours.
But it breaks the credibility of benchmark/audit output.


## Target Behavior for `llmModel`

### Non-FD routes

- keep existing behavior:
  - use the job-level active model

### FD routes that truly use the large model

These should set:

- `llmModel = qwen/qwen3-coder-plus`

Examples:

- `FD_v3_holistic`
- `FD_v2_cluster_holistic`
- `FD_v2_cluster`
- `FD_v2_single_holistic`
- `FD_v2_single_call`

### FD routes that do not use an LLM

These must stay:

- `llmModel = null`

Examples:

- `FD_cheap`
- `FD_bulk_scaffold`
- `FD_v3_heuristic_only`
- heuristic early exits / scaffold detectors

### FD fallback/error routes

Rules:

- if a route ended without a real model-backed estimate, keep `llmModel = null`
- do not label a fallback as `qwen/qwen3-coder-plus` just because that model was configured for the FD large path


## Files

### Modify

- `packages/server/scripts/pipeline/run_v16_pipeline.py`
- `packages/server/src/lib/services/analysis-worker.ts`
- `packages/server/src/app/api/orders/[id]/benchmark/compare/__tests__/route.test.ts`
- `packages/server/src/app/api/orders/[id]/benchmark/__tests__/route.test.ts`

### Optional if needed

- `packages/server/src/components/benchmark-matrix.tsx`


## Task A1 — Make Python the source of truth for FD commit model attribution

### Objective

Ensure the Python pipeline returns an explicit per-commit `model` field that already encodes the real route semantics.

### Requirements

1. Keep a single explicit helper in Python that resolves per-commit model attribution from `method`.
2. The helper must distinguish:
   - true large-model FD routes
   - heuristic-only FD routes
   - non-FD routes
3. Every commit output returned to TypeScript must include the resolved `model`.
4. No TypeScript-side guesswork should be required for FD routes once Python output is correct.

### Acceptance criteria

- `FD_v3_holistic` returns `model = qwen/qwen3-coder-plus`
- `FD_cheap` returns `model = null`
- scaffold/heuristic-only FD routes return `model = null`
- non-FD routes return the normal active model


## Task A2 — Remove or strictly narrow TypeScript fallback inference

### Objective

Make `analysis-worker.ts` trust the pipeline result instead of fabricating FD model attribution from env.

### Requirements

In `mapToCommitAnalysis()`:

- do not blanket-assign `FD_LARGE_LLM_MODEL` to every `FD*` method
- prefer `result.model` from Python
- if `result.model` is absent on an FD route, treat that as `null`, not as implicit proof of a large-model call

### Reason

The benchmark/audit surface must be conservative:

- false negative model attribution is acceptable for a short time
- false positive attribution is not


## Task A3 — Add attribution regression tests

### Tests required

1. `FD_v3_holistic` stores large model name
2. `FD_cheap` stores `null`
3. heuristic/scaffold FD route stores `null`
4. non-FD `cascading_*` route stores the small/default model
5. compare API still surfaces per-commit `models[...]` correctly for benchmark matrix

### Acceptance criteria

- benchmark matrix can no longer mislead a reviewer into thinking a heuristic-only FD commit was processed by `qwen/qwen3-coder-plus`


## Workstream B — Production Cutover

### Decision

Switch production to the new pipeline.

Do not wait for another research cycle.

### Target production state

- `SystemSettings.llmProvider = openrouter`
- `SystemSettings.openrouterModel = qwen/qwen3-coder-next`
- `FD_V3_ENABLED = true`
- `FD_LARGE_LLM_PROVIDER = openrouter`
- `FD_LARGE_LLM_MODEL = qwen/qwen3-coder-plus`


## Files / Systems Involved

### Server / config

- `packages/server/src/lib/llm-config.ts`
- `packages/server/src/app/api/admin/llm-settings/route.ts`
- production `SystemSettings` row

### Python / Modal

- `packages/modal/worker.py`
- `packages/server/scripts/pipeline/run_v16_pipeline.py`
- Modal secret / env

### Operational docs to use as references

- `docs/production-estimator-rollout-plan.md`
- `docs/plans/2026-03-28-staging-validation-checklist.md`


## Task B1 — Freeze the release candidate

Before touching production:

1. choose the exact release commit
2. verify it includes:
   - small-path context-aware routing
   - `FD v3`
   - config/admin split-model alignment
   - benchmark full-rollout profile support
   - attribution hardening from Workstream A

No production deploy should happen from a moving branch head.


## Task B2 — Deploy server and worker

### Server deploy

Deploy the server release first.

Confirm:

- app boots
- admin settings page loads
- orders page loads
- benchmark pages still render

### Modal deploy

Deploy the matching worker release.

Confirm:

- worker starts without import/runtime errors
- pipeline startup logs show the expected configuration


## Task B3 — Apply production config

### SystemSettings

Set:

- `llmProvider = openrouter`
- `openrouterModel = qwen/qwen3-coder-next`

### Production env / Modal secret

Set:

- `FD_V3_ENABLED=true`
- `FD_LARGE_LLM_PROVIDER=openrouter`
- `FD_LARGE_LLM_MODEL=qwen/qwen3-coder-plus`

### Important

This cutover is not complete until **both** config layers match:

- small/default model in DB
- large-path model in env/Modal secret


## Task B4 — Immediate post-cutover smoke checks

Run these immediately after deploy.

### Check 1 — Admin config sanity

Confirm admin/settings shows:

- editable default model = `qwen/qwen3-coder-next`
- large-path read-only section = `FD v3`, `openrouter`, `qwen/qwen3-coder-plus`

### Check 2 — Real benchmark sanity

Launch one benchmark on a completed order.

Confirm the new job snapshot contains:

- `benchmarkProfile = target_rollout`
- `fdV3Enabled = true`
- `fdLargeProvider = openrouter`
- `fdLargeModel = qwen/qwen3-coder-plus`

### Check 3 — Real small/routine analysis

Launch one routine order.

Confirm:

- no false FD over-routing
- no obvious `5.0h` fallback artifact
- provider/model in diagnostics look correct

### Check 4 — Real large-commit analysis

Launch or inspect one order with a `50+` file commit.

Confirm:

- route uses `FD_v3_*`
- no regression into the old extreme FD-v2 overestimation regime


## Task B5 — First 24h monitoring

Track:

- rate of `estimated_hours = 5.0`
- proportion of commits using `FD_v3_holistic`
- proportion of commits using legacy `FD*`
- obviously inflated `50+` file commits
- failed or retried Modal jobs

Capture for at least one small and one large real job:

- `method`
- `routed_to`
- `rule_applied`
- `complexity_guard`
- `effectiveContextLength`
- `llmModel`


## Rollback Conditions

Rollback if any of these occur:

1. routine commits start falling into false FD routing again
2. large commits no longer use `FD_v3`
3. repeated worker failures or stuck jobs appear
4. benchmark/audit surfaces show obviously false per-commit model attribution
5. customer-visible estimates regress back into old FD-v2 behavior


## Rollback Order

### If attribution hardening regresses

1. revert only the attribution patch
2. keep the estimator rollout itself live if estimates remain correct

### If production estimator regresses

1. disable `FD_V3_ENABLED`
2. restore previous large-path behavior
3. if needed, restore previous `SystemSettings` small/default model

### If worker deploy regresses

1. restore previous Modal deployment
2. pause new analyses if necessary
3. keep UI read-only surfaces online


## Acceptance Criteria

This work is done when all are true:

1. heuristic-only FD routes no longer get falsely attributed to `qwen/qwen3-coder-plus`
2. benchmark matrix and audit surfaces display honest per-commit model attribution
3. production small/default model is `qwen/qwen3-coder-next`
4. production large path is `FD v3 + qwen/qwen3-coder-plus`
5. at least one real benchmark and one real production order confirm the new pipeline is live
6. no rollback condition is triggered in the first monitoring window


## Suggested Execution Order

1. land attribution hardening
2. run targeted tests
3. freeze release commit
4. deploy server
5. deploy worker
6. apply production config
7. run immediate smoke checks
8. monitor first 24h


## Suggested Commit Structure

1. `fix(benchmark): harden FD commit model attribution`
2. `chore(prod): cut over estimator to split-model pipeline`
