# Staging Deploy and Validation Checklist — Estimator Rollout

## Purpose

Move the validated estimator rollout to staging and confirm that the real deployed system behaves like the local pre-staging replays.

Target staging state:

- small / normal commits: `qwen/qwen3-coder-next`
- `50+` file commits: `FD v3` with `qwen/qwen3-coder-plus`


## Entry Gate

Start this checklist only if all are true:

1. Pre-staging local validation passed.
2. The branch/commit selected for staging is fixed.
3. Server code is ready to deploy.
4. Modal worker code is ready to deploy.
5. Required secrets exist for staging:
   - `OPENROUTER_API_KEY`
   - `FD_V3_ENABLED=true`
   - `FD_LARGE_LLM_PROVIDER=openrouter`
   - `FD_LARGE_LLM_MODEL=qwen/qwen3-coder-plus`
6. Staging DB is healthy.


## Deploy Order

### 1. Deploy server

Deploy the staging server build first.

Confirm after deploy:

- app boots
- admin settings page loads
- orders page loads
- benchmark route is reachable

### 2. Deploy Modal worker

Deploy the worker version that includes:

- context-aware routing support
- `FD v3`
- `FD_V3_ENABLED` env propagation
- large-model env support

Confirm after deploy:

- worker starts successfully
- no import/runtime errors in startup logs

### 3. Apply staging config

Set staging to the intended split:

- `SystemSettings.llmProvider = openrouter`
- `SystemSettings.openrouterModel = qwen/qwen3-coder-next`

And in env / Modal secrets:

- `FD_V3_ENABLED=true`
- `FD_LARGE_LLM_PROVIDER=openrouter`
- `FD_LARGE_LLM_MODEL=qwen/qwen3-coder-plus`


## Validation Sequence

Run the checks in this exact order.

If one fails, stop and investigate before continuing.

### Phase A — Config sanity

Verify in staging admin/settings:

1. editable default provider is `openrouter`
2. editable default model is `qwen/qwen3-coder-next`
3. large-path read-only card is visible
4. large-path card shows:
   - `FD v3` enabled
   - provider `openrouter`
   - model `qwen/qwen3-coder-plus`
5. no stale fallback values are shown

### Phase B — Benchmark sanity

Run two manual benchmark checks:

1. one routine small commit
2. one known `50+` file commit

Confirm:

- both requests finish
- reported model/provider are correct
- small commit does not show false FD behavior
- large commit uses the `FD v3` path
- no obvious `5.0h` fallback artifact appears

### Phase C — Real analysis job: small/routine order

Launch one staging order with ordinary commits.

Confirm:

- job starts
- progress updates work
- job completes
- `llmConfigSnapshot` is saved
- snapshot includes effective context data
- estimates look sane
- no unexpected FD over-routing

### Phase D — Real analysis job: large-commit order

Launch one staging order known to include a `50+` file commit.

Confirm:

- job starts
- Modal execution works
- `FD v3` route is visible in diagnostics/logs
- result completes without worker fallback/error
- estimate is not obviously in the old FD-v2 overestimation regime


## Required Observability Checks

For both real staging jobs, capture:

- provider
- model
- `method`
- `routed_to`
- `rule_applied`
- `complexity_guard`
- `effectiveContextLength`
- whether any `estimated_hours = 5.0` fallback appeared

At minimum, save:

1. screenshot or JSON of admin/settings
2. benchmark outputs for the two sample commits
3. one small-job result payload
4. one large-job result payload
5. relevant server / Modal logs if anything looks wrong


## Stop Conditions

Do not proceed to production if any are true:

- admin/settings does not reflect the split model architecture
- benchmark uses the wrong model/provider
- small/routine order shows false FD routing again
- large order does not use `FD v3`
- staging jobs fail or retry repeatedly
- `5.0h` fallback appears on routine commits
- diagnostics/snapshots are missing critical routing data


## Exit Criteria

Staging validation is a PASS only if all are true:

1. config sanity passed
2. benchmark sanity passed
3. routine order passed
4. large-commit order passed
5. diagnostics are sufficient for production monitoring
6. no blocking regression is found


## Sign-Off Template

```text
Staging validation: PASS
Date:
Commit / release:
Server deploy:
Modal deploy:
Config sanity:
Benchmark sanity:
Routine order:
Large-commit order:
Known residual risks:
```


## What Happens After This

If staging passes:

1. prepare production cutover checklist
2. schedule production deploy
3. perform controlled cutover
4. monitor first 24-48 hours closely

If staging fails:

1. stop rollout
2. isolate whether failure is:
   - config
   - routing
   - worker deploy
   - benchmark/UI
   - estimate quality
3. fix and rerun staging validation from the failed phase
