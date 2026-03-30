# Screen Spec: Team Detail

## Purpose

Act as the default management workspace for a single team.

This screen must answer:

- what is happening in this team right now;
- who is in the team;
- which repositories are consuming the team's effort in the selected period;
- whether the team's data is trustworthy enough to act on.

## Primary persona

- Engineering Manager
- Tech Lead

Secondary persona:

- Director of Engineering
- Analytics Admin

## Scope source

Base identity comes from:

- `teamId` in the route

Target-state analytical framing comes from:

- active date range from global context
- optional inherited scope filters from current `SavedView`

Slice 3 note:

- until `SavedView` and the global context bar exist, team detail is resolved inside the authenticated user's `Workspace`;
- date range may be carried as local query params in Slice 3;
- the route identity must be canonical `teamId`, not order ID or repository ID.

## Key widgets

- team header
- KPI summary
- people section
- repositories section
- optional pull request section (explicitly unavailable is allowed in Slice 3)
- warnings / trust indicators
- settings or management affordances for memberships

## Data dependencies

Read model:

- `TeamDetail`

Suggested sections:

- `team`
- `scopeInfo`
- `summaryMetrics`
- `contributors`
- `repositories`
- `topPullRequests`
- `warnings`

Suggested contributor row fields:

- `contributorId`
- `displayName`
- `classification`
- `isPrimaryTeam`
- `commitCount`
- `lastActivityAt`

Suggested repository row fields:

- `repositoryId`
- `fullName`
- `freshnessStatus`
- `activeCommitCount`
- `activeContributorCount`
- `lastActivityAt`

Slice 3 requirement:

- if canonical PR data is not yet available, the detail screen must still ship with `summaryMetrics`, `contributors`, and activity-derived `repositories`;
- commit-backed sections must not be mislabeled as canonical PRs;
- repository lists must be derived from member activity, not only static assignment.

## Actions

Navigation actions:

- open contributor detail
- open repository detail

Management actions:

- create team
- update team metadata
- add/remove contributor membership
- set membership effective dates
- set/unset primary team membership

## States

- loading: team detail pending
- empty: team exists but has no configured members or no activity in the selected period
- error: failed to load team detail
- partial-data: team exists but some contributors are unresolved or repository derivation is incomplete

## Acceptance criteria

- team detail is addressed by canonical team identity, not by order ID
- team detail is workspace-scoped in Slice 3
- contributors shown are canonical contributors in team-local context
- repositories shown are derived from contributor activity in the selected period
- route/query state may control date range locally until global context exists
- legacy order/run concepts appear only through diagnostics links, not as the page's main information architecture
