# Execution Brief: Global Scope and Saved Views

Use this brief when handing `Slice 4: Global Scope and Saved Views` to a builder-AI.

## Intent

This slice turns the existing entity pages into one coherent analytical experience.

The builder must treat this slice as:

- the first shared-scope layer across primary analytics screens;
- the first real `SavedView` implementation;
- workspace-scoped in the current production model;
- explicitly not dependent on schedules, report-run history UI, or a separate persisted dashboard object.

## Required reading

The builder must read these files before touching code:

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
- [04-global-scope-and-saved-views.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\04-global-scope-and-saved-views.md)

## Base assumptions

The builder must assume all of the following are already true in the base branch/worktree:

- `Workspace` exists and is the production scope boundary.
- `Contributor`, `Repository`, `Team`, and `TeamMembership` already exist as canonical business-facing concepts.
- primary analytics pages already exist for `Teams`, `People`, and `Repositories`.
- Team Detail currently uses Slice 3 local date-range state.
- legacy order/publication/admin surfaces still exist and must keep working.

If the current branch does not already contain the Team Pivot slice, stop and escalate instead of inventing fallback scope behavior.

## Builder prompt

```text
Task: Implement `Slice 4: Global Scope and Saved Views`

You are building the shared analytical context layer of the DevGhost refactor.

Read first:
- docs/architecture/team-first-refactor/README.md
- docs/architecture/team-first-refactor/00-north-star.md
- docs/architecture/team-first-refactor/01-decisions.md
- docs/architecture/team-first-refactor/02-ubiquitous-language.md
- docs/architecture/team-first-refactor/03-domain-model.md
- docs/architecture/team-first-refactor/04-state-and-attribution-rules.md
- docs/architecture/team-first-refactor/05-ux-ia.md
- docs/architecture/team-first-refactor/06-screen-catalog.md
- docs/architecture/team-first-refactor/08-data-and-api-contracts.md
- docs/architecture/team-first-refactor/10-delivery-slices.md
- docs/architecture/team-first-refactor/07-screen-specs/home.md
- docs/architecture/team-first-refactor/07-screen-specs/global-context-bar.md
- docs/architecture/team-first-refactor/07-screen-specs/saved-view-list.md
- docs/architecture/team-first-refactor/07-screen-specs/saved-view-detail.md
- docs/architecture/team-first-refactor/12-implementation-packets/04-global-scope-and-saved-views.md
- docs/architecture/team-first-refactor/12-implementation-packets/04-global-scope-and-saved-views-execution-brief.md

Primary goal:
Introduce one shared analytical scope layer plus real Saved Views so primary analytics screens stop acting like isolated pages with local filters.

Hard constraints:
- Current production boundary is `Workspace`, not `Organization`.
- Do not introduce a separate persisted `Dashboard` object in this slice.
- Do not block on schedules or report-run history UI.
- Do not reintroduce order-centric dashboard semantics.
- Do not make `SavedView` team-only; it must support multi-team or repo-refined scope.
- Do not leave duplicate unsynced date-range controls on pages that participate in the global context bar.
- Do not redesign admin/orders/publications as part of this slice.

Required implementation outcomes:
1. Introduce canonical workspace-scoped `SavedView`.
2. Add a shared global context bar for primary analytics surfaces.
3. Use URL-backed `ActiveScope` as the v1 source of truth for unsaved shared scope.
4. Add reports library and saved-view detail surfaces.
5. Make activating a saved view update shared scope.
6. Turn `/dashboard` into a scope-aware `Home` surface.
7. Retrofit existing primary screens so they participate in shared scope semantics.
8. Replace or synchronize Team Detail's Slice 3 local date controls where the scope bar is introduced.

Allowed write scope:
- packages/server/prisma/schema.prisma
- packages/server/prisma/migrations/**
- packages/server/src/app/api/v2/**
- packages/server/src/lib/**
- packages/server/src/components/layout/**
- packages/server/src/components/**
- packages/server/src/app/[locale]/(dashboard)/dashboard/**
- packages/server/src/app/[locale]/(dashboard)/teams/**
- packages/server/src/app/[locale]/(dashboard)/people/**
- packages/server/src/app/[locale]/(dashboard)/repositories/**
- packages/server/src/app/[locale]/(dashboard)/reports/**
- packages/server/messages/en.json
- packages/server/messages/ru.json
- packages/server/src/components/layout/sidebar.tsx
- packages/server/src/proxy.ts

Read-only unless absolutely required and justified:
- packages/server/src/app/[locale]/(dashboard)/orders/**
- packages/server/src/app/api/orders/**
- publication/public profile surfaces
- admin/data-health surfaces

Important domain rules:
- Unsaved shared scope is URL-backed in Slice 4.
- SavedView activation hydrates the same `ActiveScope`.
- `/dashboard` is the scope-aware Home surface in Slice 4.
- Route identity still wins on detail pages.
- SavedView is independent from Team.
- Schedules and separate persisted Dashboard objects remain deferred.

Out of scope:
- Organization
- schedules/report-run history UI
- separate persisted Dashboard object
- public report sharing
- PR/work-item replatforming
- curation hub
- diagnostics expansion

Acceptance criteria:
- There is a canonical workspace-scoped `SavedView` concept in schema and app code.
- A shared global context bar exists for primary analytical surfaces.
- Unsaved scope state is shared via URL-backed `ActiveScope`.
- Activating a saved view updates shared scope rather than opening an isolated mini-app.
- `/dashboard` behaves as a scope-aware Home surface instead of a primarily order-centric page.
- At least Home, Teams, People, and Repositories participate in shared scope semantics.
- Team Detail local date-range behavior is replaced or synchronized where global scope is introduced.
- Existing order/publication/admin flows continue to function.
- The slice does not require schedules or a separate persisted dashboard object first.

Required output format:
1. Summary of what you changed
2. Files changed
3. Acceptance criteria status, one by one
4. Tests run
5. Known risks / follow-ups
6. Escalations or unresolved gaps

Escalate instead of inventing behavior if:
- Organization becomes required first
- a separate persisted Dashboard object becomes necessary
- route identity and shared scope cannot be reconciled cleanly
- SavedView can only be implemented as a team-only wrapper
- existing primary screens would need a full rewrite instead of scoped integration
```

## Suggested implementation order

1. Add `SavedView` schema and migration.
2. Add shared scope parsing/serialization helpers.
3. Add saved-view APIs and reports-library screens.
4. Add the global context bar to shared analytical layout.
5. Retrofit `/dashboard` into scope-aware Home.
6. Retrofit `Teams`, `People`, and `Repositories` to consume shared scope.
7. Eliminate or synchronize Team Detail local date-range controls.

## Review checklist

### Domain and migration

- `SavedView` exists as a canonical concept in schema and app code.
- `SavedView` is workspace-scoped in the current production slice.
- Saved views support more than one team and can include repo refinements.

### Scope behavior

- one shared context bar drives multiple analytical screens;
- unsaved scope is URL-backed and survives navigation;
- saved-view activation hydrates the same scope state;
- entity-detail routes do not silently contradict active scope.

### UX

- `/dashboard` is no longer mainly an order inventory surface;
- `Reports` functions as a saved-view library;
- saved view detail makes resolved scope explicit;
- no duplicate unsynced date controls remain on participating screens.

### Validation

- schema/migration applies cleanly
- saved-view route tests exist
- shared scope helper tests exist
- at least one multi-screen manual scenario is demonstrated

## Rejection criteria

Reject the implementation if any of the following are true:

- SavedView is effectively just a bookmark/local-storage object with no real model
- global scope is page-local rather than shared
- `/dashboard` remains primarily order-centric
- Team Detail keeps a competing unsynced local date-range control
- the slice expands into schedules, report history, or a separate Dashboard model without approval
