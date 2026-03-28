# Production Estimator Rollout Plan

## Goal

Update production estimation to the target architecture:

- **3-49 files**: diff-based estimation with `qwen/qwen3-coder-next`
- **50+ files**: metadata-only holistic estimation (`FD v3`) with `qwen/qwen3-coder-plus`

The rollout must improve demo quality quickly while keeping rollback simple.


## Current Status

As of `2026-03-28`, the rollout is no longer hypothetical.

### Already implemented / validated

- `Release 1` small-path routing fix has been specified, implemented, and reviewed.
- `Release 2` large-path `FD v3` replacement has been specified, implemented, and reviewed.
- The validated target model split is now explicit:
  - `3-49 files`: `qwen/qwen3-coder-next`
  - `50+ files`: `qwen/qwen3-coder-plus`

### What is still not aligned

- fresh/default config still points to the old provider/model direction in parts of the app
- admin settings UX still implies a mostly single-model system
- production rollout still needs a clean final sequence: config alignment, staging validation, production cutover, and post-release cleanup

### Decision rule for next work

From this point on, the correct next task is chosen by rollout dependency order, not by ad hoc exploration.

That means:

1. first finish operational/config alignment
2. then validate on staging / real runs
3. then cut over production defaults
4. only after that do calibration cleanup


## Target Production State

### Small / normal commits

- Model: `qwen/qwen3-coder-next`
- Path: current diff-based pipeline
- Required fix: pass real model context into the normal production path so medium commits do not fall into legacy FD prematurely
- Optional cleanup after that: disable or scope down harmful post-rules if validation confirms the gain

### Large commits

- Model: `qwen/qwen3-coder-plus`
- Path: replace current `FD v2` large-commit flow with `FD v3` metadata-only holistic estimation
- Threshold: `fc >= 50`

### Explicit non-goals for this rollout

- Do not keep `qwen3-coder:30b` in production small-path estimation
- Do not spend more time tuning legacy `FD v2` for medium-overflow commits
- Do not introduce hard caps for small commits as a substitute for calibration


## What Is Already Proven

### Small-path finding

From the live optimization replay on revised GT:

- current exact production replay with `Qwen3 Next`: `44.8% MAPE`, `12/20` in-range
- same pipeline with real model context: `27.7% MAPE`, `15/20` in-range

So the first small-path production fix is clear:

> propagate the real model context length into normal analysis

### Large-path finding

From the holistic experiment:

- `FD v3` metadata-only with `Qwen3 Coder+` is already good enough for pilot/production on `50+` file commits
- it is materially better than the current large-commit `FD v2` architecture


## Rollout Strategy

Use two parallel workstreams:

1. **Small-path stabilization**
2. **Large-path replacement**

Do not couple them into one giant refactor. They solve different problems and should have separate validation gates.


## Workstream A — Small-Path Stabilization

### A1. Implement context-aware routing in normal production analysis

Objective:

- make normal analysis use the real context window of the active model, not the `32768` fallback

Current gap:

- benchmark already resolves and passes model context
- normal analysis does not

Code areas to change:

- `packages/server/src/lib/services/pipeline-bridge.ts`
- `packages/server/src/app/api/orders/[id]/analyze/route.ts`
- `packages/server/src/app/api/orders/[id]/update-analysis/route.ts`
- `packages/server/src/app/api/admin/orders/[id]/rerun/route.ts`
- `packages/modal/worker.py`

Implementation shape:

1. Add a shared helper that resolves model context length for the active provider/model.
2. For OpenRouter, fetch `context_length` from the model catalog.
3. For Ollama, fetch context length from `/api/show`.
4. Persist the resolved `contextLength` / `effectiveContextLength` in benchmark and analysis snapshots.
5. Pass `contextLength` into `processAnalysisJob()` for normal local runs.
6. For Modal runs, load `effectiveContextLength` from `llmConfigSnapshot` and set `MODEL_CONTEXT_LENGTH` before Python pipeline execution.

Validation gate:

- re-run the 20 revised-GT commits with the real production path
- target: overall `<= 30% MAPE`, `>= 15/20` in-range, `0` false FD routes on this set

### A2. Revalidate post-rules on `Qwen3 Next`

Objective:

- check whether `complexity_floor` and `rule7_net_deletion` still help once routing is fixed

Code area:

- `packages/server/scripts/pipeline/run_v16_pipeline.py`

Implementation shape:

1. Add a narrow experiment variant with these rules disabled or scoped for the `Qwen3 Next` diff path.
2. Compare against the actual-context replay baseline.
3. Only ship if improvement is stable and does not reduce in-range count.

Validation gate:

- improve from `27.7%` toward `25-26% MAPE`
- no worsening on the `3-7` and `8-15` file buckets

### A3. Optional simplification: compare live 2-pass vs single-call

Objective:

- decide whether the current small diff path should stay 2-pass or move to a simpler single-call design

Why optional:

- it is not required for the first production rescue
- routing fix alone already moves the system into a demo-viable range

Ship only if:

- quality is near-parity with the actual-context 2-pass path
- latency and failure surface are clearly better


## Workstream B — Large-Path Replacement

### B1. Implement `FD v3` metadata-only production path

Objective:

- replace the large-commit `FD v2` branch with the validated `FD v3` holistic estimator

Code areas:

- `packages/server/scripts/pipeline/file_decomposition.py`
- `packages/server/scripts/pipeline/run_v16_pipeline.py`
- reuse logic from `packages/server/scripts/pipeline/experiment_v3.py`

Implementation shape:

1. Keep the current file classification / metadata extraction foundation.
2. For `fc >= 50`, do not run the old cluster-based `FD v2` estimate path.
3. Build the richer metadata block from the `FD v3` experiment:
   - effective churn
   - entropy
   - file size distribution
   - module breadth
   - structural flags
   - cluster summary as metadata only
4. Send one metadata-only LLM call.
5. Use `qwen/qwen3-coder-plus` as the production model for this path.
6. Return one final estimate directly, without recombining legacy branch outputs.

Validation gate:

- replay the 10 large GT commits
- target: `<= 40% MAPE`
- no obvious 2-10x overestimation cases

### B2. Remove dependency on legacy FD tuning for large commits

Objective:

- make the large path operationally simple

After `FD v3` ships:

- stop treating `FD_LARGE_LLM_MODEL` tuning as the main lever for large quality
- treat the new large path as its own estimator, not as a patch on top of `FD v2`


## Workstream C — Configuration and Admin Defaults

### C1. Change system defaults to the new production direction

Current defaults are still old:

- provider defaults to `ollama`
- OpenRouter default model is still `qwen/qwen-2.5-coder-32b-instruct`

Code areas:

- `packages/server/prisma/schema.prisma`
- `packages/server/prisma/seed.ts`
- `packages/server/src/lib/llm-config.ts`
- `packages/server/src/app/api/admin/llm-settings/route.ts`
- `packages/server/src/app/[locale]/(dashboard)/admin/settings/page.tsx`

Target defaults:

- provider: `openrouter`
- small/default model: `qwen/qwen3-coder-next`

Important note:

- this updates defaults and admin UX, but the live production value still comes from `SystemSettings`

### C2. Decide how to store large-path model choice

Two options:

1. **Short-term**: keep the large-path model in env / Modal secret only
2. **Long-term**: extend `SystemSettings` with explicit large-path model fields

Recommendation:

- for the first rollout, keep the large-path model configuration in env / Modal secret
- avoid a schema migration unless you also want an admin UI for the large model right now


## Workstream D — Validation and Release Gates

### D1. Pre-merge validation

Before merging to main:

1. Re-run small 20-case validation with the true production path.
2. Re-run large 10-case validation with the implemented `FD v3` path.
3. Manually benchmark 3-5 known commits through the UI benchmark route.
4. Confirm the expected model is shown in job progress / diagnostics.

### D2. Staging validation

On staging:

1. Run one small-order analysis with recent real commits.
2. Run one order known to contain a `50+` file commit.
3. Confirm:
   - jobs start and finish in `PIPELINE_MODE=modal`
   - progress route is healthy
   - `llmConfigSnapshot` is saved
   - model/provider values are correct
   - no `5.0h` fallback artifacts on routine commits

### D3. Production acceptance gates

Ship only if all are true:

- small-path replay meets the `<= 30% MAPE` gate
- large-path replay meets the `<= 40% MAPE` gate
- no blocking regressions in benchmark UI, analyze route, admin rerun, or watchdog
- Modal job launch and retry flow still work


## Release Sequence

### Release 1 — Small-path rescue

Scope:

- switch small/default model to `Qwen3 Next`
- ship context-aware routing in normal production analysis

Do not include yet:

- `FD v3`
- rule cleanup
- single-call simplification

Why:

- fastest safe quality gain before demos

### Release 2 — Large-path replacement

Scope:

- ship `FD v3` for `50+` file commits
- set the large model to `Qwen3 Coder+`

Why separate:

- easier rollback
- cleaner attribution if something regresses

### Release 3 — Config / Admin Alignment

Scope:

- align fresh defaults with the new split-model production direction
- expose read-only `FD v3` / large-model status in admin settings
- make admin UX reflect:
  - editable small/default model
  - read-only large `50+` file model

Why this is next:

- estimator core is already changed
- config/admin layer is now the main source of operational confusion
- this is the lowest-risk step before staging and production cutover

### Release 4 — Cleanup / optimization

Scope:

- post-rule cleanup for `Qwen3 Next`
- optional single-call simplification
- admin UX cleanup and defaults

Why this is later:

- it is optimization, not rollout-blocking architecture work
- after `Release 1` and `Release 2`, the system is already close to demo-ready
- config correctness and deployment validation matter more than squeezing another few MAPE points immediately


## Operational Steps for Production

### Before deploy

1. Confirm OpenRouter key is present in production env / Modal secret.
2. Confirm `PIPELINE_MODE=modal` and `MODAL_ENDPOINT_URL` are healthy.
3. Confirm the worker deployment is current.
4. Confirm admin settings page can see the target OpenRouter models.

### During deploy

1. Deploy server code.
2. If `FD v3` changes touch the Python worker path, deploy Modal worker/app too.
3. Update production `SystemSettings` to:
   - provider: `openrouter`
   - model: `qwen/qwen3-coder-next`
4. If the large path still depends on env-configured large model, update Modal secret / env to:
   - large model: `qwen/qwen3-coder-plus`

### Immediately after deploy

1. Run one manual benchmark for a small commit.
2. Run one manual benchmark for a large commit.
3. Launch one real analysis job.
4. Check:
   - job status progression
   - progress page
   - analysis job snapshot
   - no pipeline crash in Modal logs


## Monitoring Checklist

For the first 24-48 hours after release, monitor:

- rate of `estimated_hours = 5.0`
- proportion of commits routed into FD / large path
- model/provider shown in analysis jobs
- watchdog retries and failed jobs
- latency spikes
- obvious customer-facing overestimation on `50+` file commits

Add or verify diagnostics for:

- `effectiveContextLength`
- `diff_chars`
- `method`
- `routed_to`
- `rule_applied`
- `complexity_guard`


## Rollback Plan

### If small path regresses

Rollback order:

1. revert context-aware routing patch
2. keep `Qwen3 Next` as the model if it is not the source of failure
3. if needed, restore previous `SystemSettings` model/provider values

### If large path regresses

Rollback order:

1. disable `FD v3`
2. restore previous large-commit path
3. keep the small-path rollout intact

### If Modal / worker deployment regresses

Rollback order:

1. restore previous Modal worker deployment
2. leave server UI live if read-only features still work
3. disable new analysis starts temporarily if required


## Recommended Execution Order

### Completed foundation

1. **Release 1**: `Qwen3 Next` + context-aware small-path routing
2. **Release 2**: `FD v3` + `Qwen3 Coder+` for `50+` file commits

### Remaining rollout path

3. **Release 3**: config/admin alignment for the split-model system
4. **Pre-staging validation**:
   - rerun small-path replay on the merged production code
   - rerun large-path replay on the merged production code
   - manually benchmark known small and large commits through the UI
5. **Staging validation**:
   - one routine order
   - one order containing a `50+` file commit
   - verify Modal/job/progress/snapshot behavior
6. **Production cutover**:
   - set `SystemSettings` small/default path to `openrouter + qwen/qwen3-coder-next`
   - set env / Modal secret large path to `qwen/qwen3-coder-plus`
   - keep `FD_V3_ENABLED` under controlled rollout
7. **Post-cutover cleanup**:
   - rule cleanup for `complexity_floor` / `rule7_net_deletion`
   - optional single-call simplification only if still justified by data

## What I Should Drive Next

Unless a blocker appears, I should drive the work in this order:

1. review and land `Release 3`
2. prepare the staging validation checklist and exact commands
3. review staging results
4. prepare the production cutover checklist
5. only then open the next calibration task

So the default answer to "what next?" is no longer open-ended:

- **right now:** finish config/admin alignment
- **after that:** staging validation
- **after that:** production cutover
- **after that:** calibration cleanup
