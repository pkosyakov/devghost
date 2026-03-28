# Pre-Staging Validation Checklist — Estimator Rollout

## Purpose

Validate the merged estimator rollout on real production code before any staging deploy.

This checklist assumes the target architecture is now:

- `3-49 files`: diff-based path with `qwen/qwen3-coder-next`
- `50+ files`: `FD v3` metadata-only path with `qwen/qwen3-coder-plus`

This is not a development task.

It is the final local / pre-staging gate between implementation and staging rollout.


## Preconditions

Do not start this checklist until all are true:

1. `Release 1` is merged.
2. `Release 2` is merged.
3. `Release 3` is merged.
4. The current outstanding `Release 3` review finding on [llm-settings/route.ts](C:/Projects/devghost/packages/server/src/app/api/admin/llm-settings/route.ts) is fixed.
5. `OPENROUTER_API_KEY` is available in env or in [packages/server/.env](C:/Projects/devghost/packages/server/.env).
6. The audit repo exists at `C:\Projects\_tmp_devghost_audit\artisan-private`.


## Goal

Confirm four things before staging:

1. small-path quality still meets the revised-GT gate on the merged code
2. large-path `FD v3` quality still meets the large-GT gate on the merged code
3. config/admin alignment reflects the split-model production architecture
4. no obvious runtime regression was introduced in diagnostics, routing, or cost display


## Environment Setup

Run validation from `C:\Projects\devghost`.

For the small replay, set the production split explicitly in the shell session first:

```powershell
$env:FD_V3_ENABLED = 'true'
$env:FD_LARGE_LLM_PROVIDER = 'openrouter'
$env:FD_LARGE_LLM_MODEL = 'qwen/qwen3-coder-plus'
```

These vars matter because the small replay uses the real `run_commit()` path and should see the same large-path config the production pipeline will see.


## Phase 1 — Fast Safety Checks

Run these first. If any fail, stop and fix before replaying models.

### 1. Targeted admin/config tests

```powershell
cd C:\Projects\devghost\packages\server
npx vitest run src/app/api/admin/llm-settings/__tests__/route.test.ts
```

### 2. Routing/context tests

```powershell
cd C:\Projects\devghost\packages\server
npx vitest run src/lib/services/__tests__/model-context.test.ts src/app/api/orders/[id]/analyze/__tests__/route.test.ts
```

### 3. Large-path Python tests

```powershell
python -m pytest C:\Projects\devghost\packages\server\scripts\pipeline\test_fd_v3.py -q
```

### 4. TypeScript compile check

```powershell
cd C:\Projects\devghost\packages\server
npx tsc --noEmit --pretty false
```

Pass rule:

- all commands succeed

Stop rule:

- any test or compile failure blocks the rest of the checklist


## Phase 2 — Small-Path Replay on Merged Code

This is the exact pre-staging check for the merged small/default path.

### Command

```powershell
python C:\Projects\devghost\packages\server\scripts\pipeline\experiment_production_pipeline_replay.py `
  --repo C:\Projects\_tmp_devghost_audit\artisan-private `
  --models "Qwen3 Next" `
  --cache-namespace pre_staging_small_qwen_next_2026_03_28
```

### What this measures

- exact `run_commit()` behavior
- current small/default model = `qwen/qwen3-coder-next`
- real production routing and post-processing
- revised 20-case GT

### Required gate

- overall `<= 30% MAPE`
- `>= 15/20` in-range
- no obvious false routing into legacy large behavior on this dataset
- no routine `5.0h` fallback artifacts

### Expected artifact

The script writes JSON/Markdown results under:

- [experiment_v3_results](C:/Projects/devghost/packages/server/scripts/pipeline/experiment_v3_results)

Save the exact file names used for sign-off.

### Stop rule

Stop and investigate if any are true:

- overall MAPE is above `30%`
- in-range drops below `15/20`
- several cases unexpectedly route into FD / large path
- the result looks materially worse than the known post-fix baseline


## Phase 3 — Large-Path Replay on Merged Code

This is the exact pre-staging check for the new `FD v3` path.

### Command

```powershell
python C:\Projects\devghost\packages\server\scripts\pipeline\validate_fd_v3.py `
  --repo C:\Projects\_tmp_devghost_audit\artisan-private `
  --model qwen/qwen3-coder-plus
```

### What this measures

- end-to-end `run_commit()` behavior
- `FD_V3_ENABLED=true`
- large-path model = `qwen/qwen3-coder-plus`
- large 10-case GT

### Required gate

- overall `<= 40% MAPE`
- no obvious `2x-10x` overestimation failures
- `within 2x = 10/10`
- in-range roughly consistent with the validated baseline

### Expected artifact

The script writes:

- [validate_fd_v3_results.json](C:/Projects/devghost/packages/server/scripts/pipeline/validate_fd_v3_results.json)

Save the console summary together with this JSON.

### Stop rule

Stop and investigate if any are true:

- overall MAPE exceeds `40%`
- within-2x drops below `10/10`
- raw vs final diverges in surprising ways
- route labels do not show `v3_holistic` / `bulk_scaffold_detector` where expected


## Phase 4 — Config/Admin Sanity Check

Do this after the automated replays pass.

### Required manual checks

Open the admin settings page and verify all of the following:

1. default editable small/default path shows `openrouter`
2. default editable model shows `qwen/qwen3-coder-next`
3. fallback price display is aligned with the new model defaults
4. there is a separate read-only large-path section
5. the large-path section clearly shows:
   - whether `FD v3` is enabled
   - provider
   - model
6. the page does not imply that editing the main OpenRouter model also changes the large-path model
7. saving small/default settings still works

### Required API sanity checks

Verify these responses manually or via browser/devtools:

- `GET /api/admin/llm-settings`
- `GET /api/llm-info`

Expected behavior:

- both should reflect the new default direction on a fresh/missing-settings path
- neither should show stale `ollama` / `qwen/qwen-2.5-coder-32b-instruct` / `0.03-0.11` fallback values


## Phase 5 — Benchmark Route Sanity Check

Run two known commits through the UI benchmark flow.

### Required cases

1. one routine small/normal commit
2. one known `50+` file commit

### Validate

- benchmark finishes successfully
- provider/model shown in diagnostics match expectations
- small commit uses the small/default direction
- large commit shows the new large-path behavior
- no silent `5.0h` fallback artifact appears in an otherwise normal case


## Sign-Off Template

Pre-staging is approved only if all are true:

- Phase 1 passes
- small replay passes gate
- large replay passes gate
- admin/config sanity check passes
- benchmark sanity check passes

Record the sign-off in this format:

```text
Pre-staging validation: PASS
Date:
Commit / branch:
Small replay artifact:
Large replay artifact:
Admin sanity:
Benchmark sanity:
Known residual risks:
```


## Residual Risks That Do Not Block Staging

These are acceptable to carry into staging if the gates pass:

- small-path post-rule cleanup is not done yet
- optional single-call simplification is not done yet
- large-path model remains env-driven rather than DB-configured


## What Happens After This Checklist

If this checklist passes:

1. move to staging validation
2. do one routine order and one large-commit order on staging
3. verify Modal/job/progress/snapshot behavior
4. then prepare production cutover

If this checklist fails:

1. stop rollout progression
2. fix the blocking issue
3. rerun the failed phase from the beginning
