# Implementation Packet: Global Scope and Saved Views

## Goal

Introduce one shared analytical context and a reusable saved-scope object so DevGhost stops behaving like a set of isolated pages with local filters.

## Why this slice exists

After `Contributor Foundation`, `Repository Read Model`, and `Team Pivot`, DevGhost now has the core business entities needed for a real management workflow.

What is still missing:

- scope resets when the user moves between primary analytical screens;
- team detail still relies on Slice 3 local date controls;
- `/dashboard` is still order-centric instead of scope-centric;
- there is no reusable reporting object for “this exact slice of the org”.

Slice 4 fixes that by introducing:

- a shared `ActiveScope`;
- a real `SavedView` object;
- a `Reports` library of saved scopes;
- initial binding of current `/dashboard` to the new scope model.

## Source artifacts

- [00-north-star.md](C:\Projects\devghost\docs\architecture\team-first-refactor\00-north-star.md)
- [01-decisions.md](C:\Projects\devghost\docs\architecture\team-first-refactor\01-decisions.md)
- [02-ubiquitous-language.md](C:\Projects\devghost\docs\architecture\team-first-refactor\02-ubiquitous-language.md)
- [03-domain-model.md](C:\Projects\devghost\docs\architecture\team-first-refactor\03-domain-model.md)
- [04-state-and-attribution-rules.md](C:\Projects\devghost\docs\architecture\team-first-refactor\04-state-and-attribution-rules.md)
- [05-ux-ia.md](C:\Projects\devghost\docs\architecture\team-first-refactor\05-ux-ia.md)
- [06-screen-catalog.md](C:\Projects\devghost\docs\architecture\team-first-refactor\06-screen-catalog.md)
- [08-data-and-api-contracts.md](C:\Projects\devghost\docs\architecture\team-first-refactor\08-data-and-api-contracts.md)
- [10-delivery-slices.md](C:\Projects\devghost\docs\architecture\team-first-refactor\10-delivery-slices.md)
- [home.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\home.md)
- [global-context-bar.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\global-context-bar.md)
- [saved-view-list.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\saved-view-list.md)
- [saved-view-detail.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\saved-view-detail.md)

## Locked decisions

- `D-001` Primary management scope is `Team`
- `D-006` `SavedView` is independent from `Team`
- `D-007` Weekly reports are `Schedule + ReportRun` over `SavedView` or `Dashboard`
- `D-017` Legacy run engine stays in place during migration
- `D-018` Slice 4 uses URL-backed `ActiveScope` as the v1 source of truth for unsaved scope state
- `D-019` `SavedView` is workspace-scoped in production until `Organization` exists
- `D-020` Separate persisted `Dashboard` object is deferred; `/dashboard` becomes scope-aware `Home`

## Write scope

Allowed write scope for this packet:

- `packages/server/prisma/schema.prisma`
- new Prisma migrations related to saved views or scope state support
- new or updated domain-facing routes under `packages/server/src/app/api/v2/**`
- new scope helpers/services/schemas under `packages/server/src/lib/**`
- shared analytical layout/components under:
  - `packages/server/src/components/layout/**`
  - `packages/server/src/components/**` where needed for the global context bar
- analytics surfaces that must adopt shared scope:
  - `packages/server/src/app/[locale]/(dashboard)/dashboard/**`
  - `packages/server/src/app/[locale]/(dashboard)/teams/**`
  - `packages/server/src/app/[locale]/(dashboard)/people/**`
  - `packages/server/src/app/[locale]/(dashboard)/repositories/**`
  - new reports surfaces under `packages/server/src/app/[locale]/(dashboard)/reports/**`
- translations needed for new scope/reports UI in:
  - `packages/server/messages/en.json`
  - `packages/server/messages/ru.json`
- minimal nav exposure in:
  - `packages/server/src/components/layout/sidebar.tsx`
  - `packages/server/src/proxy.ts`

## Read-only context

Read but do not structurally rewrite unless escalation is approved:

- legacy order pages and `/api/orders`
- publications/public profile surfaces
- admin/data-health surfaces
- contributor identity projection logic
- repository projection logic
- slice-3 team membership logic except where shared scope adoption requires targeted changes

## Out of scope

- `Organization`
- public/external report sharing model
- separate persisted `Dashboard` object
- full schedule management UI
- full `ReportRun` history UI
- canonical PR/work-item model
- curation hub / diagnostics expansion
- full Home redesign beyond what is needed to make `/dashboard` scope-aware

## Implementation notes

### 1. Use `Workspace` as the production boundary

Until `Organization` exists in production:

- `SavedView` must be implemented as workspace-scoped;
- team, repository, and contributor lookups continue to resolve through the authenticated user's `Workspace`.

### 2. `SavedView` must be a real object

This slice is not complete if scope persistence exists only in URL params or local storage.

Required v1 concept:

- canonical workspace-scoped `SavedView`

Expected minimum fields:

- `name`
- `visibility`
- `scopeDefinition`
- `filterDefinition`
- `ownerUserId`

### 3. `ActiveScope` is shared URL-backed state in Slice 4

In Slice 4 v1:

- unsaved shared scope is URL-backed;
- saved-view activation hydrates the same `ActiveScope` shape;
- there is no separate persisted server-side session-scope object.

This should feel persistent across primary analytical screens because the same route/query semantics are carried through navigation.

### 4. Replace or synchronize Slice 3 local scope controls

Current Team Detail already has local `from/to` state.

Slice 4 rules:

- the page must not keep an unsynced second date-range control;
- local Team Detail date state should be replaced by or synchronized to `ActiveScope`;
- if one control updates scope, the other must reflect the same state immediately or be removed.

### 5. `/dashboard` becomes `Home`

Do not introduce a separate persisted `Dashboard` model in this slice.

Required Slice 4 behavior:

- existing `/dashboard` becomes a scope-aware `Home` screen;
- it must read from `ActiveScope`;
- it must stop behaving primarily like an order inventory/status page.

### 6. `Reports` is a saved-view library first

For Slice 4 v1, `Reports` may initially be:

- a list of saved views;
- saved-view detail/edit surface;
- activation/share/archive actions.

Schedules and report history can remain deferred.

### 7. Route identity still wins on detail pages

Rules:

- `/teams/[id]` stays bound to that canonical team;
- selecting another team in shared scope should navigate to `/teams/[newId]` rather than silently mismatch route and data;
- list/home/report surfaces are more fully driven by `ActiveScope` than entity-detail routes.

### 8. No fake reporting objects

Do not:

- introduce a fake dashboard object just to satisfy the word “dashboard”;
- introduce a fake report-run history surface;
- collapse `SavedView` back into a team-only filter.

## Acceptance criteria

- There is a canonical workspace-scoped `SavedView` concept in schema and app code.
- A shared global context bar exists for primary analytical surfaces.
- Unsaved scope state is shared via URL-backed `ActiveScope`.
- Activating a saved view updates shared scope rather than opening an isolated mini-app.
- `/dashboard` behaves as a scope-aware `Home` surface instead of a primarily order-centric page.
- At least `Home`, `Teams`, `People`, and `Repositories` participate in shared scope semantics.
- Slice 3 local date-range behavior on Team Detail is replaced or synchronized where the global context bar is introduced.
- Existing order/publication/admin flows continue to function.
- The slice does not require schedules or a separate persisted dashboard object first.

## Validation

### Automated

- schema/migration applies cleanly
- saved-view route tests cover create/list/detail/update/archive behavior
- shared scope helper parsing/serialization has automated coverage
- at least one primary screen test verifies scope param propagation

### Manual

- change date range in the global context bar and move between `Home`, `Teams`, `People`, and `Repositories`
- activate a saved view and confirm the global context bar reflects it
- save the current scope from a team-centered context and reopen it from `Reports`
- confirm Team Detail no longer has a competing unsynced local date-range control
- confirm `/dashboard` no longer reads as primarily an order inventory page

## Risks

- shared scope can sprawl into a quasi-router rewrite if packet boundaries are ignored
- retrofitting existing client pages may tempt ad hoc query param conventions
- `SavedView` can accidentally become team-only if multi-team/custom-repo scope is not protected
- Home redesign can sprawl if the slice tries to solve full executive reporting at once

## Escalation rules

Stop and escalate if:

- implementation would require introducing `Organization` first;
- a separate persisted `Dashboard` object becomes necessary to make Slice 4 useful;
- route identity and shared scope cannot be reconciled cleanly on team detail;
- `SavedView` can only be implemented as a thin wrapper around one team and one date range;
- existing primary screens would need a full rewrite rather than scoped integration.
