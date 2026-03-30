# Screen Spec: Repository List

## Purpose

Give tech leads, managers, and admins a stable catalog of tracked repositories so they can:

- browse repositories without opening order history;
- detect stale or delayed data early;
- drill into one repository as an operational surface;
- understand which repositories are active in the current scope.

## Primary persona

- Tech Lead
- Analytics Admin

Secondary persona:

- Engineering Manager

## Scope source

Target-state source is derived from the global analytical context:

- organization
- active scope (`All Teams`, `Team`, or `SavedView`)
- date range
- optional secondary filters

Slice 2 note:

- until the full global context bar is live, the active boundary is the authenticated user's `Workspace`;
- repository list must be usable without `Team`, `SavedView`, or persistent global context;
- future scope controls can wrap this screen later without changing the repository row contract.

## Key widgets

- page header with current scope summary
- summary strip: repository count, fresh/delayed/stale counts
- repository table/list
- freshness status filter
- provider filter
- health/risk badge column
- quick drill-down action into repository detail

## Data dependencies

Read models:

- `RepositorySummaryRow[]`

Slice 2 requirement:

- `RepositorySummaryRow[]` must be available in a workspace-scoped mode without requiring `ActiveScope`.

Suggested repository row fields:

- `repositoryId`
- `fullName`
- `provider`
- `defaultBranch`
- `lastUpdatedAt`
- `freshnessStatus`
- `activeContributorCount`
- `activePrCount` (optional / nullable in Slice 2 if canonical PR data is not available yet)
- `activeCommitCount` (allowed in Slice 2 as supporting activity signal)
- `healthStatus`

Suggested list summary values:

- `repositoryCount`
- `freshCount`
- `delayedCount`
- `staleCount`

## Actions

Per-screen actions:

- search repositories
- filter by freshness/provider/health
- sort by repository name, last updated time, active contributor count, PR count

Per-row actions:

- open repository detail
- open data health context when freshness is degraded

## States

- empty: no repositories in current scope
- loading: initial query or scope change
- error: failed to load repository list
- partial-data: list available but freshness derivation is incomplete for some repositories

## Acceptance criteria

- one row represents one canonical repository, not one legacy order occurrence
- freshness is visible in business terms and does not require job/run IDs
- changing active scope updates the list without changing screen type
- list contract is paginated and sortable by explicit domain fields
- repository list does not expose `selectedRepos` JSON as the business-facing frontend contract
- repository list can ship in Slice 2 without `Team` or `SavedView`, using `Workspace` as the current production boundary
