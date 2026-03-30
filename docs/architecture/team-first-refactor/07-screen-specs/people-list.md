# Screen Spec: People List

## Purpose

Give managers and admins a canonical directory of tracked contributors so they can:

- browse people in the current scope;
- detect identity quality problems early;
- move from team-level analytics into person-level detail;
- start curation actions without touching legacy alias blobs or run-specific data.

## Primary persona

- Engineering Manager
- Analytics Admin

Secondary persona:

- Tech Lead

## Scope source

Derived from the global context bar:

- organization
- active scope (`All Teams`, `Team`, or `SavedView`)
- date range
- optional secondary filters

## Key widgets

- page header with active scope summary
- summary strip: contributor count, unresolved identity count, excluded count
- contributor table/list
- unresolved identity queue section or summary entrypoint
- identity health badge/filter
- classification filter (`internal`, `external`, `bot`, `former employee`)
- quick actions menu per contributor row

## Data dependencies

Read models:

- `ActiveScope`
- `ContributorSummaryRow[]`
- `IdentityQueueSummary`

Suggested contributor row fields:

- `contributorId`
- `displayName`
- `primaryEmail`
- `classification`
- `primaryTeam`
- `teamCount`
- `activeRepositoryCount`
- `lastActivityAt`
- `identityHealth`
- `summaryMetrics`

Suggested identity queue summary:

- `unresolvedAliasCount`
- `suggestedMergeCount`
- `recentlyClassifiedBotCount`

## Actions

Per-screen actions:

- search contributors
- filter by team/classification/identity health
- filter unresolved identities inside the main people surface
- sort by recent activity, repository count, contributor name

Per-row actions:

- open contributor detail
- exclude/include contributor
- mark contributor external
- open alias/identity review

## States

- empty: no contributors in current scope
- loading: initial query or scope change
- error: failed to load contributor list
- partial-data: freshness delayed or identity queue unavailable

## Acceptance criteria

- one row represents one canonical contributor, never one alias
- changing active scope updates the list without changing screen type
- unresolved identity health is visible from the list, not buried in settings
- in Slice 1, unresolved aliases are exposed as an inline summary/section/filter on People List rather than requiring a separate page
- row actions do not require access to legacy `selectedDevelopers` or `developerMapping`
- list contract is paginated and sortable by explicit domain fields
