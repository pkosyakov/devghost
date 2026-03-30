# Screen Spec: Global Context Bar

## Purpose

Provide one shared scope control for the primary analytics experience.

This component must answer:

- what scope am I currently looking at;
- what date range is active;
- whether this scope came from a saved view or is an unsaved ad hoc variant.

## Primary persona

- Engineering Manager
- Director of Engineering
- Tech Lead

## Scope source

Source of truth:

- `ActiveScope`

Slice 4 note:

- in v1 the current unsaved scope is URL-backed;
- saved-view activation hydrates the same `ActiveScope` shape.

## Key controls

- scope selector (`All Teams`, `Team`, `SavedView`)
- date range picker
- optional secondary-filter indicator
- `Save View` action
- dirty-state indicator when current scope diverges from the activated saved view

## Behavioral rules

- changing the scope selector updates shared route/query state;
- changing date range updates shared route/query state;
- activating a saved view updates the same controls instead of opening a detached sub-app;
- entity-detail routes keep their canonical route identity and either synchronize or navigate when scope selection would otherwise conflict.

## Acceptance criteria

- one shared control drives multiple primary analytics screens;
- there is no duplicate unsynced date-range UI on participating screens;
- the control makes it obvious whether the user is in an ad hoc scope or a saved view.
