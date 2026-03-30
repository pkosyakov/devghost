# Operator Prompt: Team Pivot

Use this when the builder-AI needs a short, concrete handoff instead of the full architecture packet.

## Prompt

```text
Implement Slice 3: Team Pivot.

Read first:
- docs/architecture/team-first-refactor/README.md
- docs/architecture/team-first-refactor/04-state-and-attribution-rules.md
- docs/architecture/team-first-refactor/08-data-and-api-contracts.md
- docs/architecture/team-first-refactor/07-screen-specs/team-list.md
- docs/architecture/team-first-refactor/07-screen-specs/team-detail.md
- docs/architecture/team-first-refactor/12-implementation-packets/03-team-pivot.md

What to build:
1. Add canonical workspace-scoped `Team`.
2. Add canonical workspace-scoped `TeamMembership` with:
   - effectiveFrom
   - effectiveTo (nullable)
   - isPrimary
   - optional role
3. Add a minimal setup path:
   - create team
   - update team metadata
   - add/remove contributors
   - set effective dates
   - set/unset primary team
4. Add:
   - `/teams` list page
   - `/teams/[id]` detail page
   - `/api/v2/teams` read/write routes needed for this
5. Team detail must:
   - show canonical contributors
   - show repositories derived from member activity in the selected period
   - work without SavedView/global context/canonical PR model
6. Local date-range query params are allowed for Slice 3.

Hard rules:
- Current production boundary is `Workspace`, not `Organization`.
- Do not rebuild people identity from raw emails.
- Do not build the page as an order-detail wrapper.
- Do not fake PRs.
- Do not expand into SavedView, global context bar, or full Home redesign.

Allowed write scope:
- packages/server/prisma/schema.prisma
- packages/server/prisma/migrations/**
- packages/server/src/app/api/v2/**
- packages/server/src/lib/**
- packages/server/src/app/[locale]/(dashboard)/teams/**
- packages/server/messages/en.json
- packages/server/messages/ru.json
- packages/server/src/components/layout/sidebar.tsx
- packages/server/src/proxy.ts

Deliverable requirements:
- schema + migration
- APIs
- teams list/detail UI
- tests

Final report format:
1. Summary
2. Files changed
3. Acceptance criteria status
4. Tests run
5. Risks/follow-ups
6. Escalations
```
