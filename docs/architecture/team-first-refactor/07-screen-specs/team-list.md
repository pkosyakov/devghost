# Screen Spec: Teams List

## Purpose

Give managers and leads a stable entry point into team-scoped analytics without making them build context repo-by-repo.

This screen must answer:

- which teams exist in my current workspace;
- which teams are active right now;
- which team should I open next.

## Primary persona

- Engineering Manager
- Director of Engineering

Secondary persona:

- Tech Lead
- Analytics Admin

## Scope source

Base identity comes from:

- authenticated user's `Workspace`

Target-state analytical framing comes from:

- global context bar

Slice 3 note:

- until `Organization`, `SavedView`, and the global context bar are live, this screen is resolved only inside the authenticated user's `Workspace`;
- date range and sorting may live in local route/query state in Slice 3.

## Key widgets

- page header with create-team CTA
- summary strip
- search/filter/sort controls
- teams table or cards
- empty state with setup CTA

## Data dependencies

Read model:

- `TeamSummaryRow[]`

Suggested row fields:

- `teamId`
- `name`
- `memberCount`
- `activeRepositoryCount`
- `activeContributorCount`
- `lastActivityAt`
- `healthStatus`

Suggested summary values:

- `teamCount`
- `activeTeamCount`
- `memberedContributorCount`

## Actions

Per-screen actions:

- search teams
- sort by name, member count, active repositories, last activity
- create team

Per-row actions:

- open team detail
- edit team metadata (allowed inline or via detail/settings)

## States

- empty: no teams configured in current workspace
- loading: teams list pending
- error: failed to load teams
- filtered-empty: no teams match current filters

## Acceptance criteria

- one row represents one canonical team, not a saved filter blob
- list is workspace-scoped in Slice 3
- user can discover and open a team without touching repository-first navigation
- list does not depend on legacy `Order` as the business-facing object
