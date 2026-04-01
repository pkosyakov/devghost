# Slice 5A: Canonical Identity Curation

## Goal

Make canonical contributor identity the only identity layer the customer reviews and edits.

After this slice:

- analysis setup no longer depends on manual raw developer dedup;
- billing remains safe and conservative;
- analysis cost still depends on the actual selected contributor scope and selected period;
- contributor projection no longer depends on customer-edited order-local developer lists as the core business path;
- manual merge / unmerge still exists, but on canonical `Contributor` / `ContributorAlias` surfaces.

This is the target solution for the current identity gap, not a temporary UX bridge.

## Why this exists

The current system still carries a legacy path:

```text
Create analysis
  -> extract raw developers
  -> manual dedup
  -> save mapping
  -> analyze
```

That path is wrong for the refactored product because:

- it exposes a pre-canonical identity layer to the customer;
- it blocks analysis on manual cleanup;
- it places trust work in the middle of setup instead of in `People` / curation;
- it makes a paid workflow depend on a customer-authored compatibility artifact.

The target model already exists in the architecture:

- canonical `Contributor`
- canonical `ContributorAlias`
- unresolved / suggested identity queue
- merge / unmerge actions
- People as trust checkpoint

This slice finishes that move.

## Locked decisions this packet depends on

- `D-005`: contributor identity resolution is foundation work.
- `D-008`: `AnalysisSnapshot` replaces `Order` as the internal concept; it is not a primary UX entity.
- `D-015`: raw events are append-only; curation is modeled separately.
- `D-016`: most curation actions should use incremental recomputation.
- `D-017`: legacy run engine stays in place during migration.

## Target architecture

### 1. Billing-safe analysis preflight uses repository + period + contributor scope

This is a paid product. Credit estimation and reservation must happen before analysis starts.

Target rule:

- billing must be derived from analysis scope preflight, not from a manual dedup workflow.

Analysis scope includes:

- selected repositories
- selected period
- selected included contributors (or excluded contributors)

The preflight should:

1. resolve the selected repositories and analysis scope;
2. discover candidate contributors for that scope;
3. let the user choose the included contributor set without forcing identity merge work;
4. fetch or estimate the in-scope commit universe for the chosen contributor set;
5. derive billable commit count with current cache/reuse rules;
6. reserve credits conservatively;
7. only then launch analysis.

Bias:

- false negatives are unacceptable if they under-reserve credits;
- if needed, reserve conservatively and release unused credits later.

Important distinction:

- contributor selection is a legitimate analysis-scope choice;
- manual identity merge / unmerge is a curation action and should not be required in setup.

### 2. Raw author signals feed canonical aliases directly

The system should ingest raw author/provider identities into `ContributorAlias` without forcing the customer to pre-curate a developer list.

Signals may come from:

- commit extraction during analysis preflight;
- commit evidence during analysis processing;
- provider metadata when available.

The canonical pipeline should be:

```text
Raw author/provider signals
  -> ContributorAlias
  -> deterministic auto-resolution
  -> unresolved/suggested queue
  -> Contributor
```

### 3. Auto-resolution must be conservative

Only deterministic matches should merge automatically.

For this slice:

- auto-merge safe deterministic matches such as exact provider identity / same GitHub login;
- do not auto-merge fuzzy name/domain/Levenshtein matches into canonical contributors.

Rule:

- prefer false negatives over false positives.

Why:

- false positives corrupt attribution and trust;
- false negatives can be corrected later through canonical merge actions.

### 4. Manual merge / unmerge remains, but on canonical surfaces

Manual identity correction is still required.

It must exist as:

- `merge contributors`
- `unmerge contributors`
- `assign alias to contributor`
- classification actions

But these actions belong to:

- `People`
- `Contributor Detail`
- `identity queue`
- future `Curation Hub`

They do not belong in the default analysis setup flow.

### 4A. Contributor selection stays in analysis setup

The customer still needs a way to limit analysis to only part of the discovered contributor set.

That means analysis setup should retain a lightweight contributor-scope step such as:

- `Included contributors`
- search/filter contributors
- select / deselect contributors
- see estimated commit volume / estimated credits update

But this step must be:

- canonical and scope-oriented;
- not a raw dedup/merge editor;
- not the place where the user resolves identity topology.

In other words:

- "who should be included in this analysis?" stays;
- "which raw aliases should be merged into one person?" moves to canonical curation.

### 5. Order-local compatibility artifacts stop being user-facing

`selectedDevelopers` and `developerMapping` must no longer define the business-facing contract.

Target preference:

- contributor projection should stop depending on customer-authored order-local JSON;
- if a temporary compatibility write still exists internally, it must be:
  - machine-generated,
  - hidden from customer UX,
  - treated as migration residue, not domain truth.

### 6. Analysis results hand off to People for trust review

After analysis completes:

- the customer should see analysis results;
- if identity quality needs attention, the next step is `People`;
- trust work happens on canonical contributor records.

## Required outcomes

### A. Analysis no longer blocks on manual dedup

The default happy path must be:

```text
Run analysis
  -> discover contributors for selected repos/period
  -> choose included contributors
  -> billing reservation
  -> processing
  -> results
```

No mandatory raw developer merge step.

### B. Canonical identity queue becomes the review surface

The customer should review:

- unresolved aliases
- suggested matches
- merge/unmerge state

through canonical identity surfaces, not analysis-local raw groups.

### C. Merge / unmerge survives as a real capability

Do not regress the ability to:

- merge contributors
- unmerge contributors
- reassign aliases
- classify bots/external

These are core target-state trust controls.

### D. Billing remains correct

The solution is invalid if it makes billing depend on stale or missing identity preparation data.

## In scope

- billing-safe analysis preflight based on repository + period + contributor scope rather than manual dedup UI
- canonical alias ingestion from analysis signals
- conservative deterministic auto-resolution
- canonical merge/unmerge workflow hardening where needed
- removing manual raw-developer review from the default analysis path
- keeping contributor selection as an analysis-scope control
- routing trust review into `People` / identity queue
- tests for billing-safe preflight and canonical identity actions touched by the slice

## Out of scope

- full route rename away from `/orders/*`
- full replacement of legacy run engine
- PR/work-item modeling
- schedules / reports work
- full diagnostics hub
- full org model rollout beyond workspace

## Allowed write scope

- `packages/server/src/app/[locale]/(dashboard)/orders/**`
- `packages/server/src/app/api/orders/**`
- `packages/server/src/app/api/v2/contributors/**`
- `packages/server/src/app/[locale]/(dashboard)/people/**`
- `packages/server/src/lib/services/**`
- `packages/server/src/lib/schemas/**`
- `packages/server/messages/en.json`
- `packages/server/messages/ru.json`
- tests adjacent to the touched files

## Hard rules

- Do not weaken credit estimation or reservation correctness.
- Do not auto-merge fuzzy matches into canonical contributors.
- Do not make manual merge / unmerge disappear.
- Do not keep manual raw developer dedup in the default customer path.
- Do not remove the user's ability to analyze only a subset of contributors.
- Do not make new People surfaces depend on legacy order-local JSON as their business contract.

## Acceptance criteria

- a new customer can run analysis without a mandatory raw developer dedup step
- billing is still reserved safely before analysis starts for the selected repository + period + contributor scope
- canonical contributor projection no longer depends on customer-authored manual dedup as the normal path
- the user can still include/exclude contributors before analysis and see price impact
- unresolved/suggested identity review is available through canonical contributor surfaces
- manual merge / unmerge still exists on canonical identity surfaces
- typecheck and relevant tests pass

## Validation expectations

- tests for billing-safe preflight behavior
- tests for conservative auto-resolution policy
- tests for merge / unmerge / alias resolution paths touched by the slice
- smoke:
  - run analysis on a public repo
  - run analysis on a connected/private repo
  - confirm no mandatory raw dedup screen
  - confirm contributor inclusion/exclusion changes estimated credits
  - confirm unresolved identity issues are reviewable in `People`
  - confirm merge / unmerge still works

## Expected outcome

After this slice, the product should behave like:

```text
Analyze repositories
  -> choose included contributors
  -> get results
  -> review canonical contributors if needed
  -> merge/unmerge on People/Curation surfaces
```

That is the target model implied by the refactor docs, and it removes the wrong identity layer from the customer journey instead of hiding it cosmetically.
