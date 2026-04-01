# Slice 4B: Analysis Identity Bridge

## Goal

Remove the legacy developer-loading and manual deduplication step from the default new-customer analysis path, while keeping the current run engine and compatibility fields intact.

This slice exists to bridge two truths:

- the target product model is now built around canonical `Contributor`, `Repository`, `Team`, and `SavedView`;
- the legacy analysis flow still stops the user inside raw-author extraction and developer dedup before analysis can proceed.

The target user experience is:

```text
Home
  -> Run first analysis
  -> Analysis setup
  -> Preparing contributors
  -> Analysis processing
  -> Analysis results
  -> People review
```

not:

```text
Home
  -> Run first analysis
  -> raw developer extraction
  -> manual dedup
  -> save mapping
  -> start analysis
```

## Why this exists

After Slice 4A, the onboarding path is materially better:

- the customer understands public vs private repository setup;
- the product explains what analysis is;
- first-team creation and first-saved-view guidance now exist.

But one major legacy gap remains:

- selecting a repository can still push the customer into a mandatory developer-dedup screen;
- that screen operates on pre-canonical raw identities;
- it makes the base path feel order-centric and internal again;
- it reintroduces identity review in the wrong place.

This is specifically at odds with the locked refactor direction:

- identity trust should converge on canonical `Contributor` / `ContributorAlias`;
- `Order` is not a primary UX object;
- legacy run infrastructure should remain during migration, but not dominate the customer path.

## Locked decisions this packet depends on

- `D-005`: contributor identity resolution is foundation work.
- `D-008`: `AnalysisSnapshot` replaces `Order` as the internal concept; it is not a primary UX entity.
- `D-015`: raw events are append-only; curation is modeled separately.
- `D-017`: legacy run engine stays in place during migration.
- `D-021`: onboarding should prefer `Create team from repository`.

## Problem statement

Today the analysis flow still depends on legacy compatibility fields:

- `order.selectedDevelopers`
- `order.developerMapping`

Those fields are not the target business model. They are bridge artifacts that currently serve:

- commit-author extraction;
- billing estimation;
- compatibility with the existing analysis worker and projector pipeline.

The customer should not be forced to curate those fields manually in the default path.

## Target architecture

### 1. Canonical truth stays in contributor surfaces

Identity trust belongs to:

- `Contributor`
- `ContributorAlias`
- `People`
- identity queue / curation surfaces

It does not belong as a blocking wizard step inside analysis setup.

### 2. Legacy compatibility fields remain, but become machine-managed

For now:

- `selectedDevelopers`
- `developerMapping`

remain in the system as compatibility inputs for the current analysis worker, credit estimation, and contributor projector.

But they must shift from:

- primary customer-authored objects

to:

- internal machine-generated preparation artifacts.

### 2A. Billing and credit reservation remain first-class constraints

This product is paid, and the current run path already estimates analysis cost before launching work.

Today that estimation depends on compatibility inputs derived from the selected developers set.

That means this slice must preserve a safe billing sequence:

1. create analysis;
2. auto-prepare compatibility identity inputs;
3. compute / reserve credits using the same compatibility model the current analyze route expects;
4. only then launch the analysis job.

Do not introduce a flow that:

- launches analysis before billable scope can be estimated;
- undercounts contributors/commits because compatibility fields are still empty;
- bypasses the existing credit-reservation logic.

### 3. Analysis setup should auto-prepare identity inputs

After the customer selects repositories and creates an analysis:

1. the system should extract raw commit authors for the chosen repository scope;
2. the system should auto-build deterministic duplicate groups using the current heuristics;
3. the system should persist the resulting compatibility payloads;
4. the system should advance the legacy order state automatically;
5. the user should see a neutral preparation state, not a manual dedup workflow.

### 4. Identity review moves out of the blocking path

If duplicate groups or unresolved aliases need attention, the customer should learn that through:

- analysis results guidance;
- `People` summary;
- identity queue / curation surfaces.

The correct message is:

- "some identities need review"

not:

- "stop here and manually deduplicate developers before analysis may begin".

### 5. Advanced/manual identity mapping becomes secondary

If the current manual dedup editor is retained for compatibility, it should be:

- hidden from the primary first-run journey;
- framed as advanced repair / override tooling;
- optional for mature users or future diagnostics/curation work.

It must no longer be the default analysis continuation step.

## Recommended implementation shape

### A. Extract a reusable identity-preparation service

Move the core logic out of the route/UI path and into a reusable service.

That service should:

- load selected repositories for an analysis;
- fetch commits using existing repository access logic;
- build raw developer candidates;
- compute duplicate groups with current deterministic rules;
- derive:
  - `selectedDevelopers`
  - `developerMapping`
  - `availableStartDate`
  - `availableEndDate`
  - `totalCommits`
- advance legacy status to a runnable state.

This avoids duplicating logic between:

- the legacy manual developer-loading route;
- the new auto-preparation path.

### B. Add an automatic preparation step to the happy path

When a new analysis is created from `New Analysis`:

- do not route the user into manual dedup by default;
- automatically trigger identity preparation;
- show a neutral state such as:
  - `Preparing contributors`
  - `Building identity candidates`

The user should feel that the analysis is progressing, not waiting for manual data entry.

### C. Auto-start analysis after preparation for the standard path

Preferred behavior for the standard customer path:

1. create analysis;
2. prepare compatibility identity inputs automatically;
3. let the existing billing-safe analyze path estimate and reserve credits from those prepared inputs;
4. launch analysis automatically;
5. land on processing / results.

This is the most consistent interpretation of `Run first analysis`.

If there is a strong implementation reason to split the step, the fallback is:

- preparation runs automatically;
- the user lands on a minimal ready-to-run state with one obvious CTA;
- but the manual dedup screen must still remain hidden by default.

### D. Surface trust issues in canonical places

After analysis completes:

- analysis results should link the customer into `People`;
- `People` should remain the first trust checkpoint;
- unresolved identity issues should be visible there, not hidden inside raw developer groups.

### E. Preserve mature/internal escape hatches

The current manual dedup tooling may stay available behind one of these shapes:

- an advanced action on analysis detail;
- an internal/admin-only action;
- a temporary troubleshooting section hidden from first-run onboarding.

Do not delete useful repair tooling if it would destabilize the migration.

## In scope

- removing the mandatory manual developer-dedup step from the default customer flow
- automatic generation of legacy compatibility identity payloads
- neutral preparation UX for analysis identity setup
- automatic or near-automatic progression into analysis processing
- stronger handoff from analysis results into canonical `People`
- customer-facing copy needed to support the new flow
- targeted tests for new auto-preparation behavior

## Out of scope

- schema changes
- Prisma migration work
- replacing `Order` in backend/domain code
- route rename away from `/orders/*`
- rewriting billing logic
- rewriting the analysis worker
- redesigning canonical identity rules
- full Slice 5 curation/diagnostics work
- removing advanced/manual identity tooling everywhere

## Allowed write scope

- `packages/server/src/app/[locale]/(dashboard)/orders/**`
- `packages/server/src/app/api/orders/**`
- `packages/server/src/lib/services/**`
- `packages/server/src/lib/deduplication.ts`
- `packages/server/src/lib/schemas/**`
- `packages/server/messages/en.json`
- `packages/server/messages/ru.json`
- tests adjacent to the touched order/service files

## Hard rules

- Do not remove `selectedDevelopers` or `developerMapping` yet.
- Do not bypass canonical contributor projection.
- Do not bypass or weaken the existing cost-estimation / credit-reservation flow.
- Do not introduce a big-bang run-engine rewrite.
- Do not make manual identity mapping the primary UX path.
- Do not regress existing mature-user analysis detail capabilities unless they are explicitly being hidden behind an advanced affordance.

## Acceptance criteria

- after repository selection, a new customer no longer hits a mandatory manual developer-dedup step
- the system auto-prepares compatibility identity inputs needed by the existing worker
- the existing billing path still estimates and reserves credits from valid prepared inputs before analysis starts
- the default analysis path progresses into processing/results with no raw-identity review gate
- unresolved identity issues are surfaced through canonical contributor-oriented surfaces rather than a blocking setup step
- existing analysis worker and contributor projector continue to function
- no schema changes are introduced

## Validation expectations

- unit tests for the new identity-preparation service or extracted preparation helpers
- route/page tests for the new auto-preparation behavior where practical
- typecheck must pass
- targeted smoke:
  - create analysis from public repo
  - create analysis from connected/private repo
  - confirm no mandatory dedup screen in the default path
  - confirm completed analysis still projects canonical contributors

## Expected outcome

After this slice, the base path will feel like:

- select repositories
- run analysis
- review results
- fix identity only if needed

instead of:

- select repositories
- manually normalize raw authors
- then finally start analysis

That is the correct bridge from the legacy order flow into the refactored canonical entity model.
