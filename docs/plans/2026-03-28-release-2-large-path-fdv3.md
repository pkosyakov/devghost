# Release 2 — Large-Path FD v3 Metadata-Only Estimator

## Context

Release 1 handles the small / normal diff-based path.

This task is the next production step:

- keep `3-49` file commits on the diff-based path
- replace the current large-commit `FD v2` flow for `50+` file commits
- use the validated `FD v3` metadata-only estimator with `qwen/qwen3-coder-plus`

Research outcome that motivates this task:

- current large-path `FD v2` architecture overestimates badly because it combines:
  - per-cluster LLM estimation
  - separate holistic estimate
  - heuristic totals added on top
- the validated `FD v3` experiment showed:
  - metadata-only works for large commits
  - `Qwen3 Coder+` is the best pilot/production choice
  - one holistic call is materially better than the current multi-branch `FD v2` flow


## Goal

Implement a production large-commit path that:

- activates for `fc >= 50`
- builds a rich metadata block from the commit structure
- sends one metadata-only LLM call
- returns one final estimate directly
- uses `qwen/qwen3-coder-plus` for that path


## Scope

### In scope

- productionizing the validated `FD v3` metadata-only approach for `50+` file commits
- adding a safe rollout flag for `FD v3`
- reusing existing preprocessing/classification/clustering logic as metadata sources
- using a separate large-path model via env / Modal-secret configuration
- adding tests for routing and metadata-only estimation behavior

### Out of scope

- changes to the small / normal commit path
- admin UI for large-path model selection
- Prisma / DB schema migration
- Phase 2 calibration work (judge call, few-shot, learned corrections)
- broad prompt tuning for small commits
- replacing local/benchmark UI behavior outside what is needed for this large-path change


## Expected Outcome

After this PR:

- commits with `fc >= 50` can be routed to `FD v3` via a feature flag
- the large path should no longer run the old `FD v2` branch/holistic/combine logic
- the production large path should use one metadata-only call and return one estimate
- the large-path model should be configurable separately from the default small-path model


## References

Read these before implementing:

- `docs/production-estimator-rollout-plan.md`
- `docs/fd-v3-holistic-estimation-design.md`
- `docs/research-holistic-estimation.md`
- `packages/server/scripts/pipeline/experiment_v3.py`

Primary source files:

- `packages/server/scripts/pipeline/file_decomposition.py`
- `packages/server/scripts/pipeline/run_v16_pipeline.py`
- `packages/modal/worker.py`


## Problem Statement

The current production large path is still `FD v2`.

Today it does roughly this:

1. classify/filter files
2. build clusters
3. estimate Branch A or Branch B
4. run a separate holistic estimate
5. combine branch + holistic + `heuristic_total`

That is precisely the architecture the research invalidated.

The desired production behavior is instead:

1. classify/filter files
2. build clusters only for metadata structure
3. compute the richer `FD v3` metadata block
4. run exactly one metadata-only estimate call
5. return that estimate directly


## Rollout Requirement

This task must ship behind a feature flag.

Add a production flag such as:

- `FD_V3_ENABLED=true|false`

Behavior:

- `false` → keep current `FD v2` behavior unchanged
- `true` + `fc >= 50` → use `FD v3`

This is required for:

- safer staging verification
- easy rollback
- apples-to-apples replay during rollout


## Model Requirement

Short-term large-path model configuration should stay env-driven.

Do **not** add new DB fields or admin settings in this task.

Use existing separate-large-model wiring where possible:

- `FD_LARGE_LLM_PROVIDER`
- `FD_LARGE_LLM_MODEL`

Target production config for this path:

- provider: `openrouter`
- model: `qwen/qwen3-coder-plus`

If the current helper names are too `FD v2`-specific, you may keep them for this rollout as long as behavior is correct and documented in the PR.


## Implementation Requirements

### 1. Add a dedicated production `FD v3` path

In `file_decomposition.py`, create a new orchestration path for large commits that:

- reuses the existing filtering / clustering foundation
- does not reuse `estimate_branch_b()`
- does not reuse `combine_estimates()`
- does not add `heuristic_total` on top after the call

The new path should be the production implementation of the validated experiment, not a partial tweak on `FD v2`.

### 2. Reuse preprocessing, not the old estimation logic

Allowed to reuse:

- file classification
- adaptive filter
- cluster building
- move/bulk/scaffold detectors
- metadata extraction helpers already present or easy to share

Do not preserve these as part of the new final estimate flow:

- Branch B per-cluster estimation
- old holistic estimate prompt
- `combine_estimates()`
- `heuristic_total` post-addition

### 3. Port the `FD v3` metadata block into production code

The production large-path prompt should include the same core signals validated in the experiment:

- raw volume: files / add / delete
- effective churn after filtering
- file type / tier breakdown
- new file ratio
- entropy
- file size distribution
- module breadth
- structural flags / pattern flags
- cluster summary as metadata only
- heuristic/trivial work reported as metadata, not summed afterward

It is acceptable to factor shared logic out of `experiment_v3.py` into reusable helpers if that reduces duplication cleanly.

### 4. Add a production `estimate_holistic_v3`-style call

Implement a dedicated production estimator function for this large path.

Requirements:

- one metadata-only call
- structured output
- stable fallback behavior
- clear method name in result payload (for diagnostics and replay)

Do not send the full diff to the model in this path.

### 5. Use the separate large-path model

The large production path must not accidentally reuse the small-path model by default.

Requirement:

- the `FD v3` path should use the configured large model (`FD_LARGE_LLM_MODEL`) when present
- if separate large-model config is missing, fail gracefully or use an explicitly documented fallback

Be explicit in code and docs about which model is used by:

- small/default path
- large `FD v3` path

### 6. Integrate with `run_v16_pipeline.py` routing

Production routing should become:

- `fc < 50` → existing diff-based path
- `fc >= 50` and `FD_V3_ENABLED=false` → current `FD v2`
- `fc >= 50` and `FD_V3_ENABLED=true` → new `FD v3`

Keep the routing obvious and easy to audit.

### 7. Preserve diagnostics

The result payload for `FD v3` should expose enough structured metadata for debugging/review:

- method / routed_to
- raw estimate / final estimate if distinct
- key metadata summary
- LLM call usage

This does not need a perfect schema redesign, but the new path must not become opaque.


## File-Level Responsibility

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/server/scripts/pipeline/file_decomposition.py` | Add `FD v3` production orchestration and metadata-only estimator |
| Modify | `packages/server/scripts/pipeline/run_v16_pipeline.py` | Add/propagate the `FD_V3_ENABLED` gate and large-path routing behavior |
| Modify | `packages/modal/worker.py` | Ensure new large-path env flags/model config are available in Modal |
| Create or Modify | tests near pipeline scripts | Verify routing and `FD v3` behavior |


## Testing Requirements

### Required automated coverage

At minimum, cover:

1. routing
   - `fc < 50` does not use `FD v3`
   - `fc >= 50` + flag off keeps old `FD v2`
   - `fc >= 50` + flag on uses `FD v3`

2. metadata-only estimator
   - prompt/input is metadata-based
   - no full diff is sent into the `FD v3` estimation call
   - `heuristic_total` is reported as metadata, not added after the estimate

3. large-model selection
   - `FD v3` uses separate large-model config when provided
   - behavior when large-model config is absent is explicit and tested

### Required validation run

Before marking the task done, run a replay on the 10 large GT commits and report:

- overall MAPE
- in-range count
- obvious worst cases
- comparison vs current `FD v2`

This is part of acceptance, not optional.


## Acceptance Criteria

The task is done only if all are true:

1. `FD_V3_ENABLED` gates the new production large path cleanly.
2. `fc >= 50` can use a one-call metadata-only estimator in production.
3. The new path no longer uses Branch B + holistic + combine as its final estimation flow.
4. `heuristic_total` is not added after the `FD v3` estimate.
5. The large path uses the separate large model configuration.
6. Replay on the 10 large GT commits shows the new path materially outperforming current `FD v2`.
7. Small / normal commit behavior is unchanged by this task.


## Non-Functional Constraints

- Keep this PR focused on large-path replacement.
- Do not fold small-path tuning into this work.
- Do not add a DB migration.
- Prefer clean extraction/reuse from `experiment_v3.py` over copy-pasting a second giant prompt block if possible.
- Keep rollback simple: the feature flag must be sufficient to disable `FD v3`.


## Deliverables

The PR should include:

1. production `FD v3` implementation behind a flag
2. tests
3. replay results on the 10 large GT commits
4. a short PR note describing:
   - chosen env flags
   - chosen large-model wiring
   - replay delta vs current `FD v2`


## Reviewer Focus

The follow-up review will focus on:

- whether the new path is truly metadata-only
- whether any hidden `FD v2` combine logic still survives in the final estimate
- whether the large model is actually separated from the small-path model
- whether the feature flag gives a clean rollback
- whether small-path behavior stayed untouched
- whether the replay evidence supports the change


## Branch / PR Guidance

Suggested branch:

- `codex/release2-fdv3-large-path`

Suggested PR title:

- `feat(estimator): add FD v3 metadata-only path for large commits`
