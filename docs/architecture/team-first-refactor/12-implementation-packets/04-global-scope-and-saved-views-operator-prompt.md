# Operator Prompt: Global Scope and Saved Views

Use this when the builder-AI needs a short, concrete handoff instead of the full architecture packet.

## Prompt

```text
Implement Slice 4: Global Scope and Saved Views.

Read first:
- docs/architecture/team-first-refactor/README.md
- docs/architecture/team-first-refactor/04-state-and-attribution-rules.md
- docs/architecture/team-first-refactor/08-data-and-api-contracts.md
- docs/architecture/team-first-refactor/07-screen-specs/home.md
- docs/architecture/team-first-refactor/07-screen-specs/global-context-bar.md
- docs/architecture/team-first-refactor/07-screen-specs/saved-view-list.md
- docs/architecture/team-first-refactor/07-screen-specs/saved-view-detail.md
- docs/architecture/team-first-refactor/12-implementation-packets/04-global-scope-and-saved-views.md

What to build:
1. Add canonical workspace-scoped `SavedView`.
2. Add a shared global context bar.
3. Use URL-backed `ActiveScope` as the v1 source of truth for unsaved shared scope.
4. Add:
   - `/reports` saved-view library
   - saved-view detail
   - `/dashboard` as scope-aware Home
5. Make activating a saved view update shared scope.
6. Retrofit existing primary analytics screens to participate in shared scope semantics.
7. Replace or synchronize Team Detail local date-range behavior where global scope is introduced.

Hard rules:
- Current production boundary is `Workspace`, not `Organization`.
- Do not introduce a separate persisted `Dashboard` object in this slice.
- Do not block on schedules or report-run history.
- Do not reintroduce order-centric dashboard semantics.
- Do not make SavedView team-only.
- Do not leave duplicate unsynced date-range controls.

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

Deliverable requirements:
- schema + migration
- shared scope helpers
- saved-view APIs
- reports library UI
- scope-aware Home
- tests

Final report format:
1. Summary
2. Files changed
3. Acceptance criteria status
4. Tests run
5. Risks/follow-ups
6. Escalations
```
