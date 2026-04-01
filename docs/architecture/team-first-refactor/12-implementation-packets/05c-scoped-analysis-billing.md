# Slice 5C: Scoped Analysis Billing

## Goal

Make analysis credit estimation and reservation derive from the authoritative scoped commit universe, not from stale extraction-time aggregates.

After this slice:

- the product reserves credits from the real selected analysis scope;
- UI estimate and server preflight use the same source of truth;
- fully cached or zero-net analyses can run without an artificial `1 credit` floor;
- credit billing stays the authoritative product meter;
- any USD hint is explicitly approximate, not a promise of exact runtime cost.

This is the target-state billing solution for the current analysis flow, not another compatibility bridge.

## Why this exists

The current billing path is workable but not yet target-state.

Today:

- the analysis preflight estimates credits from `selectedDevelopers.commitCount`;
- that is an extraction-time contributor aggregate, not an authoritative scoped commit universe;
- the UI mirrors that same aggregate on the client;
- both sides still apply `Math.max(1, ...)`, which blocks fully cached analyses unless the user has at least one available credit;
- the USD hint comes from a coarse average token model, so it should not be presented as exact cost.

That creates three product problems:

1. scope changes can drift away from the stored extraction aggregate;
2. credit gating can be stricter than actual billable work;
3. customer-facing price language is more precise than the system can honestly support.

The product is paid. This path has to be correct, conservative, and explainable.

## Locked decisions this packet depends on

- `D-004`: `User` and `Contributor` are distinct entities; billing must not be conflated with contributor identity.
- `D-008`: `AnalysisSnapshot`/run engine may remain internal during migration.
- `D-015`: raw events are append-only; curation and projection are separate concerns.
- `D-017`: legacy run engine stays in place during migration.

## Target architecture

### 1. One authoritative billing preview service

There must be one server-side source of truth for analysis billing preflight.

That source must derive:

- selected repository scope;
- selected period scope;
- selected contributor scope;
- exact or authoritative candidate commit universe for that scope;
- reusable cached commit count under the current cache mode;
- final billable commit count;
- credit reservation amount.

The UI must not maintain an independent approximation.

Acceptable architecture:

- a shared server service used by both the analyze route and a billing-preview route;
- or a shared server service used by the analyze route and by the order-detail read model.

Unacceptable architecture:

- client-only estimation that reimplements route logic;
- pricing derived only from `selectedDevelopers.commitCount`;
- one code path for UI and a different one for reservation.

### 2. Billable unit is the in-scope non-cached commit

Credits should be billed from:

- the commits that are in scope for the selected repositories;
- within the selected period;
- for the selected included contributors;
- minus reusable cached commits under the chosen cache mode.

This product may let the customer choose only part of the discovered contributor set.

Therefore the billing model must continue to respect:

- included / excluded contributors;
- date range / years / last-N mode;
- selected repositories;
- cache reuse.

It must not price “all discovered developers” when the user selected only a subset.

### 3. No artificial minimum credit floor

If the authoritative billable commit count is `0`, the user should be able to launch analysis with `0` available credits.

That means:

- remove the `Math.max(1, ...)` reservation floor from both preview and preflight;
- preserve safe reservation behavior for positive billable counts;
- keep release-of-unused-reservation behavior intact.

The product may still show a non-zero “candidate commit count” for transparency, but the reservable / billable credit count must be able to be zero.

### 4. Credits are authoritative; USD is advisory

`Credits` remain the authoritative customer-facing billing unit for analysis.

If the UI shows a dollar estimate, it must be framed as:

- approximate;
- model/provider dependent;
- best-effort, not contractual.

This slice does not need exact ex-post money estimation before a run.

It does need honest language.

### 5. Cache-awareness must match execution semantics

Preview and reservation must respect the same cache semantics the worker uses at execution time.

That includes:

- cache disabled;
- model-scoped cache reuse;
- cross-order cache reuse where allowed.

Bias:

- do not under-reserve when the preview is uncertain;
- but do not keep a fake `+1 credit` minimum as a substitute for correctness.

If the implementation must choose between:

- exact but slightly more expensive preview work;
- or cheap but stale aggregate counting,

choose correctness for the paid path.

### 6. Legacy compatibility remains until explicitly migrated

Historical orders and tests may still contain:

- `commit_count` instead of `commitCount`;
- mixed-quality `selectedDevelopers` payloads;
- blank-email legacy rows.

The target-state solution must not regress them.

Compatibility rules:

- keep dual fallback where old payloads still flow through;
- ignore rows that cannot participate in scoped contributor billing safely;
- do not let hidden legacy rows inflate reservation or block analysis.

### 7. Admin and customer paths must stay logically aligned

Admins may bypass wallet billing, but the scoped commit preview logic should still describe the same selected scope.

That means:

- same billable-commit logic;
- same included/excluded contributor scope;
- same period/repository interpretation;
- only the wallet reservation/debit behavior differs.

## Required outcomes

### A. UI and route agree on cost

For the same selected repositories, period, contributors, and cache mode:

- the order detail screen;
- the billing preview;
- and `/api/orders/[id]/analyze`

must resolve the same billable commit count.

### B. Scope changes recalculate honestly

Changing:

- date range;
- last-N limit;
- contributor inclusion;
- cache mode;
- repository set

must invalidate and recompute the billing preview from authoritative scoped commit data.

### C. Fully cached runs are allowed with zero credits

If every in-scope commit can be reused from cache:

- preview shows `0` billable credits;
- preflight allows the run with `0` available credits;
- the run still completes correctly.

### D. Credits stay conservative and safe

This slice is invalid if it weakens:

- reservation correctness;
- cache accounting;
- release of unused reserved credits;
- auditability of wallet changes.

### E. Price language becomes honest

The UI must clearly distinguish:

- `estimated credits` as the real product meter;
- `estimated USD` as approximate best-effort guidance, if shown at all.

## In scope

- authoritative analysis billing preview service
- shared billable-commit calculation for UI and analyze preflight
- removal of the artificial `1 credit` minimum floor
- cache-aware billable count for selected repo + period + contributor scope
- honest credit / USD language hardening
- legacy compatibility for mixed `commitCount` / `commit_count` payloads and blank-email rows
- tests for preview, reservation, fully-cached zero-credit runs, and scope changes

## Out of scope

- pricing-plan redesign
- seat pricing / org monetization
- total worker rewrite
- replacing the legacy `/orders/*` routes
- exact ex-post billing from provider invoices before run launch
- diagnostics hub work
- public report pricing / schedule pricing

## Allowed write scope

- `packages/server/src/app/[locale]/(dashboard)/orders/**`
- `packages/server/src/app/api/orders/**`
- `packages/server/src/app/api/llm-info/route.ts`
- `packages/server/src/lib/services/**`
- `packages/server/src/lib/schemas/**`
- `packages/server/messages/en.json`
- `packages/server/messages/ru.json`
- tests adjacent to the touched files

## Hard rules

- Do not keep reservation logic dependent on stale extraction-time commit aggregates as the business contract.
- Do not keep an artificial `1 credit` minimum if the authoritative billable scope is zero.
- Do not make the client estimate cost independently from the server source of truth.
- Do not charge or reserve for excluded contributors.
- Do not regress cache-aware billing semantics.
- Do not present approximate USD guidance as exact price.
- Do not weaken reservation / debit / release auditability.

## Acceptance criteria

- the same scoped billable commit count is used by UI preview and analyze preflight
- changing contributor scope or period updates the preview from authoritative scoped data
- a fully cached or zero-net run can start with `0` available credits
- customer billing still reserves safely before execution for positive billable counts
- legacy mixed payloads do not inflate estimate or break the selector
- customer-facing price language distinguishes credits from approximate USD
- typecheck and relevant tests pass

## Validation expectations

- tests for shared billing-preview logic
- tests for contributor inclusion/exclusion affecting billable commit count
- tests for date-range / last-N scope changes affecting billable commit count
- tests for cache-off / cache-on / fully-cached scenarios
- tests for zero-credit launch eligibility
- smoke:
  - run a first analysis with one included contributor subset
  - confirm estimated credits change when contributors are excluded
  - confirm fully cached rerun shows `0` billable credits
  - confirm analysis starts successfully with `0` available credits when billable scope is zero
  - confirm UI and route agree on estimated credits

## Expected outcome

After this slice, the product should behave like:

```text
Choose repositories
  -> choose period
  -> choose contributors
  -> see authoritative scoped billable commits
  -> reserve only the needed credits
  -> run analysis
  -> pay only for the non-cached work in that scope
```

That is the target-state billing model implied by a paid scoped analysis product.
