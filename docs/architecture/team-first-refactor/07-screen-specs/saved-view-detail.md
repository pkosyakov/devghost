# Screen Spec: Saved View Detail

## Purpose

Explain and manage one reusable saved analytical scope.

This screen must answer:

- what this saved view includes;
- who can see it;
- what will happen if I activate it;
- whether it is linked to future schedules or dashboards.

## Primary persona

- Engineering Manager
- Director of Engineering

Secondary persona:

- Analytics Admin

## Scope source

Base identity comes from:

- `savedViewId` in the route

Slice 4 note:

- until `Organization` exists in production, saved view identity is resolved inside the authenticated user's `Workspace`;
- schedules and dashboards may still be empty or deferred in Slice 4.

## Key widgets

- saved view header
- scope summary
- filter summary
- visibility controls
- activate button
- archive / restore controls
- linked schedules / linked dashboards placeholders

## Data dependencies

Read model:

- `SavedViewDetail`

Suggested sections:

- `savedView`
- `resolvedScope`
- `visibility`
- `shareMetadata`
- `linkedSchedules`
- `linkedDashboards`

## Actions

- activate saved view into the global context bar
- update scope definition
- update filter definition
- change visibility
- archive / restore

## States

- loading: saved view detail pending
- empty: linked schedules/dashboards absent
- error: failed to load saved view

## Acceptance criteria

- saved view detail makes the resolved scope explicit;
- activating the saved view updates shared scope rather than opening a detached route context;
- schedules/dashboard links may be empty in Slice 4, but the screen must not pretend they already exist.
