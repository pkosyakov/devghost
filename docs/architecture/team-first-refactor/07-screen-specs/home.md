# Screen Spec: Home

## Purpose

Act as the scope-aware landing surface for the primary analytics experience.

This screen must answer:

- what is happening in my current analytical scope right now;
- which teams, contributors, and repositories deserve attention next;
- whether I should save or reuse this scope.

## Primary persona

- Engineering Manager
- Director of Engineering

Secondary persona:

- Tech Lead

## Scope source

Base analytical framing comes from:

- `ActiveScope` via the global context bar

Slice 4 note:

- existing `/dashboard` becomes this screen;
- until `Organization` exists in production, scope is resolved inside the authenticated user's `Workspace`.

## Key widgets

- global context bar
- KPI summary
- top teams panel
- top contributors panel
- top repositories panel
- freshness / trust summary
- save-current-scope affordance

## Data dependencies

Read model:

- `HomeDetail`

Suggested sections:

- `resolvedScope`
- `summaryMetrics`
- `topTeams`
- `topContributors`
- `topRepositories`
- `freshnessSummary`
- `saveViewState`

## Actions

- change scope in the global context bar
- save current scope as a saved view
- open team / contributor / repository drill-down
- activate an existing saved view

## States

- empty: scope exists but has no meaningful activity
- loading: home summary pending
- error: failed to load scope-aware home data
- partial-data: analytics available but freshness/trust indicators warn about gaps

## Acceptance criteria

- `/dashboard` is driven by `ActiveScope`, not legacy order counts;
- changing shared scope changes the home payload;
- save-current-scope affordance is visible when the current scope is not already a matching saved view;
- the home screen does not reintroduce `Order` as the primary business object.
