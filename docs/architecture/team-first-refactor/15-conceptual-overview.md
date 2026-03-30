# Conceptual Overview

## Purpose

This document is the simplest conceptual entrypoint for the DevGhost team-first refactor.

It explains:

- what the product is becoming;
- how the main entities relate;
- what each entity is for;
- which attributes matter most;
- what the customer workflow looks like.

Use this when you do not want to reconstruct the model from multiple low-level docs.

For formal source-of-truth details, see:

- [00-north-star.md](C:\Projects\devghost\docs\architecture\team-first-refactor\00-north-star.md)
- [03-domain-model.md](C:\Projects\devghost\docs\architecture\team-first-refactor\03-domain-model.md)
- [05-ux-ia.md](C:\Projects\devghost\docs\architecture\team-first-refactor\05-ux-ia.md)
- [08-data-and-api-contracts.md](C:\Projects\devghost\docs\architecture\team-first-refactor\08-data-and-api-contracts.md)

## 1. Product idea in one page

DevGhost is moving away from a product where the main object is an `Order` or analysis job.

Target product:

- managers open a `Team`;
- they see which `Contributors` were active;
- they see which `Repositories` consumed that team's effort;
- later they can save a reporting scope as a `SavedView`;
- infrastructure processing remains visible only through diagnostics.

So the product is shifting from:

```text
User -> Orders -> embedded repos/developers/commits
```

to:

```text
Organization
  -> Team
  -> Contributor
  -> Repository
  -> SavedView
```

with internal processing hidden behind those business objects.

## 2. Current migration stage

The final target model is organization-based, but the production bridge during migration is:

- `Workspace` = current real boundary in production
- `AnalysisSnapshot` = internal processing/sync concept replacing user-facing `Order`

Practical meaning:

- code that ships today is often workspace-scoped;
- final docs may talk about `Organization`, but current slices usually implement `Workspace` first;
- users should not need to understand job IDs, run IDs, or JSON blobs to use the new surfaces.

## 3. Main entities and how they relate

### Target relationship picture

```text
Organization
  -> Teams
  -> Contributors
  -> Repositories
  -> SavedViews

Contributor
  -> ContributorAliases
  -> TeamMemberships

Team
  -> TeamMemberships
  -> activity-derived Repositories

Repository
  -> PullRequests
  -> Commits

PullRequest
  -> Commits
  -> WorkItems

SavedView
  -> Schedules
  -> ReportRuns
```

### Why these relationships matter

- `Team` is the main management scope.
- `Contributor` is the canonical human identity.
- `ContributorAlias` is the raw identity signal from Git/GitHub/GitLab/email.
- `Repository` is a stable code container and drill-down surface.
- `PullRequest` is the main delivery unit for management UX.
- `Commit` is evidence, not the main top-level reporting object.
- `SavedView` is how reusable reporting scopes and weekly reports will work.

## 4. Entity-by-entity explanation

### `Workspace`

What it is:

- the current production scope boundary during migration.

How to use it:

- every new slice today is scoped to `Workspace`;
- later this can map or attach to `Organization`.

Important attributes:

- owner user
- collections of contributors, repositories, teams

### `Organization`

What it is:

- the future top-level business boundary.

How to use it:

- permissions
- reporting defaults
- shared teams, repos, contributors, saved views

Important attributes:

- name
- policies/defaults
- owned teams, repositories, contributors, saved views

### `User`

What it is:

- someone who can log into the product.

How to use it:

- authentication
- authorization
- audit actor

Important rule:

- a `User` is not the same thing as a tracked engineer.

### `Contributor`

What it is:

- the canonical tracked developer identity.

How to use it:

- people analytics
- attribution
- contributor-level drill-down
- membership in teams

Important attributes:

- `displayName`
- `primaryEmail`
- `classification`
  - internal
  - external
  - bot
  - former employee
- `isExcluded`
- primary team linkage

Why it exists:

- one real person may have many emails/accounts;
- all downstream analytics should point to `Contributor`, not raw email.

### `ContributorAlias`

What it is:

- one raw identity signal from a provider or email.

How to use it:

- matching and deduplication
- unresolved identity queue
- merge/unmerge workflows

Important attributes:

- `providerType`
- `providerId`
- `email`
- `username`
- `status`
  - auto merged
  - manual
  - suggested
  - unresolved

Why it exists:

- raw Git/GitHub identities are messy;
- the product needs a separate layer for identity resolution.

### `Team`

What it is:

- the primary management scope.

How to use it:

- default place for managers and leads;
- team dashboard/detail;
- people and repositories in one scope.

Important attributes:

- `name`
- `parentTeamId`
- manager/owner
- default norms or future team settings

Important rule:

- a team page should show repositories derived from member activity, not require static repo setup before it becomes useful.

### `TeamMembership`

What it is:

- a time-bounded relationship between a contributor and a team.

How to use it:

- historical attribution
- team composition
- primary team rules

Important attributes:

- `effectiveFrom`
- `effectiveTo`
- `isPrimary`
- `role`

Important rule:

- attribution should be point-in-time, not “rewrite all history to the current team”.

### `Repository`

What it is:

- a stable code container and operational drill-down surface.

How to use it:

- repository catalog
- repository detail
- freshness and activity inspection
- team repository breakdowns

Important attributes:

- `provider`
- `owner`
- `name`
- `fullName`
- `defaultBranch`
- `lastUpdatedAt` / `freshness`
- `isExcluded`

Important rule:

- the same repo analyzed many times must collapse to one canonical repository identity.

### `WorkItem`

What it is:

- business/planning intent unit from Jira, Linear, ADO, etc.

How to use it:

- allocation reporting
- initiative tracking
- strategic reporting

Important attributes:

- external ID
- type
- status
- linkage to PRs

### `PullRequest`

What it is:

- the primary delivery/review object in the target UX.

How to use it:

- cycle/review metrics
- management delivery views
- team/repository operational views

Important attributes:

- author contributor
- state
- created/merged timestamps
- merge strategy
- linked work items

Important rule:

- PR is the main business unit for delivery;
- commit lists should not masquerade as PRs.

### `Commit`

What it is:

- evidence-level code change object.

How to use it:

- effort evidence
- direct-push evidence
- detailed code-health and curation

Important attributes:

- repository
- linked PR if known
- authored/committed timestamps
- branch
- diff stats

Important rule:

- commit is still important, but it is not the top-level management object.

### `SavedView`

What it is:

- a saved analytical scope/filter object.

How to use it:

- reusable dashboards
- shareable reporting scope
- weekly scheduled reporting later

Important attributes:

- `name`
- `visibility`
- scope definition
- filter definition
- owner

Important rule:

- `SavedView` is independent from `Team`;
- one saved view may cover one team, multiple teams, or custom repo subsets.

### `AnalysisSnapshot`

What it is:

- the internal freshness/sync/processing record.

How to use it:

- diagnostics
- data health
- support/debugging

Important rule:

- users should not navigate the product by analysis snapshots or orders.

## 5. How the entities are used in the product

### Manager workflow

Target workflow:

1. open the product
2. land on a team-scoped surface
3. inspect team health
4. inspect active contributors
5. inspect repositories consuming that team's effort
6. later save that scope as a reusable view/report

### Tech lead workflow

Target workflow:

1. start from team or home
2. pivot into a repository
3. inspect freshness, contributors, PRs, evidence
4. drill into a contributor if needed

### Admin / analytics owner workflow

Target workflow:

1. inspect unresolved identities
2. merge/unmerge aliases
3. exclude bots/external noise if needed
4. check diagnostics/data health if freshness looks wrong

## 6. Customer process in plain language

This is the intended customer-facing process once the refactor is complete enough:

### Step 1. Connect code sources and run analysis

The ingestion engine still does the technical work in the background.

The customer should not think:

- “which order/job/run am I in?”

They should think:

- “my workspace/org has fresh enough data”

### Step 2. Clean up identity

The customer or admin resolves contributor identities:

- merge duplicate emails/accounts into one contributor
- classify bots/external people
- optionally exclude noisy identities

This step is critical because team and repo analytics depend on it.

### Step 3. Define teams

The customer creates teams and assigns contributors with dates.

This gives the product a real management lens.

### Step 4. Use teams as the main working surface

A manager opens a team and sees:

- contributors
- repositories
- activity
- later PR flow and health trends

### Step 5. Drill into repositories and contributors

If the manager needs details:

- open repository detail
- open contributor detail

Those are drill-down surfaces, not the main entry mode.

### Step 6. Save reusable reporting scopes

Later, the customer saves scopes such as:

- one team
- multiple teams
- subset of repos
- filtered people/repo combination

That becomes a `SavedView`, which can later drive scheduled reports.

## 7. What is already implemented vs still target-state

### Already real in code

- `Workspace`
- `Contributor`
- `ContributorAlias`
- contributor identity projection
- people screens
- canonical `Repository` plus repository list/detail
- current `Team` implementation is active on `feature/team-pivot`

### Prepared architecturally, but not fully productized yet

- `SavedView`
- global context bar
- scope-aware `Home`
- reports library for saved views
- target-state PR/work-item model
- full diagnostics / curation hub

## 8. Short answer to “what is the system?”

The system is becoming:

- a team-first engineering analytics product
- with canonical people identity
- stable repositories as drill-down surfaces
- saved scopes for reporting
- and processing infrastructure hidden behind business-facing entities

If you want the fastest deeper follow-up after this doc, read:

1. [03-domain-model.md](C:\Projects\devghost\docs\architecture\team-first-refactor\03-domain-model.md)
2. [05-ux-ia.md](C:\Projects\devghost\docs\architecture\team-first-refactor\05-ux-ia.md)
3. [08-data-and-api-contracts.md](C:\Projects\devghost\docs\architecture\team-first-refactor\08-data-and-api-contracts.md)
