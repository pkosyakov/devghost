# Small-Commit Optimization Plan for Qwen3 Next

## Goal

Stabilize the production estimator before customer demos under the decided model split:

- small / normal commits: `qwen/qwen3-coder-next`
- large / true overflow commits: `qwen/qwen3-coder-plus`

The question for this follow-up was not "which model is best?" but:

> What is the smallest safe production change that materially improves quality on small/normal commits with `Qwen3 Next`?


## Inputs

- Revised 20-case GT: `docs/revised-small-commit-ground-truth.json`
- Exact production replay baseline: `packages/server/scripts/pipeline/experiment_v3_results/production_pipeline_replay_2026-03-27_220924.json`
- New optimization experiment: `packages/server/scripts/pipeline/experiment_small_commit_optimization.py`
- New optimization results:
  - `packages/server/scripts/pipeline/experiment_v3_results/small_commit_optimization_2026-03-28_001553.json`
  - `packages/server/scripts/pipeline/experiment_v3_results/small_commit_optimization_2026-03-28_001553.md`


## Audit of the Current Pipeline

### 1. The main production problem is routing, not the base model

The current Python pipeline computes `FD_THRESHOLD` from `MODEL_CONTEXT_LENGTH`.

- In `run_v16_pipeline.py`, the default is `32768`
- In `pipeline-bridge.ts`, normal production runs also fall back to `32768` if `contextLength` is not passed
- In the benchmark route, actual model context is fetched and passed through correctly
- In the normal analysis route, `processAnalysisJob()` is launched without `contextLength`

This creates a false threshold:

- current default: `32768 ctx -> ~59392 char FD threshold`
- actual `Qwen3 Next`: `262144 ctx -> 500000 char FD threshold` after pipeline cap

Result: medium-overflow commits that still fit `Qwen3 Next` are prematurely routed into legacy FD.

### 2. Legacy FD is the real failure surface on this 20-case set

With `Qwen3 Next` on the exact current replay:

- overall: `44.8% MAPE`, `12/20` in-range
- current non-FD cases: `25.3% MAPE`, `12/15` in-range
- current overflow/FD cases: `103.1% MAPE`, `0/5` in-range

The five failing overflow commits were all in a medium zone:

- `37ce974c`: `92013` diff chars
- `82e02c56`: `84170`
- `a84b7843`: `82133`
- `680dcb92`: `71134`
- `a579d648`: `119296`

These are not "true large commits" for `Qwen3 Next`. They were just above the old `59k` threshold.

### 3. Swapping only the FD model is not enough

I tested a stitched variant:

- keep current non-FD `Qwen3 Next`
- replace only current overflow cases with existing `Qwen3 Coder+` FD outputs

Result:

- `39.2% MAPE`, `13/20` in-range
- overflow subgroup still `80.7% MAPE`

That means the bottleneck is not only the FD model. The legacy FD method itself is weak for these medium-overflow commits.

### 4. Post-rules are a secondary issue

On the new live `Qwen3 Next` replay with actual context, only two post-processing changes fired:

- `complexity_floor` on `57251337`: `4.5h -> 5.0h`
- `rule7_net_deletion` on `a579d648`: `2.5h -> 1.25h`

Both changes hurt accuracy on this dataset.

This is worth cleaning up, but it is not the main cause of the bad baseline.

### 5. The current 2-pass path is not the first thing to replace

After fixing routing by using the real context length, the same pipeline becomes much stronger:

- `Actual-context exact replay`: `27.7% MAPE`, `15/20` in-range
- `Actual-context raw`: `25.8% MAPE`, `15/20` in-range

That is already a large improvement over the current exact replay without changing the prompt regime.


## Variant Results

| Variant | Overall MAPE | In-range | Overflow subgroup |
|--------|-------------:|---------:|------------------:|
| Current exact replay | `44.8%` | `12/20` | `103.1%` |
| Current non-FD + FD on Coder+ | `39.2%` | `13/20` | `80.7%` |
| Current non-FD + overflow single-call | `23.9%` | `16/20` | `19.8%` |
| Actual-context exact replay | `27.7%` | `15/20` | `30.5%` |
| Actual-context raw | `25.8%` | `15/20` | `25.3%` |
| Single-call all commits | `27.1%` | `15/20` | `19.8%` |


## What This Means

### Strong conclusion

The first production fix should be:

1. `Qwen3 Next` for small/normal diff-based commits
2. real model context propagation into the normal production path

This alone removes the false routing into legacy FD and collapses the main quality gap on the 20-case validation set.

### Secondary conclusion

The next best lever is not "improve legacy FD".

If more quality is needed after context-aware routing, the best next move is:

- either disable/scope down harmful post-rules for the `Qwen3 Next` diff path
- or introduce a calibrated single-call fallback for medium-overflow commits

### Explicit non-goals

Do not spend time on these first:

- trying to rescue `qwen3-coder:30b`
- retuning the legacy FD v2 method for medium-overflow cases
- replacing the entire small pipeline with a brand new design before demos


## Recommended Research Plan

### Phase 0. Lock the target model split

Objective:

- make the intended production split explicit in config and docs

Decision:

- small / normal path: `qwen/qwen3-coder-next`
- large / holistic path: `qwen/qwen3-coder-plus`

This is configuration hygiene, not a quality experiment.

### Phase 1. Context-aware routing in normal production analysis

Objective:

- make normal analysis use the same context-aware behavior that benchmark already uses

Code areas:

- `packages/server/src/lib/services/pipeline-bridge.ts`
- `packages/server/src/lib/services/analysis-worker.ts`
- `packages/server/src/app/api/orders/[id]/analyze/route.ts`
- reuse the existing model metadata logic already present in `packages/server/src/app/api/orders/[id]/benchmark/route.ts`

Hypothesis:

- the current bad small-commit baseline is mostly caused by false routing into legacy FD

Validation target:

- reproduce something close to the live result from the optimization experiment:
  - overall `<= 30% MAPE`
  - `0` FD-routed commits on this 20-case set
  - `>= 15/20` in-range

Why this is first:

- it is the highest-leverage and lowest-risk change
- it preserves the current production architecture
- it is already validated by a real live replay, not just by stitched historical data

### Phase 2. Rule cleanup for the new `Qwen3 Next` path

Objective:

- remove or scope down post-processing rules that now hurt more than they help

First candidates:

- `complexity_floor`
- `rule7_net_deletion`

Hypothesis:

- with `Qwen3 Next` and proper routing, the model is calibrated enough that these two rules now degrade accuracy on some commits

Validation target:

- improve from `27.7%` toward `25-26% MAPE`
- do not reduce in-range count
- do not increase bias materially

Scope:

- keep this experiment narrow
- do not rewrite the whole rule engine

### Phase 3. Targeted single-call fallback for medium-overflow commits

Objective:

- keep legacy FD out of the zone where the full diff still fits the real `Qwen3 Next` context

Candidate logic:

- if the diff fits the real `Qwen3 Next` context, do not use legacy FD
- if the normal 2-pass path still shows instability or unnecessary latency in that zone, use calibrated single-call diff estimation instead

Why this is only Phase 3:

- on this 20-case set, proper context propagation already removes all false FD routing
- so single-call overflow fallback is now an optimization path, not the first required fix

Still, it remains a strong backup option:

- stitched result on current overflow subgroup: `19.8% MAPE`, `4/5` in-range

### Phase 4. Optional simplification: compare 2-pass vs single-call on all small commits

Objective:

- test whether `Qwen3 Next` can replace the current 2-pass cascading logic with a simpler single-call path

Why optional:

- after context-aware routing, current 2-pass quality is already demo-viable
- this is more about simplification and latency than about rescuing a broken system

Question to answer:

- does a live single-call variant preserve quality while reducing latency and failure surface?


## Exact Research Matrix

| Variant | Purpose | Expected outcome | Ship bar |
|--------|---------|------------------|----------|
| `V0` Current exact replay with target split | Control baseline | Confirms current pain after model switch | Baseline only |
| `V1` Actual-context normal pipeline | Fix false FD routing | Largest safe gain | `<= 30% MAPE`, `>= 15/20`, `0` FD on this set |
| `V2` Actual-context + rule cleanup | Remove regressions from post-rules | Small additional gain | Better than `V1`, no hit to in-range |
| `V3` Actual-context + targeted single-call fallback | Backup if medium-overflow still unstable | Better overflow handling or lower latency | Better than `V1` on overflow without hurting small/medium |
| `V4` Single-call all commits | Optional simplification | Similar quality, fewer calls | Near-parity with `V1`, lower operational cost |


## Recommended Production Order

1. Switch the production small path to `qwen/qwen3-coder-next` and the large path to `qwen/qwen3-coder-plus`.
2. Implement context-aware routing for normal analysis so `MODEL_CONTEXT_LENGTH` reflects the real active model.
3. Re-run the 20-case validation immediately after that patch.
4. If needed, disable or scope down `complexity_floor` and `rule7_net_deletion` for the `Qwen3 Next` diff path.
5. Only then evaluate whether a targeted single-call fallback is worth the added branching.


## Recommendation for Demo Readiness

If only one production change can be made before demos, it should be:

> propagate actual model context length into the normal production pipeline for `Qwen3 Next`

That is the best tradeoff between quality gain, implementation risk, and time.

On the validated 20-case set it moves the system from:

- `44.8% MAPE`, `12/20` in-range

to:

- `27.7% MAPE`, `15/20` in-range

without changing the whole estimator architecture.
