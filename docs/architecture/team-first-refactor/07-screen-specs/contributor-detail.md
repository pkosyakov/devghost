# Screen Spec: Contributor Detail

## Purpose

Explain one contributor's activity across repositories and teams, and expose the identity context needed to trust that attribution.

This screen must answer:

- who is this contributor really;
- which teams are they associated with;
- which repositories were they active in;
- which delivery evidence is currently available for this contributor;
- what commit-level evidence supports that view.

Target state:

- PRs are the primary delivery surface.

Slice 1 constraint:

- if canonical PR data is not available yet, the screen should ship as a clear commit-centric partial implementation instead of inventing fake PR groupings.

## Primary persona

- Engineering Manager
- Tech Lead

Secondary persona:

- Analytics Admin

## Scope source

Base identity comes from:

- `contributorId` in the route

Analytical framing comes from:

- active date range from global context bar
- optional inherited scope filters from current `Team` or `SavedView`

## Key widgets

- contributor header: name, primary email, classification, primary team
- identity health panel
- alias list
- membership summary / timeline
- KPI summary
- repository breakdown table
- PR activity table (target state; optional placeholder in Slice 1)
- potential matches panel (unresolved aliases that may belong to this contributor)
- commit evidence panel (loaded separately, paginated via dedicated endpoint)

## Data dependencies

Read model:

- `ContributorDetail`

Suggested sections:

- `contributor`
- `aliases`
- `membershipTimeline`
- `summaryMetrics`
- `repositoryBreakdown`
- `pullRequests` (optional in Slice 1 if canonical PR data is not available yet)
- `identityHealth`
- `potentialMatches` (unresolved aliases with shared email domain or order context; may be empty)

Note: `commitEvidence` is NOT part of the detail read model. It is served via a separate paginated endpoint (`GET /api/v2/contributors/:id/commits`).

Suggested repository breakdown fields:

- `repositoryId`
- `fullName`
- `pullRequestCount`
- `commitCount`
- `effortSummary`
- `lastActivityAt`

Suggested PR fields:

- `pullRequestId`
- `title`
- `repository`
- `state`
- `createdAt`
- `mergedAt`
- `reviewSummary`
- `linkedWorkItems`

## Actions

Identity actions:

- merge alias into contributor
- unmerge contributor
- classify as bot/external
- exclude/include contributor

Navigation actions:

- open repository detail from breakdown
- open PR detail/evidence
- return to people list retaining scope

## States

- loading: contributor detail pending
- empty: contributor exists but has no activity in selected period
- error: failed to load detail
- partial-data: PR data unavailable or incomplete, but repository breakdown and commit evidence are available; freshness delayed

## Acceptance criteria

- contributor detail is cross-repo by default
- alias information is visible enough to support trust and curation
- team membership is shown as contributor context, not the sole source of truth
- target-state model remains PR-first, but Slice 1 may ship without a real PR table
- if Slice 1 ships without PR data, commit evidence and repository breakdown must be explicit and trustworthy rather than pretending to be PR analytics
- repository breakdown is period-aware and responds to global date-range changes
- identity actions route through canonical contributor/alias contracts rather than legacy order-local mappings
