# Delivery Slices

This file defines the first implementation slices that can be handed to builder-AI.

## Slice 1: Contributor Foundation

### Goal

Introduce canonical contributor identity and alias resolution so downstream analytics can trust person-level data.

### Includes

- `Contributor` model
- `ContributorAlias` model
- basic auto-merge rules
- unresolved/suggested alias queue
- initial People list

### Does not include

- full team dashboards
- saved views
- scheduling

### Acceptance criteria

- one real person with multiple emails/provider identities resolves to one contributor;
- unresolved aliases are visible in an admin-reviewable queue;
- People list does not read directly from legacy `selectedDevelopers` JSON.

## Slice 2: Repository Read Model

### Goal

Expose repositories as stable workspace-scoped entities with freshness and drill-down context, without exposing runs/jobs in main UX.

### Includes

- canonical `Repository` identity
- repository projector / backfill / best-effort sync
- repository list
- repository detail
- last updated/freshness derived from legacy snapshots
- canonical contributor reuse inside repository surfaces

### Does not include

- canonical PR / work-item model
- final team auto-discovery logic
- full curation hub

### Acceptance criteria

- repository page can show freshness without surfacing run/job IDs as primary UI;
- legacy data can populate repository metrics through a facade layer;
- repeated analyses of one repo collapse to one canonical repository identity;
- repository detail may ship without a populated PR section if it does not fake PRs and remains contributor/activity-aware.

## Slice 3: Team Pivot

### Goal

Introduce team-scoped management workflow as the main default surface.

### Includes

- `Team`
- `TeamMembership`
- point-in-time membership storage
- minimal team creation/update path
- minimal membership management path
- teams list page
- team detail page
- auto-discovered repositories from team member activity

### Does not include

- full home/dashboard redesign
- full matrix attribution customization;
- `SavedView`
- global context bar
- advanced org rollup settings.

### Acceptance criteria

- manager can open a team and see team members plus active repositories in the selected period;
- repo list on team page is derived from contributor activity, not static assignment only.

## Slice 4: Global Scope and Saved Views

### Goal

Introduce persistent shared analytical context and reusable reporting scopes on top of the now-real team/repository/contributor surfaces.

### Includes

- global context bar
- URL-backed `ActiveScope`
- workspace-scoped `SavedView`
- reports library for saved views
- shareable saved scope within the authenticated app
- initial `/dashboard` -> scope-aware `Home` binding
- retrofitting Slice 3 local date-range behavior into shared scope where needed

### Does not include

- separate persisted `Dashboard` object
- full schedule/report-run history UI
- external/public report sharing model
- full schedule management UI
- org-level scope beyond `Workspace`

### Acceptance criteria

- changing scope in the global context bar affects all primary analytics surfaces;
- a saved view can represent one team, multiple teams, or custom repo subsets;
- activating a saved view updates the shared scope instead of opening an isolated mini-app;
- `/dashboard` is no longer primarily an order-centric page.

## Slice 5: Curation and Diagnostics

### Goal

Add trust controls and move infrastructure concepts out of primary UX.

### Includes

- `ExclusionRecord`
- `CurationAuditLog`
- inline exclusion actions
- central curation hub
- `Data Health` / diagnostics surface

### Does not include

- arbitrary deep reprocessing UI for every rule type

### Acceptance criteria

- excluding a contributor/repo/PR affects queries without destructive deletion;
- analysis/job/run state is accessible in diagnostics, not in main navigation.

## Delegation rule

Each slice handed to builder-AI must reference:

- locked decisions from `01-decisions.md`
- terminology from `02-ubiquitous-language.md`
- entity contracts from `03-domain-model.md`
- exact write scope and acceptance criteria via the implementation packet template
