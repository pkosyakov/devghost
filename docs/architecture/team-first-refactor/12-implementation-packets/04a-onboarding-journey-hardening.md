# Slice 4A: Onboarding Journey Hardening

## Goal

Turn the current set of post-Slice-4 surfaces into a coherent new-customer journey.

This slice does not add new core business entities.

It fixes the orchestration gap between:

- onboarding `Home`
- first analysis
- analysis results
- `People`
- `Repositories`
- first `Team`
- first `SavedView`

The objective is simple:

- at each stage the customer should understand the single best next step;
- advanced concepts should not appear before they are meaningful;
- the product should feel like one guided flow, not a set of disconnected pages.

## Why this exists

After Slices 1-4, DevGhost has the right entities:

- `Contributor`
- `Repository`
- `Team`
- `SavedView`

But the user journey still has important gaps:

- advanced chrome is visible too early;
- `Reports` and `Teams` are exposed before they are meaningful for a new customer;
- first analysis results do not clearly hand off into `People`, `Repositories`, and first-team creation;
- first-team creation exists, but the path into it is still too hidden;
- first `SavedView` is supported, but not turned into an explicit next step.

## Required outcomes

### 1. Stage-appropriate primary UX

`/dashboard` must continue to behave by workspace maturity, but the surrounding chrome must also respect maturity.

Rules:

- `empty` and `first_data` should not feel like operational workspace mode;
- advanced scope controls should be hidden, suppressed, or simplified where they would confuse a new customer;
- `Reports` should not be positioned as a primary concept before the first saved view exists.

### 2. First-analysis handoff

After a customer creates the first analysis and lands on analysis results, the screen must provide an explicit next-step path into:

1. `People`
2. `Repositories`
3. `Create first team from repository`

The analysis results screen should still serve experienced users, but first-run customers must not be forced to infer what to do next.

### 3. Repository-driven first-team bootstrap

The product decision is already frozen:

- the preferred first-team path is `Create team from repository`;
- `Team` remains independent from `Repository`.

This slice must make that path easier to discover from the repository surfaces, not only from a deep detail page.

### 4. First-saved-view handoff

After the first team exists, the product must explicitly guide the customer to save the first useful scope.

This should feel like:

- “you now have a real management scope”
- “save this view so you can return to it”

not:

- “figure out that Save View exists in the chrome”

## In scope

- onboarding-oriented UX hardening on `Home`
- maturity-aware suppression or simplification of advanced chrome
- first-analysis results handoff UX
- repository-to-team bootstrap discoverability improvements
- first-team-to-first-saved-view guidance
- customer-facing copy and CTA changes required to support the above

## Out of scope

- backend/domain rename of `Order`
- route rename away from `/orders/*`
- new schema/entities
- public report sharing
- scheduled report delivery
- curation/diagnostics work from Slice 5
- rebuilding analysis charts/metrics semantics

## Key constraints

- current production boundary is still `Workspace`
- keep reusing canonical `Contributor`, `Repository`, `Team`, and `SavedView`
- do not regress current scope behavior for mature workspaces
- do not reintroduce order-centric dashboard semantics
- do not make first-team creation a manual-only form

## Recommended implementation areas

### A. Maturity-aware chrome

Potential implementation shapes are acceptable if they meet the product goal.

Examples:

- suppress `GlobalContextBar` on `empty` and `first_data`
- hide or de-emphasize `Reports` until at least one saved view exists
- optionally de-emphasize `Teams` before first meaningful team setup

### B. Analysis results onboarding card

On completed analysis results, add an onboarding handoff card for first-run customers.

Preferred actions:

- `Review contributors`
- `Check repositories`
- `Create first team from repository`

This can be conditional on workspace maturity so mature users are not spammed.

### C. Repository bootstrap discoverability

Improve repository surfaces so a new customer can find the first-team path quickly.

Examples:

- recommended-repository card on repository list
- prominent onboarding CTA on repository list
- stronger framing around repository detail CTA

### D. First saved view prompt

Once at least one team exists and zero saved views exist, the product should drive the customer toward saving the first view.

The CTA should be explicit and near the actual useful scope, not hidden behind abstract wording.

## Acceptance criteria

- a new user does not see the full operational chrome on `empty` and `first_data` stages
- after first analysis, there is an explicit path from analysis results into `People`, `Repositories`, and first-team creation
- first-team creation is discoverable without requiring deep manual exploration
- after first team creation, the product clearly guides the user to save the first useful scope
- mature workspaces still retain the operational experience
- no schema changes are introduced

## Expected deliverables

- UX changes across onboarding-related screens
- customer-facing copy updates where needed
- tests for any new stage logic or route-level gating introduced
- short report of what changed in the onboarding path
