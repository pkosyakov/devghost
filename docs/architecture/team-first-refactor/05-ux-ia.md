# UX and Information Architecture

This document defines the target navigation and scope behavior for the refactor.

## Purpose

Freeze the user-facing information architecture so builder-AI does not invent:

- ad hoc navigation groups;
- inconsistent scope behavior;
- repo-first screens in team-first flows;
- diagnostics surfaces leaking into the primary experience.

## Core IA principles

### 1. Scope before screen

Users should first choose:

- organization;
- active scope (`All Teams`, `Team`, or `SavedView`);
- date range.

Then navigate between analytical lenses.

### 2. Jobs to be done over raw entities

Primary navigation should reflect user intent:

- understand overall health;
- manage team delivery;
- inspect contributors;
- reuse/report a saved slice.

It should not foreground:

- jobs;
- runs;
- raw commits;
- repository inventory as the main landing experience.

### 3. Team-first, repo-drill-down

For the mature B2B product:

- `Team` is the default management lens;
- `Repository` is available as catalog/drill-down;
- `Contributor` is available for people and attribution workflows.

### 4. Persistent analytical context

Changing the active scope should carry across all primary analytical surfaces unless the user explicitly resets it.

## Navigation model

### Global context bar

The top persistent context bar contains:

- `Organization selector`
- `Scope selector`
- `Date range picker`
- optional `Add filter` control

#### Scope selector behavior

The scope selector must support:

- `All Teams`
- a specific `Team`
- a specific `SavedView`

Optional future support:

- multi-team ad hoc selection

#### Date range behavior

Date range is global session context, not local widget state.

Defaults:

- managers: recent operating window, e.g. last 14 or 30 days;
- execs: portfolio-friendly window, e.g. last 30 or 90 days;
- tech leads: tactical window, e.g. last 7 to 14 days.

#### Secondary filters

Secondary filters are scoped refinements, not a replacement for the global scope.

Examples:

- repository
- service
- label
- contributor subset
- work type

Rule:

- secondary filters may narrow a scope;
- they must not silently redefine what the primary scope object is.

### Slice 4 rollout note

In the current production implementation, the best insertion point for the global context bar is the shared dashboard layout chrome above page content.

Slice 4 v1 should apply the bar to:

- `Home` (`/dashboard`)
- `Teams`
- `People`
- `Repositories`
- `Reports`
- `Team Detail`

Slice 4 v1 may defer full scope-bar behavior on:

- contributor detail
- repository detail
- legacy orders/publications/admin surfaces

Rule:

- if a page already has local scope widgets from Slice 3, Slice 4 must replace or synchronize them rather than layering a second unsynced scope control above the page.

### Primary navigation

- `Home`
- `Teams`
- `People`
- `Reports`

### Secondary navigation

- `Repositories`
- `Settings`
- `Billing`
- `Profile`

### Diagnostics / admin navigation

Separate from main UX:

- `Data Health`
- `Users`
- `LLM Config`
- `Monitoring`
- `Audit Log`

Rule:

- `AnalysisSnapshot` and legacy job/run state may appear here only.

## Landing behavior by persona

### CTO / VP Engineering

Default:

- `Home`
- scope: `All Teams` or executive `SavedView`
- date range: org-level planning horizon

Primary concerns:

- portfolio health;
- investment/allocation;
- trend direction;
- org-wide delivery risk.

### Engineering Manager

Default:

- `Home`
- scope: their primary `Team`
- date range: last 14 to 30 days or active sprint/iteration

Primary concerns:

- bottlenecks;
- WIP;
- PR flow;
- team health;
- contributor workload.

### Tech Lead / Repo Owner

Default:

- `Home` or `Team`
- scope: their team
- date range: recent tactical window

Primary concerns:

- active PRs;
- blocked work;
- repo health;
- review depth;
- direct pushes and churn.

Rule:

- tech leads may pivot into repository drill-down more often than managers;
- this does not justify making repository the default primary scope.

## Drill-down patterns

### Canonical drill-down chain

```text
Home
  -> Team
    -> Pull Request / Metric Slice
      -> Contributor
        -> Commit Evidence
```

### Repository drill-down chain

```text
Home or Team
  -> Repositories tab or repository filter
    -> Repository Detail
      -> Pull Request
      -> Contributor
      -> Commit Evidence
```

### Saved view activation

```text
Reports
  -> Saved View
    -> opens same analytical surfaces under restored scope
```

Rule:

- activating a saved view should update the global context bar;
- users should feel they are changing scope, not entering an isolated mini-app.

### Route and scope synchronization

Rules:

- on list/home/report surfaces, the global context bar is the primary scope control;
- on entity-detail pages, route identity remains canonical and the global context bar refines or navigates, but must not silently contradict the route;
- selecting another team while on `/teams/[id]` should navigate to `/teams/[newId]` and carry the current date range;
- a saved view whose primary scope is a specific team may open team detail directly or open `Home` under restored scope, but the product must choose one behavior explicitly and use it consistently.

## Teams as the default management workspace

### Team detail tabs

- `Overview`
- `Pull Requests`
- `People`
- `Repositories`
- `Health & Trends`
- `Reports`
- `Settings`

### Team page rules

- repositories shown on a team page are derived from team member activity within the active period;
- team settings can pin, exclude, or refine repository scope;
- team pages should not require manual checking of dozens of repositories just to become useful.

## People / contributor UX rules

### People list

Purpose:

- directory of canonical contributors, not aliases.

Required affordances:

- identity health signal;
- team membership summary;
- repository count;
- recent activity;
- direct path into contributor detail.

### Contributor detail

Must show:

- cross-repo activity;
- team memberships;
- alias health;
- PR history;
- commit evidence layer.

Rule:

- contributor detail is cross-repo by default;
- repository-local contributor context belongs on repository detail.

## Repository UX rules

### Repository list

Purpose:

- operational catalog and drill-down surface;
- not the primary analytical home for managers.

Repository list should emphasize:

- freshness;
- ownership context;
- active contributors;
- current risk/health indicators.

### Repository detail

Must support:

- repo-local PR flow;
- local contributor set;
- sync/freshness state;
- code/process anomalies;
- repository-specific rules and exclusions.

## Reports UX rules

### Reports library

`Reports` is the reusable scope library, not a separate authored reporting universe.

Sub-surfaces:

- `Saved Views`
- `Dashboards`
- `Schedules`

### User mental model

1. define the slice
2. save the slice
3. optionally place it in a dashboard
4. share or schedule it

Slice 4 v1 note:

- `Reports` may initially be a `Saved Views` library only;
- `Schedules` and separate persisted `Dashboard` objects may stay deferred.

### Share behavior

Share menu should support:

- copy state URL
- copy canonical saved object URL
- set visibility
- export
- schedule delivery

## Curation UX rules

### Inline curation

Use inline actions where the user discovers the bad data:

- exclude contributor from people list/detail
- exclude repository from repository/team context
- exclude PR from PR surfaces
- classify alias/bot from identity surfaces

### Central curation hub

Use central admin surfaces for:

- merge/unmerge review
- exclusion audit log
- rule management
- bot/external contributor review queue

Rule:

- do not force users to leave context for every small exclusion;
- do not hide all curation inside one distant settings page.

## Diagnostics placement

Diagnostics belongs in `Data Health`, not in primary analytics.

`Data Health` can expose:

- sync freshness
- last successful snapshot per repository/team
- ingestion gaps
- reprocess actions
- legacy run visibility

Rule:

- no primary analytical screen should require understanding job IDs or snapshot IDs.

## URL and persistence rules

### Session persistence

The active organization, scope, and date range should persist across navigation in the same session.

### Direct links

Two modes are allowed:

- ad hoc state URL for temporary sharing;
- canonical saved object URL for durable reuse.

### Navigation invariant

Switching between `Home`, `Teams`, `People`, and `Reports` must not silently reset scope.

## Explicit anti-patterns

Do not implement:

- `Orders` or `Runs` as a main navigation pillar;
- repository picker as the first thing every manager sees on login;
- separate "Weekly Reports" authoring model detached from saved scopes;
- people views based on aliases instead of canonical contributors;
- primary analytics screens that expose infrastructure troubleshooting concepts.
