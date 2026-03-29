# Benchmark Full New Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make order-page benchmarks run through the full target production pipeline, not a partial single-model approximation.

**Business context:** We now have a real production order where this matters: `cmn561qu00001jv043sg35pd6`. Its original analysis was produced by the old pipeline, and a later benchmark run was intended to show the "new system" to the customer. But the completed benchmark job `cmnbfgv330001l404n81fop90` captured only the small-path change:

- small/default model: `openrouter + qwen/qwen3-coder-next`
- effective context: `196608`
- **but** `fdV3Enabled = false`
- **and** `fdLargeModel = null`
- **and** `fdLargeProvider = null`

So the benchmark compared **old prod vs partial rollout**, not **old prod vs full new pipeline**.

That is the core problem this task must fix.


## Target Behavior

When an admin launches a benchmark from the order page, it must execute the **full rollout candidate pipeline**:

- **3-49 files**: diff-based path with `openrouter + qwen/qwen3-coder-next`
- **50+ files**: `FD v3` metadata-only path with `openrouter + qwen/qwen3-coder-plus`

This must be true even if the currently deployed production env still has old FD flags or old large-model settings.

The benchmark must become an explicit answer to:

> "What would this completed order look like under the full new estimator architecture?"

Not:

> "What would happen if I reran this order with one arbitrary model plus whatever FD env happened to be active on the server?"


## Product Decision

For the **order detail page benchmark launcher**, stop treating benchmark as a generic model lab.

This surface is now for **rollout-candidate comparison**.

That means:

- the launcher should no longer ask the operator to pick an arbitrary provider/model
- the launcher should no longer silently inherit FD config from current env
- the benchmark should launch a fixed, explicit target pipeline

If we ever want a generic internal benchmarking lab again, that should be a separate internal/admin surface, not this customer-facing order comparison tool.


## Scope

### In scope

- define an explicit benchmark profile for the full new pipeline
- make benchmark POST resolve and snapshot that profile server-side
- make the benchmark launcher run that profile, not arbitrary provider/model selection
- keep Modal/local execution paths using the benchmark snapshot as the source of truth
- expose profile identity in benchmark compare API / matrix UI
- preserve backward compatibility for older benchmark runs that do not have profile metadata

### Out of scope

- changing live production analysis defaults
- changing the actual production order analysis path
- building a generic split-model benchmark editor
- redesigning benchmark matrix metrics
- Prisma / DB schema migration


## Dependencies

This plan assumes the following work is already merged or available in the target branch:

- benchmark split-model snapshot / compare support
- benchmark Modal dispatch support
- snapshot-driven FD env propagation in `setup_llm_env()`

If any of that is still missing, finish it first. This task is intentionally layered on top of those foundations.


## Current Root Cause

Today the order benchmark request schema and launcher only express:

- `provider`
- `model`
- `contextLength`
- `promptRepeat`

The benchmark route then reads:

- `FD_V3_ENABLED`
- `FD_LARGE_LLM_PROVIDER`
- `FD_LARGE_LLM_MODEL`

directly from the **current server env**.

So the benchmark configuration is split across two worlds:

1. client-selected small model
2. server-env large-path behavior

This is exactly why the production benchmark on `cmn561qu00001jv043sg35pd6` could capture `Qwen3 Next` while still missing `FD v3`.


## Desired Architecture

Introduce an explicit server-side benchmark profile:

- `target_rollout`

This profile resolves to:

- `provider = openrouter`
- `model = qwen/qwen3-coder-next`
- `fdV3Enabled = true`
- `fdLargeProvider = openrouter`
- `fdLargeModel = qwen/qwen3-coder-plus`
- `promptRepeat = false`

The benchmark route must:

1. resolve this profile server-side
2. resolve the small-model context length from model metadata
3. create the full snapshot from the resolved profile
4. fingerprint the **entire** profile
5. run local or Modal execution from that snapshot

The launcher should simply ask to run the rollout candidate benchmark and show the fixed split config read-only.


## Files

### Create

- `packages/server/src/lib/services/benchmark-profile.ts`

### Modify

- `packages/server/src/lib/schemas/order.ts`
- `packages/server/src/components/benchmark-launcher.tsx`
- `packages/server/src/app/api/orders/[id]/benchmark/route.ts`
- `packages/server/src/app/api/orders/[id]/benchmark/compare/route.ts`
- `packages/server/src/components/benchmark-matrix.tsx`
- `packages/server/src/app/api/orders/[id]/benchmark/__tests__/route.test.ts`
- `packages/server/src/app/api/orders/[id]/benchmark/compare/__tests__/route.test.ts`


## Task 1: Add a server-side benchmark profile resolver

Create a dedicated helper so the rollout candidate is defined in one place, not duplicated across route/UI/tests.

### Requirements

- add a `BenchmarkProfileId` type
- for now support exactly one public profile:
  - `target_rollout`
- export a resolver that returns:
  - profile id
  - human label
  - resolved small/default provider/model
  - `fdV3Enabled`
  - `fdLargeProvider`
  - `fdLargeModel`
  - `promptRepeat`

### Implementation notes

- do **not** read `FD_V3_ENABLED` / `FD_LARGE_*` from current env for this profile
- the whole point is to benchmark the rollout candidate even before prod env is cut over
- keep the target model constants centralized in this helper

### Suggested shape

```ts
export type BenchmarkProfileId = 'target_rollout';

export interface ResolvedBenchmarkProfile {
  id: BenchmarkProfileId;
  label: string;
  provider: 'openrouter';
  model: 'qwen/qwen3-coder-next';
  promptRepeat: false;
  fdV3Enabled: true;
  fdLargeProvider: 'openrouter';
  fdLargeModel: 'qwen/qwen3-coder-plus';
}
```


## Task 2: Change benchmark request schema from arbitrary model launch to profile launch

In `packages/server/src/lib/schemas/order.ts`, replace the current benchmark launch schema with a profile-based request.

### Target request shape

```ts
{
  profile: 'target_rollout'
}
```

### Requirements

- `provider`
- `model`
- `contextLength`
- `promptRepeat`

must no longer come from the browser for this benchmark surface.

### Reason

Those fields describe a single-model experiment.
They are the wrong abstraction for a split-model rollout comparison.


## Task 3: Make benchmark POST resolve the full rollout candidate server-side

Update `packages/server/src/app/api/orders/[id]/benchmark/route.ts`.

### Requirements

1. Parse `profile` from the request body.
2. Resolve the full benchmark profile via `benchmark-profile.ts`.
3. Build `resolvedConfig` from that profile:
   - small/default model = `openrouter + qwen/qwen3-coder-next`
4. Resolve actual context length for the small/default model using the existing model-context helper.
5. Build snapshot fields from the resolved profile, not from current env:
   - `benchmarkProfile`
   - `benchmarkProfileLabel`
   - `fdV3Enabled = true`
   - `fdLargeProvider = openrouter`
   - `fdLargeModel = qwen/qwen3-coder-plus`
   - `promptRepeat = false`
   - `contextLength`
   - `effectiveContextLength`
6. Fingerprint the whole profile:
   - profile id
   - small provider/model
   - effective context
   - fd flags
   - large provider/model
7. Local and Modal launches must both use the resolved snapshot as the source of truth.

### Important

- do not silently fall back to current env FD settings for `target_rollout`
- do not reintroduce ambiguity by mixing fixed profile fields with live env flags

### Backward compatibility

- old benchmark jobs without `benchmarkProfile` in their snapshot must remain readable
- new jobs should always have it


## Task 4: Simplify the order-page benchmark launcher to a rollout benchmark

Update `packages/server/src/components/benchmark-launcher.tsx`.

### Requirements

- remove provider select
- remove model picker dialog
- remove promptRepeat checkbox
- remove single-model cost estimate text
- replace them with a read-only description of the benchmark profile:
  - `3-49 files: openrouter / qwen/qwen3-coder-next`
  - `50+ files: FD v3 / openrouter / qwen/qwen3-coder-plus`
- launch payload must be:

```json
{ "profile": "target_rollout" }
```

### UX goal

The operator should not have to understand FD env flags or remember which model goes with which file bucket.

The launcher should make it obvious that this run means:

> compare original order results with the full new production candidate


## Task 5: Expose benchmark profile metadata in compare API

Update `packages/server/src/app/api/orders/[id]/benchmark/compare/route.ts`.

### Requirements

For each run, return:

- `benchmarkProfile: string | null`
- `benchmarkProfileLabel: string | null`

derived from `llmConfigSnapshot`.

### Backward compatibility

- old runs without profile metadata should return `null`
- do not break existing `fdV3Enabled`, `fdLargeProvider`, `fdLargeModel`, `models` behavior


## Task 6: Show the rollout profile clearly in the benchmark matrix

Update `packages/server/src/components/benchmark-matrix.tsx`.

### Requirements

- if `benchmarkProfileLabel` exists, show it in the run header
- for `target_rollout`, the header should read as a deliberate rollout candidate, not just a single model name
- keep the existing split-model display:
  - small/default model in the main header
  - `50+ files: qwen3-coder-plus` in the secondary line
- old runs without profile metadata should render a neutral fallback such as:
  - `Legacy benchmark`
  - or no badge at all

### Goal

An expert reviewing the matrix should immediately see:

- this run is the rollout benchmark
- the small/default model
- the large `FD v3` model

without needing to infer it from method names or hidden env state.


## Task 7: Tests

### Route tests

Update `packages/server/src/app/api/orders/[id]/benchmark/__tests__/route.test.ts` to cover:

1. launching with `{ profile: 'target_rollout' }`
2. snapshot stores:
   - `benchmarkProfile = target_rollout`
   - `fdV3Enabled = true`
   - `fdLargeProvider = openrouter`
   - `fdLargeModel = qwen/qwen3-coder-plus`
   - `promptRepeat = false`
3. fingerprint changes if the rollout profile constants change
4. local launch still calls `processAnalysisJob()` with resolved small-model context
5. Modal launch still writes benchmark job metadata and triggers Modal

### Compare route tests

Update `packages/server/src/app/api/orders/[id]/benchmark/compare/__tests__/route.test.ts` to cover:

1. `benchmarkProfile` and `benchmarkProfileLabel` are returned for new runs
2. older runs without those fields still render successfully
3. split-model run still exposes per-commit FD model information


## Task 8: E2E verification

### Staging

On a completed staging order:

1. open order page as admin
2. launch benchmark
3. wait for completion
4. verify job snapshot contains:
   - `benchmarkProfile = target_rollout`
   - `fdV3Enabled = true`
   - `fdLargeProvider = openrouter`
   - `fdLargeModel = qwen/qwen3-coder-plus`
5. verify the matrix header shows the rollout profile and split-model info
6. verify at least one `50+` file commit uses the large-path method family:
   - `FD_v3_holistic`
   - `bulk_scaffold_detector`
   - or other expected `FD v3` routes

### Production smoke check

After staging pass and approval, rerun on the real commercial order:

- `cmn561qu00001jv043sg35pd6`

Expected outcome:

- benchmark no longer captures the partial config seen in `cmnbfgv330001l404n81fop90`
- it captures the full rollout candidate instead


## Acceptance Criteria

This task is complete when all of the following are true:

1. launching an order benchmark no longer depends on current env FD flags to define the benchmarked pipeline
2. the order-page benchmark launcher runs the explicit rollout candidate profile
3. the benchmark snapshot always contains:
   - `benchmarkProfile`
   - `fdV3Enabled = true`
   - `fdLargeProvider = openrouter`
   - `fdLargeModel = qwen/qwen3-coder-plus`
4. benchmark fingerprints distinguish this rollout profile from older ad hoc runs
5. compare API and matrix UI clearly identify the run as the rollout benchmark
6. on a real benchmarked order, `50+` file commits go through the new large-path family, not legacy `FD v2` behavior


## Non-Goals / Guardrails

- do not make the order-page benchmark launcher a generic experiment lab
- do not add a DB migration for benchmark profiles
- do not modify normal production analysis behavior in this task
- do not build custom operator controls for FD flags


## Reviewer Focus

When reviewing the implementation, check these first:

1. `benchmark/route.ts` does **not** source `fdV3Enabled` / `fdLarge*` from current env for `target_rollout`
2. launcher payload is profile-based, not model-based
3. snapshot and fingerprint capture the full resolved split-model config
4. compare UI stays backward-compatible with older benchmark rows
5. staging run actually produces `FD_v3_*` methods on large commits


## Suggested Commit Structure

1. `feat(benchmark): add rollout benchmark profile resolver`
2. `feat(benchmark): launch order benchmarks via target rollout profile`
3. `feat(benchmark): label rollout profile in compare api and matrix`
4. `test(benchmark): cover rollout benchmark snapshot and compare payload`
