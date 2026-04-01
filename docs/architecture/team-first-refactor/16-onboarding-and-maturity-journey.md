# Onboarding and Maturity Journey

## Purpose

This document defines the intended customer journey for a new DevGhost workspace.

It exists to solve a specific product problem:

- the refactor has produced strong business entities (`Contributor`, `Repository`, `Team`, `SavedView`);
- but without an orchestrated journey, the product can still feel like a set of disconnected screens.

This doc defines:

- what a new customer should see first;
- what the primary next step is at each maturity stage;
- when each major analytical surface becomes meaningful;
- how this journey should be sequenced relative to delivery slices.

## Core principle

The customer should never have to infer the product flow from the navigation.

At any moment the product should answer:

1. where they are;
2. what the system already knows;
3. what the single best next step is.

## Journey stages

### Stage 0: Empty workspace

Definition:

- no meaningful data is available yet;
- no completed analysis exists, or no usable `Contributor` / `Repository` data has been projected.

What the customer should see:

- an onboarding version of `Home`;
- a short explanation of what DevGhost does;
- a simple checklist;
- one primary CTA.

Primary CTA:

- `Connect repositories` or `Run first analysis`, depending on the current system entrypoint.

What not to show:

- empty operational dashboards;
- advanced filters;
- `Reports` as if reusable scopes already exist;
- `Teams` as the first required concept.

### Stage 1: First data available

Definition:

- at least one completed analysis exists;
- contributors and repositories are visible;
- the customer has not yet formed a stable management scope.

What the customer should see:

- a transitional `Home`;
- counts such as contributors found, repositories found, identities needing attention;
- a guided next-step sequence.

Primary next step:

- `Review contributors`

Why:

- this is the first trust checkpoint;
- if identity is wrong, all downstream team and repository views will feel unreliable.

Secondary next step:

- `Check repositories`

Why:

- the customer should confirm that the important repositories are present and fresh before building management views on top.

### Stage 2: First management scope

Definition:

- contributor and repository data are usable;
- the customer is ready to define a stable managerial lens.

What the customer should do:

1. create the first `Team`;
2. add members;
3. review activity-derived repositories;
4. open team detail.

Why this stage matters:

- this is where DevGhost stops feeling like a git analytics utility and starts feeling like an engineering management product.

Primary CTA:

- `Create first team from repository`

Important UX rule:

- the first team flow should be guided, not an empty form.

Preferred onboarding pattern:

- the customer starts from a familiar `Repository`;
- the system creates a draft team seeded from that repository;
- suggested members come from recent contributor activity in that repository;
- the customer then edits and confirms the team;
- after creation, the `Team` becomes an independent management object.

Important modeling rule:

- `Team` is not the same thing as `Repository`;
- repository-based creation is a bootstrap path, not a permanent one-to-one mapping.

### Stage 3: Operational workspace

Definition:

- at least one real team exists;
- the customer can move across `Home`, `Teams`, `People`, and `Repositories` under a meaningful scope.

What the customer should see:

- the operational version of `Home`;
- global scope controls;
- highlights and activity summaries under the active scope.

Primary next step:

- refine the active scope and use it in day-to-day analysis.

Important rule:

- `Reports` and `SavedView` become meaningful only after the customer has already experienced value in a live scope.

### Stage 4: Reusable reporting

Definition:

- the customer has one or more useful scopes they expect to revisit.

What the customer should do:

- save the current scope as a `SavedView`;
- reuse it from `Reports`;
- later receive scheduled delivery.

Primary CTA:

- `Save this view`

Why:

- reporting should emerge from a useful operational scope;
- it should not be introduced before the customer understands what they want to save.

## Ideal new-customer flow

```text
Home
  -> Connect repositories / Run first analysis
  -> Analysis Results
  -> People review
  -> Repositories review
  -> Create first team from repository
  -> Team detail
  -> Save first view
  -> Reports
```

## Role of each major surface in the journey

### `Home`

Role:

- orchestrator of the next best action.

Important rule:

- `Home` must change by maturity stage;
- it must not be the same screen for empty, transitional, and operational workspaces.

### `Analysis Results`

Role:

- first value moment after a completed analysis.

Use it when:

- the customer needs to see what the completed analysis found before moving into canonical workspace curation and management surfaces;
- the product needs to explain the result of one analysis run without forcing the customer through infrastructure-heavy legacy UI.

Important rule:

- `Analysis Results` may remain analysis-scoped, but it must hand off clearly into canonical `People`, `Repositories`, and first-team creation;
- it is a transitional insight surface, not the main long-term workspace home.

### `People`

Role:

- first trust checkpoint.

Use it when:

- the customer needs to confirm who the system thinks exists;
- identity issues must be reviewed before deeper analysis.

### `Repositories`

Role:

- coverage and freshness checkpoint.

Use it when:

- the customer needs to confirm the important repositories are present and fresh.

Secondary onboarding role:

- bootstrap surface for first-team creation.

### `Teams`

Role:

- first real management workspace.

Use it when:

- the customer is ready to see contributors and repositories grouped into a stable analytical scope.

### `Reports`

Role:

- reusable and shareable scope library.

Use it when:

- the customer already has a scope worth saving.

## UX rules

### One primary CTA per stage

At every maturity stage there should be one obvious best next step.

### Do not expose advanced concepts too early

Specifically:

- do not lead a new customer into `Reports`;
- do not make `Team` the first required configuration step before trust is established;
- do not show empty complex analytics when the product should instead guide setup.

### Use familiar objects to bootstrap abstract ones

For first-time setup:

- prefer starting from a known `Repository` to create the first `Team`;
- then let the customer refine the team into a durable management scope.

### Trust before management before reporting

The product order should be:

1. trust the data;
2. define a management scope;
3. save and reuse the scope.

## Sequencing relative to slices

### Decision

This journey should be frozen now, not after Slice 5.

### Why

- it is a product orchestration layer, not a late-stage data-model feature;
- if delayed too long, individual slices will keep shipping as disconnected surfaces;
- `Home`, empty states, and entry CTAs should already start aligning with this journey before the deeper target-state model is complete.

### Recommended implementation timing

#### Immediately after Slice 4

Lock the vision and use it as the source of truth for:

- `Home` behavior;
- empty states;
- screen help copy;
- navigation guidance;
- first-run CTAs.

#### Between Slice 4 and Slice 5

Implement the first practical version:

- maturity-aware `Home`;
- onboarding checklist;
- guided first-team creation from repository entrypoint;
- clearer transitions from `People` to `Repositories` to `Teams`.

#### Slice 5 and later

Use curation and diagnostics to strengthen the trust stage:

- unresolved identities;
- exclusions;
- data health messaging.

Later slices may deepen the journey with:

- schedules;
- PR and work-item driven guidance;
- initiative and investment narratives.

## Product recommendation

Treat this journey as a cross-slice orchestration track, not as a post-Slice-5 afterthought.

Practical recommendation:

- freeze it now;
- begin implementation after Slice 4 foundation is stable;
- continue refining it through Slice 5 and later slices.
