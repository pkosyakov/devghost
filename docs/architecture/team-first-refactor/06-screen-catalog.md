# Screen Catalog

This document catalogs the target screens, their purpose, and the contracts they need.

## Priority model

- `P0`: required before meaningful builder-AI implementation of the refactor can begin
- `P1`: strongly recommended in the first expanded wave
- `P2`: later optimization/admin polish

## P0 screens

| Screen | Purpose | Primary persona | Scope source | Key widgets / sections | Contract dependency |
|---|---|---|---|---|---|
| `Home` | Context-aware landing dashboard for current scope | Exec, Manager, Tech Lead | Global context bar | KPI summary, trend panels, top PRs, top contributors, top repos | Team aggregates, contributor highlights, repo highlights |
| `Teams List` | Discover and switch management scopes | Manager, Director | Organization + optional search | Team cards/table, member count, active repo count, team health snapshot | Team summary read model |
| `Team Detail` | Core team workspace | Manager, Tech Lead | Active team + date range | Overview, Pull Requests, People, Repositories, Health & Trends, Reports, Settings | Team detail, PR list, contributor list, repo list |
| `People List` | Canonical contributor directory and identity health entry | Manager, Admin | Global scope + filters | Contributor table, identity health badges, team summary, recent activity | Contributor list read model |
| `Contributor Detail` | Cross-repo contributor analytics and identity detail | Manager, Tech Lead, Admin | Contributor ID + active date range | Summary, memberships, aliases, PR activity, repo breakdown, commit evidence | Contributor detail read model |

## P1 screens

| Screen | Purpose | Primary persona | Scope source | Key widgets / sections | Contract dependency |
|---|---|---|---|---|---|
| `Repository List` | Operational catalog of repositories | Tech Lead, Admin | Organization + filters | Freshness, active contributors, health state, ownership context | Repository summary read model |
| `Repository Detail` | Repo-local drill-down and operational surface | Tech Lead, Repo Owner | Repository ID + date range | Freshness, PR flow, contributors, anomalies, repo rules | Repository detail read model |
| `Reports Library` | Entry surface for reusable saved analytical scopes | Manager, Director | Workspace + optional search | Saved view list, visibility, owner, scope preview, create CTA | SavedView summary read model |
| `Saved View Detail` | Manage reusable analytical scope | Manager, Director | SavedView ID | Scope definition, filters, sharing, schedules, linked dashboards | SavedView read/write contract |
| `Data Health` | Diagnostics and freshness management | Admin, Platform Owner | Organization | Snapshot freshness, ingestion gaps, reprocess controls | AnalysisSnapshot/DataHealth read model |
| `Curation Hub` | Centralized trust and curation operations | Admin, Analytics Owner | Organization | Exclusions, merge queue, bot review, audit log | Curation read/write contracts |

## P2 screens

| Screen | Purpose | Notes |
|---|---|---|
| `Dashboard Detail` | Named widget layout surface | Can be deferred if SavedView is enough for v1 |
| `Schedules` admin page | Centralized delivery management | Useful once schedules proliferate |
| `Org Overview` | Dedicated org scorecard beyond Home | Might become a specialized SavedView |

## Screen definitions

### Home

Purpose:

- one landing surface that adapts to active scope and persona.

Must not:

- expose raw run/job constructs;
- force repo-by-repo onboarding for managers.

### Teams List

Purpose:

- help users enter a stable team scope quickly.

Must support:

- search
- sorting
- active/inactive signal
- last activity visibility

### Team Detail

Purpose:

- default management workspace.

Must support:

- current operating state
- drill-down into PRs, people, and repos
- saving refined scope as a SavedView

Slice 4 note:

- local Slice 3 date controls should converge into the global context bar rather than coexist with it unsafely.

### People List

Purpose:

- expose canonical contributors and identity quality.

Must support:

- one row per contributor, not alias;
- team context;
- recent activity;
- identity health affordance.

### Contributor Detail

Purpose:

- explain what one contributor has done across repos and teams.

Must support:

- alias resolution visibility;
- team membership history summary;
- PR-centric delivery view;
- commit evidence drill-down.

### Repository Detail

Purpose:

- repo-local operational lens for leads/platform owners.

Must support:

- freshness;
- PR and contributor activity;
- repo-specific curation/rules;
- sync health.

### Saved View Detail

Purpose:

- manage reusable saved scope and reporting behavior.

Must support:

- scope definition;
- visibility;
- link sharing;
- schedules.

### Reports Library

Purpose:

- library of reusable saved scopes exposed under the `Reports` navigation entry.

Must support:

- discover saved views;
- create a new saved view from current scope or from scratch;
- activate a saved view into the global context bar;
- open saved view detail for editing and sharing.

### Data Health

Purpose:

- isolate infrastructure transparency from main analytics UX.

Must support:

- freshness;
- partial failure visibility;
- reprocess/repair controls;
- legacy run/debug visibility.

### Curation Hub

Purpose:

- central place for trust operations that are too heavy for inline actions.

Must support:

- merge queue;
- exclusions browser;
- bot/external classification review;
- audit trail.

## Screen-to-slice mapping

| Slice | Screens unlocked |
|---|---|
| Slice 1: Contributor Foundation | `People List`, partial `Contributor Detail`, partial `Curation Hub` |
| Slice 2: Repository Read Model | `Repository List`, partial `Repository Detail`, freshness cards on `Home` |
| Slice 3: Team Pivot | `Teams List`, `Team Detail`, team-scoped `Home` |
| Slice 4: Global Scope and Saved Views | scope-aware `Home`, `Reports Library`, `Saved View Detail`, shared scope behavior across primary analytics screens |
| Slice 5: Curation and Diagnostics | `Data Health`, full `Curation Hub`, diagnostics affordances on other screens |

## Immediate spec-writing order

Before delegating implementation, write detailed specs for:

1. `People List`
2. `Contributor Detail`
3. `Repository Detail`
4. `Team Detail`
5. `Home`
6. `Saved View List`
7. `Saved View Detail`

Reason:

- these screens cover the first four delivery slices and most of the new domain model.
