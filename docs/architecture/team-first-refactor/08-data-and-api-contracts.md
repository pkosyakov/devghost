# Data and API Contracts

This document defines the target read/write contract layer for the refactor.

## Purpose

Give builder-AI and future frontend work a stable business-facing API model that does not depend on legacy `Order` semantics.

## Core contract principle

New surfaces must depend on **domain read models**, not directly on legacy processing tables or JSON blobs.

The domain contract layer may be backed by:

- new tables;
- facade queries over legacy data;
- anti-corruption translation from legacy snapshots.

But the caller should see only business objects.

## Contract layers

### 1. Scope resolution layer

Purpose:

- resolve the current analytical scope before screen-specific queries run.

Canonical concept:

`ActiveScope`

Suggested shape:

```ts
type ScopeKind = 'all_teams' | 'team' | 'saved_view';

interface ActiveScope {
  organizationId: string;
  scopeKind: ScopeKind;
  scopeId: string | null;
  dateRange: {
    preset: string | null;
    start: string | null;
    end: string | null;
  };
  secondaryFilters: {
    repositoryIds?: string[];
    contributorIds?: string[];
    labels?: string[];
    services?: string[];
  };
}
```

Rules:

- all P0 analytical screens consume the same resolved scope shape;
- activating a saved view populates this shape;
- unsaved ad hoc state can also populate this shape.

### 2. Summary read models

Purpose:

- provide compact cards/tables/lists for top-level screens.

#### Team summary row

Use for:

- teams list
- team switchers
- home highlights

Suggested fields:

- `teamId`
- `name`
- `memberCount`
- `activeRepositoryCount`
- `activeContributorCount`
- `lastActivityAt`
- `healthStatus`
- `summaryMetrics`

#### Contributor summary row

Use for:

- people list
- team people tab

Suggested fields:

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

#### Repository summary row

Use for:

- repository list
- team repositories tab

Suggested fields:

- `repositoryId`
- `fullName`
- `provider`
- `defaultBranch`
- `lastUpdatedAt`
- `freshnessStatus`
- `activeContributorCount`
- `activePrCount`
- `healthStatus`

### 3. Detail read models

Purpose:

- provide full business-facing payloads for major entity pages.

#### Team detail

Should include:

- `team`
- `scopeInfo`
- `summaryMetrics`
- `topPullRequests`
- `contributors`
- `repositories`
- `healthPanels`
- `reportLinks`

#### Contributor detail

Should include:

- `contributor`
- `aliases`
- `membershipTimeline`
- `summaryMetrics`
- `repositoryBreakdown`
- `pullRequests` (target-state; optional or empty in Slice 1)
- `identityHealth`
- `potentialMatches` (unresolved aliases with shared email domain or order context; may be empty)

Note: `commitEvidence` is NOT part of the detail payload. It is served via a separate paginated endpoint (`GET /api/v2/contributors/:id/commits`).

Slice 1 note:

- `ContributorDetail` may ship before canonical PR modeling exists;
- in that case, `repositoryBreakdown` and `identityHealth` are required in the detail response;
- `commitEvidence` is served via a separate paginated endpoint (`GET /api/v2/contributors/:id/commits`), not inlined in the detail payload — commits can number in hundreds and would make the detail response too heavy;
- `pullRequests` may be omitted, empty, or explicitly marked unavailable.

#### Repository detail

Should include:

- `repository`
- `freshness`
- `summaryMetrics`
- `pullRequests`
- `contributors`
- `anomalies`
- `rulesAndExclusions`

#### Saved view detail

Should include:

- `savedView`
- `resolvedScope`
- `visibility`
- `shareMetadata`
- `linkedSchedules`
- `linkedDashboards`

#### Data health detail

Should include:

- organization-level freshness summary
- repository freshness rows
- sync gaps
- recent snapshot/activity statuses
- allowed actions: reprocess, retry, inspect

## Write action contracts

### Contributor identity actions

Required actions:

- `merge contributors`
- `unmerge contributors`
- `assign alias to contributor`
- `mark alias as bot`
- `mark contributor as external`
- `exclude / include contributor`

Required behavior:

- writes must produce audit records;
- writes must invalidate affected contributor/team/repo aggregates only.

### Team actions

Required actions:

- create team
- update team metadata
- add/remove contributor membership
- set membership effective dates
- set/unset primary team
- pin/exclude repository for team

### Saved view actions

Required actions:

- create saved view
- update scope definition
- update filter definition
- set visibility
- share
- archive / restore

### Schedule actions

Required actions:

- create schedule
- pause / resume
- update cadence
- update recipients/channel
- resend or inspect recent report run

### Curation actions

Required actions:

- exclude/include contributor
- exclude/include repository
- exclude/include pull request
- exclude/include commit
- classify bot/external
- create/update rule-based exclusions

## Query semantics

### Pagination

All list surfaces should support:

- `cursor` or `page`
- `pageSize`

Do not hardcode list screens to full-table fetches.

### Sorting

Every list contract should define an explicit sortable field set.

No screen should accept arbitrary database field names directly from the UI.

### Filtering

Filtering should accept domain concepts only:

- team
- repository
- contributor
- classification
- identity health
- freshness status
- date range

Avoid leaking legacy storage concepts like:

- `orderId`
- `selectedRepos`
- `selectedDevelopers`
- snapshot-local mapping blobs

## Freshness and data health contract

Primary surfaces must not depend on raw job objects, but they do need freshness data.

Canonical business-facing freshness shape:

```ts
interface FreshnessState {
  status: 'fresh' | 'delayed' | 'stale' | 'failed_partial' | 'unknown';
  lastUpdatedAt: string | null;
  delayedReason: string | null;
  sourceSnapshotId?: string | null; // optional, diagnostics only
}
```

Rules:

- primary screens use `status`, `lastUpdatedAt`, `delayedReason`;
- diagnostics may additionally expose `sourceSnapshotId`.

## Cache and invalidation expectations

### Immediate query effects

These actions should affect queries immediately or on next reload without full reprocess:

- contributor exclusion
- repository exclusion
- PR exclusion
- commit exclusion
- contributor merge/unmerge

### Smart invalidation

In practice, invalidation should be limited to:

- affected contributors;
- affected teams;
- affected repositories;
- affected time buckets.

### Explicit reprocess

Only rule-heavy or historical backfill changes should require explicit reprocess.

Examples:

- branch exclusion regex
- file path exclusion rules
- broad bot-pattern changes

## API surface guidance

### Preferred new namespace

Use a new domain-oriented namespace such as:

- `/api/v2/...`

or an equivalent dedicated domain facade.

Rule:

- new business surfaces should not be implemented as extensions of `/api/orders/...`.

### Suggested top-level surface groups

- `/api/v2/scope`
- `/api/v2/home`
- `/api/v2/teams`
- `/api/v2/contributors`
- `/api/v2/repositories`
- `/api/v2/saved-views`
- `/api/v2/schedules`
- `/api/v2/curation`
- `/api/v2/data-health`

This is guidance, not a final route lock, but the separation of concerns is mandatory.

## Legacy translation rules

### Allowed

- derive repository freshness from latest legacy snapshot;
- derive contributor activity from legacy commit analysis rows through a facade;
- translate legacy mapping into canonical contributor/alias relations during migration.

### Not allowed

- returning legacy `Order` as the main object for a new team or contributor screen;
- using `selectedRepos` JSON directly as a frontend contract for new screens;
- exposing snapshot-local dedup blobs as business-facing contributor identity.

## Minimum contracts needed for Slice 1

To start `Contributor Foundation`, the minimum contracts that must exist are:

- `ContributorSummaryRow[]`
- `ContributorDetail`
- `ContributorAlias[]`
- identity queue read model
- merge/unmerge write actions
- exclude/include contributor write action

For Slice 1, `ContributorDetail` is considered valid without a populated `pullRequests` section if:

- `repositoryBreakdown` is present;
- commit evidence is available via the separate paginated endpoint (`GET /api/v2/contributors/:id/commits`);
- identity health is visible;
- the UI does not pretend commit groups are canonical PRs.

## Readiness rule for builder-AI

An implementation packet can be issued only when:

- the target screen exists in `06-screen-catalog.md`;
- the relevant business entity exists in `03-domain-model.md`;
- the required read/write contracts for that slice are listed here;
- any unresolved contract gaps are explicitly marked and accepted.
