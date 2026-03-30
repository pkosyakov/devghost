# Screen Spec: Saved View List

## Purpose

Act as the `Reports` library entry surface for reusable saved analytical scopes.

This screen must answer:

- which saved views exist in my current workspace;
- which one should I activate or edit next;
- which saved views are private vs workspace-visible.

## Primary persona

- Engineering Manager
- Director of Engineering

Secondary persona:

- Analytics Admin

## Scope source

Base identity comes from:

- authenticated user's `Workspace`

Target-state analytical framing comes from:

- optional current `ActiveScope` if creating a new saved view from current context

## Key widgets

- page header with create-saved-view CTA
- saved view list/table
- visibility badges
- owner column
- scope preview
- quick activate action

## Data dependencies

Read model:

- `SavedViewSummaryRow[]`

Suggested row fields:

- `savedViewId`
- `name`
- `visibility`
- `scopeKind`
- `teamCount`
- `repositoryCount`
- `owner`
- `updatedAt`

## Actions

- create saved view from current scope
- activate saved view into the global context bar
- open saved view detail
- archive / restore saved view

## States

- empty: no saved views exist yet
- loading: reports library pending
- error: failed to load saved views
- filtered-empty: no saved views match current search/filter

## Acceptance criteria

- `Reports` is a reusable scope library, not a parallel reporting mini-app;
- one row represents one canonical saved view;
- activating a saved view updates `ActiveScope`;
- the library remains workspace-scoped until `Organization` exists in production.
