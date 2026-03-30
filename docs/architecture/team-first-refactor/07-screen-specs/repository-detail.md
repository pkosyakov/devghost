# Screen Spec: Repository Detail

## Purpose

Explain one repository's current operating state and delivery activity without forcing the user to inspect legacy analysis runs.

This screen must answer:

- is this repository fresh enough to trust;
- who was active in it during the selected period;
- which pull requests define the main delivery flow;
- what anomalies or data gaps need attention.

## Primary persona

- Tech Lead
- Repository Owner

Secondary persona:

- Engineering Manager
- Analytics Admin

## Scope source

Base identity comes from:

- `repositoryId` in the route

Target-state analytical framing comes from:

- active date range from global context
- optional inherited scope filters from current `Team` or `SavedView`

Rule:

- the repository detail remains repository-local even when entered from a team or saved-view context.

Slice 2 note:

- until `Team`, `SavedView`, and global context are live, repository detail is resolved inside the authenticated user's `Workspace`;
- the route identity must still be canonical `repositoryId`, not order ID;
- future context layering must not force a route redesign.

## Key widgets

- repository header: full name, provider, default branch, connection state
- freshness panel
- KPI summary
- PR activity table (target-state; optional or explicitly unavailable in Slice 2)
- contributor table
- recent activity / commit evidence panel
- anomalies / warnings panel
- rules and exclusions summary

## Data dependencies

Read model:

- `RepositoryDetail`

Suggested sections:

- `repository`
- `freshness`
- `summaryMetrics`
- `pullRequests`
- `contributors`
- `recentCommitEvidence` (allowed in Slice 2 as supporting evidence)
- `anomalies`
- `rulesAndExclusions`

Suggested contributor row fields:

- `contributorId`
- `displayName`
- `classification`
- `pullRequestCount`
- `commitCount`
- `lastActivityAt`

Suggested PR fields:

- `pullRequestId`
- `title`
- `state`
- `author`
- `createdAt`
- `mergedAt`
- `reviewSummary`
- `linkedWorkItems`

Slice 2 requirement:

- if canonical PR data is not yet available, the detail screen must still ship with `freshness`, `summaryMetrics`, `contributors`, and repository-local activity evidence;
- commit-backed activity panels must not be mislabeled as canonical PRs.

## Actions

Navigation actions:

- open contributor detail from contributor table
- open PR detail or evidence drill-down
- open data health / diagnostics when freshness is degraded

Operational actions:

- inspect repository-local anomalies
- review repository-specific rules and exclusions summary

## States

- loading: repository detail pending
- empty: repository exists but has no activity in selected period
- error: failed to load detail
- partial-data: freshness available but PR or contributor sections are incomplete

## Acceptance criteria

- repository detail is addressed by canonical repository identity, not by order ID
- freshness is visible enough to judge trust without exposing snapshot/job IDs as the primary UI
- PRs are the primary delivery list in the target architecture; in Slice 2 the PR section may be empty or unavailable if canonical PR data does not exist yet
- commits remain supporting evidence and must not be presented as fake PRs
- contributors shown on this page are canonical contributors in repository-local context
- repository detail responds to date-range changes without losing repository identity
- legacy run/order concepts appear only through diagnostics links, not as the page's main information architecture
