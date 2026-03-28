# Release 3 — Config and Admin Alignment for Split Estimator Models

## Context

Release 1 fixed the small-path routing issue.

Release 2 added the new large-commit production path:

- `3-49` files: diff-based estimation
- `50+` files: `FD v3` metadata-only estimation

The intended production model split is now:

- small / default path: `qwen/qwen3-coder-next`
- large `FD v3` path: `qwen/qwen3-coder-plus`

But the configuration layer and admin UX still reflect the old pre-rollout world:

- fresh defaults still point to `ollama`
- default OpenRouter model still points to `qwen/qwen-2.5-coder-32b-instruct`
- admin settings expose only one editable model and do not explain that the `50+` file path now uses a separate env-configured model

That creates operational risk before demos:

- a fresh environment seeds the wrong defaults
- admins can misread the page and assume large commits use the same model shown in the main OpenRouter field
- rollout state becomes harder to audit


## Goal

Align production defaults and admin settings UX with the shipped split-model estimator architecture.

After this task:

- fresh/default config should bias toward the new production direction
- admin settings should clearly distinguish:
  - editable small/default analysis model
  - read-only large `FD v3` model from env / Modal config
- no DB migration should be required


## Scope

### In scope

- update server-side default LLM provider/model to the new production small-path target
- keep large-path model env-driven
- expose large-path rollout status in admin settings API as read-only diagnostics
- show the large-path config in admin settings UI as read-only information
- keep the current admin edit flow for the small/default model working

### Out of scope

- any estimator logic changes
- prompt changes
- small-path post-rule cleanup
- single-call simplification
- DB / Prisma schema migration
- making the large-path model editable in admin UI


## Problem Statement

The estimator is no longer a single-model system, but the config layer still behaves as if it is.

Today:

1. fresh `SystemSettings` creation defaults to `ollama`
2. default cloud model points to an old OpenRouter model
3. admin UI exposes one provider + one model selector
4. large-path `FD v3` config exists only in env / Modal worker config

This is now misleading.

An admin can open settings, see `openrouterModel`, and incorrectly assume that model is used everywhere, while in reality:

- small / normal commits use the editable default path model
- large commits use `FD_V3_ENABLED` + `FD_LARGE_LLM_PROVIDER` + `FD_LARGE_LLM_MODEL`


## Desired Behavior

### Small / default path

This remains the existing editable setting in `SystemSettings`.

Target defaults:

- provider: `openrouter`
- model: `qwen/qwen3-coder-next`

### Large `FD v3` path

This remains env-driven for now.

Expose in admin UI as read-only:

- whether `FD_V3_ENABLED` is on
- which provider the large path uses
- which model the large path uses

If env vars are missing, show that clearly as "not configured" rather than implying the main OpenRouter model will be used.


## References

Read these before implementing:

- `docs/production-estimator-rollout-plan.md`
- `docs/research-small-commit-qwen-next-optimization.md`
- `docs/research-holistic-estimation.md`
- `docs/plans/2026-03-28-release-1-small-path-context-routing.md`
- `docs/plans/2026-03-28-release-2-large-path-fdv3.md`

Primary source files:

- `packages/server/src/lib/llm-config.ts`
- `packages/server/prisma/seed.ts`
- `packages/server/src/app/api/admin/llm-settings/route.ts`
- `packages/server/src/app/[locale]/(dashboard)/admin/settings/page.tsx`


## Implementation Requirements

### 1. Update fresh defaults for the small/default analysis path

Change the fallback / seed defaults so that new environments and missing `SystemSettings` records align with the intended rollout:

- `llmProvider = openrouter`
- `openrouterModel = qwen/qwen3-coder-next`

Places to update:

- `packages/server/src/lib/llm-config.ts`
- `packages/server/prisma/seed.ts`
- `packages/server/src/app/api/admin/llm-settings/route.ts`
- any other server-side fallback that still hardcodes the old provider/model

Important:

- do not overwrite existing DB settings for already configured environments
- this is about defaults and initial values, not forced migration of live settings
- this includes synchronous env-only fallbacks such as `getLlmConfigSync()` where they still hardcode the old provider/model

Clarification:

- `getLlmConfigSync()` should also move to `openrouter + qwen/qwen3-coder-next`
- do not invent a new silent fallback back to `ollama` there
- keep behavior simple: it is an env-only config snapshot, not a smart recovery layer
- note that the current sync helper does **not** enforce presence of `OPENROUTER_API_KEY`, so aligning its defaults does not by itself introduce a new API-key throw path

### 2. Keep large-path model env-driven

Do not add DB fields for the large model in this task.

The large path should continue to come from env / Modal config:

- `FD_V3_ENABLED`
- `FD_LARGE_LLM_PROVIDER`
- `FD_LARGE_LLM_MODEL`

If helper names still reference "FD" or "large", that is acceptable here.

### 3. Extend admin settings API with read-only large-path diagnostics

The admin settings API should expose read-only fields describing the active large path.

Recommended response fields:

- `fdV3Enabled: boolean`
- `fdLargeLlmProvider: string`
- `fdLargeLlmModel: string`

These fields should:

- be returned by `GET /api/admin/llm-settings`
- not be patchable by `PATCH /api/admin/llm-settings`
- never expose secrets

If the large-path env config is absent, return safe explicit values such as:

- `fdV3Enabled = false`
- empty provider/model or a clear "not configured" equivalent handled by UI

### 4. Update admin settings page to reflect the split model architecture

The admin page should clearly show two concepts:

1. editable small/default analysis config
2. read-only large-commit `FD v3` config

UI requirements:

- keep the existing edit controls for the small/default path
- add a separate read-only card/section for the large path
- clearly label that the large path applies to `50+` file commits
- clearly label that the large-path model is env / deployment configured, not edited on this page
- show whether `FD v3` is enabled
- show provider + model for the large path when configured

Do not make the page imply that editing `openrouterModel` also changes the large `FD v3` model.

### 5. Preserve current admin save semantics

Current admin behavior around masked API keys and partial updates must keep working.

Do not regress:

- masked `openrouterApiKey` handling
- env-key fallback behavior
- partial PATCH updates


## Clarifications

### Seed behavior

In `packages/server/prisma/seed.ts`:

- update the `create` block for fresh environments
- leave the `update` block non-destructive with respect to LLM fields

This task must not use `db:seed` as a way to rewrite live LLM settings.

### Pricing fallbacks

If a server-side fallback currently hardcodes prices that are coupled to the old default model, update those fallback/display values so they are not misleading once the default model becomes `qwen/qwen3-coder-next`.

Scope rule:

- yes, keeping fallback prices aligned with the default model is in scope
- no, building a new pricing-sync architecture is not
- if live pricing is already refreshed from the OpenRouter models API elsewhere, preserve that behavior
- these fallback prices are boot/display defaults, not a source of truth for billing


## File-Level Responsibility

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `packages/server/src/lib/llm-config.ts` | Update default provider/model fallbacks |
| Modify | `packages/server/prisma/seed.ts` | Update initial `SystemSettings` seed defaults |
| Modify | `packages/server/src/app/api/admin/llm-settings/route.ts` | Return read-only large-path diagnostics and new defaults |
| Modify | `packages/server/src/app/[locale]/(dashboard)/admin/settings/page.tsx` | Show split-model admin UX with read-only large-path section |
| Create or Modify | tests near admin settings route/UI if present | Cover new defaults and read-only diagnostics |


## Testing Requirements

### Required automated coverage

At minimum, cover:

1. admin settings GET fallback
   - when no `SystemSettings` record exists, defaults are:
     - `openrouter`
     - `qwen/qwen3-coder-next`

2. large-path diagnostics
   - GET includes `fdV3Enabled`, `fdLargeLlmProvider`, `fdLargeLlmModel`
   - PATCH does not allow those fields to mutate persisted DB settings

3. existing admin save behavior
   - masked API key handling still works
   - partial PATCH does not regress

If there is already a practical route-test harness for this admin endpoint, use it.
If not, add a focused one rather than broad UI end-to-end coverage.

### Required manual validation

Before marking the task done, verify:

1. fresh/default admin settings show `openrouter` + `qwen/qwen3-coder-next`
2. the page clearly shows large-path `FD v3` state
3. when `FD_V3_ENABLED=true` and `FD_LARGE_LLM_MODEL=qwen/qwen3-coder-plus`, the admin page reflects that split correctly
4. saving the small/default model still works and does not affect the read-only large-path section


## Acceptance Criteria

The task is done only if all are true:

1. Fresh/default config now points to `openrouter` + `qwen/qwen3-coder-next`.
2. Existing DB-backed settings are not forcibly rewritten by this task.
3. Admin settings API exposes read-only large-path rollout state.
4. Admin UI clearly distinguishes editable small/default model config from read-only large-path config.
5. No DB migration is introduced.
6. Existing admin save semantics for API keys and partial updates still work.
7. The resulting UI no longer implies that one model setting controls both small and large commit paths.


## Non-Functional Constraints

- Keep this PR focused on config/admin alignment.
- Do not change estimator prompts or routing logic.
- Do not add Prisma fields.
- Do not make the large-path model editable yet.
- Keep rollback trivial: reverting this PR should not affect the already shipped estimator logic.


## Deliverables

The PR should include:

1. updated defaults for fresh config
2. admin API support for read-only large-path diagnostics
3. admin UI update that explains the split model setup
4. automated tests for the route behavior
5. a short PR note stating:
   - the new default provider/model
   - which fields remain env-driven
   - how the UI now communicates the split


## Reviewer Focus

The follow-up review will focus on:

1. whether defaults changed only for fresh/fallback config and not for existing DB settings
2. whether admin UI accurately reflects the split model architecture without being misleading
3. whether any secret/env leakage was introduced
4. whether PATCH remained limited to editable small/default settings
5. whether this PR stayed out of estimator logic and schema changes


## Suggested Branch / PR Title

Branch:

- `codex/release-3-config-admin-split-models`

PR title:

- `feat(admin): align llm settings with split estimator model rollout`
