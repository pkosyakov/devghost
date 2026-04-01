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

## Slice 4A: Onboarding Journey Hardening

**Status: merged to `master` (2026-03-31)**

### Goal

Turn the post-Slice-4 surfaces into a coherent new-customer path instead of a set of disconnected screens.

### Includes

- maturity-aware onboarding UX hardening
- first-analysis results handoff
- stronger repo-seeded first-team bootstrap discoverability
- explicit first-saved-view guidance after first team creation
- suppression or de-emphasis of advanced concepts too early in the journey

### Does not include

- new schema/entities
- backend/domain rename of `Order`
- route rename away from `/orders/*`
- scheduled report delivery
- public report sharing
- Slice 5 diagnostics/curation work

### Acceptance criteria

- a new user sees one clear next step at each maturity stage;
- analysis results explicitly hand off into `People`, `Repositories`, and first-team creation;
- first-team creation is discoverable from repository-oriented surfaces;
- after first team creation, the product clearly drives the first saved view;
- mature workspaces still retain operational mode.

## Slice 4B: Analysis Identity Bridge

### Goal

Hide the legacy developer-loading and manual deduplication step behind an automatic preparation bridge, so the default customer path can run analysis without forcing raw identity review in the middle.

### Includes

- automatic preparation of compatibility identity inputs for the current worker
- removal of manual developer dedup from the default new-customer path
- neutral preparation UX instead of a raw developer-merge workflow
- stronger handoff from analysis results into canonical `People`

### Does not include

- schema changes
- backend/domain rename of `Order`
- full `Order` -> `AnalysisSnapshot` refactor
- rewrite of billing or the analysis worker
- Slice 5 curation/diagnostics work

### Acceptance criteria

- a new customer can select repositories and proceed into analysis without a mandatory manual dedup step;
- the legacy compatibility payloads still exist, but are machine-managed;
- identity review moves toward canonical contributor surfaces instead of blocking setup;
- existing worker/projector behavior remains intact.

## Slice 4C: Analysis Results Landing

### Goal

Give completed analyses a first-class customer-facing results surface, so the first value moment is no longer trapped in the legacy order dashboard.

### Includes

- explicit `Analysis Results` role in the new-customer journey
- customer-facing reframe of completed analysis detail as a results landing, not an internal run screen
- preservation of bubble chart / ghost insight / contributor comparison as analysis-scoped evidence
- strong handoff from analysis results into canonical `People`, `Repositories`, and first-team creation
- optional latest-results return path from transitional `Home`
- de-emphasis of technical and infrastructure panels for first-run customers

### Does not include

- full `Order` / route rename
- migration of every order-scoped metric into canonical `Contributor` / `Repository` / `Team` models
- benchmark redesign
- diagnostics/data-health redesign
- removal of legacy analysis engine

### Acceptance criteria

- after a completed analysis, a customer can clearly see the imported value without inferring it from legacy infrastructure UI;
- bubble chart and ghost insight remain visible as part of a customer-facing `Analysis Results` surface;
- analysis results explicitly hand off into `People`, `Repositories`, and first-team creation;
- `Home` and operational canonical screens no longer feel like they dropped the analysis outcome on the floor.

## Slice 5A: Canonical Identity Curation

### Goal

Make canonical contributor identity the only layer the customer reviews and edits, while removing the manual raw developer dedup step from the default analysis path.

### Includes

- billing-safe analysis preflight independent of manual dedup UI
- canonical alias ingestion and conservative auto-resolution
- merge / unmerge on canonical contributor surfaces
- identity review via `People` / identity queue rather than analysis-local raw groups

### Does not include

- full diagnostics hub
- route rename away from `/orders/*`
- total run-engine replacement
- PR/work-item modeling

### Acceptance criteria

- analysis no longer blocks on manual raw developer dedup;
- billing remains correct and conservative;
- manual merge / unmerge still exists on canonical identity surfaces;
- identity review happens through `People` / curation flows.

## Slice 5B: Diagnostics and Data Health

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

## Slice 5C: Scoped Analysis Billing

### Goal

Make analysis credit estimation and reservation derive from the authoritative scoped commit universe rather than stale extraction-time aggregates.

### Includes

- shared server-side billing preview for selected repo + period + contributor scope
- consistent estimate source for UI and analyze preflight
- zero-credit fully cached / zero-net analysis runs
- honest distinction between authoritative credits and approximate USD guidance

### Does not include

- pricing-plan redesign
- seat/org monetization
- total worker rewrite
- exact provider-invoice billing before run launch

### Acceptance criteria

- UI and analyze preflight resolve the same scoped billable commit count;
- changing scope recalculates estimate from authoritative scoped data;
- fully cached / zero-net runs can start with `0` available credits;
- credit reservation remains safe and auditable for positive billable runs.

## Delegation rule

Each slice handed to builder-AI must reference:

- locked decisions from `01-decisions.md`
- terminology from `02-ubiquitous-language.md`
- entity contracts from `03-domain-model.md`
- exact write scope and acceptance criteria via the implementation packet template
