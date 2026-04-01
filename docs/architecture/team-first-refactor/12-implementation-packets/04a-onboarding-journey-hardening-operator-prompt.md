# Operator Prompt: Onboarding Journey Hardening

Use this when the builder-AI needs a short, concrete handoff instead of the full architecture packet.

## Prompt

```text
Implement a bounded post-Slice-4 onboarding slice: `Onboarding Journey Hardening`.

Read first:
- docs/architecture/team-first-refactor/README.md
- docs/architecture/team-first-refactor/16-onboarding-and-maturity-journey.md
- docs/architecture/team-first-refactor/12-implementation-packets/04a-onboarding-journey-hardening.md
- packages/server/src/app/[locale]/(dashboard)/dashboard/page.tsx
- packages/server/src/app/[locale]/(dashboard)/orders/new/page.tsx
- packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx
- packages/server/src/app/[locale]/(dashboard)/repositories/page.tsx
- packages/server/src/app/[locale]/(dashboard)/repositories/[id]/page.tsx
- packages/server/src/app/[locale]/(dashboard)/teams/page.tsx
- packages/server/src/app/[locale]/(dashboard)/teams/[id]/page.tsx
- packages/server/src/components/layout/global-context-bar.tsx
- packages/server/src/components/layout/sidebar.tsx

Goal:
Turn the current onboarding-related surfaces into a coherent new-customer path:

Home
  -> Run first analysis
  -> Analysis results
  -> People review
  -> Repositories review
  -> Create first team from repository
  -> Team detail
  -> Save first view
  -> Reports

What to build:
1. Make early-stage UX feel less like a mature operational workspace.
   - `empty` and `first_data` should not expose advanced scope/reporting concepts too early.
2. Add explicit next-step guidance on completed analysis results for first-run users.
   - The screen should point users to:
     - `People`
     - `Repositories`
     - `Create first team from repository`
3. Improve discoverability of repo-seeded first-team creation.
   - Do not require the user to guess that the path is hidden deep in repository detail.
4. After first team creation, guide the user to save the first useful view.
   - Do not rely only on the global `Save View` button being noticed.

Hard rules:
- Do not add new schema or entities.
- Do not rename backend/domain `Order`.
- Do not rename routes away from `/orders/*`.
- Keep reusing canonical `Contributor`, `Repository`, `Team`, and `SavedView`.
- Do not regress mature workspace behavior.
- Do not make `Team` the first required concept before trust is established.
- Keep `Create team from repository` as the preferred first-team onboarding path.

Allowed write scope:
- packages/server/src/app/[locale]/(dashboard)/dashboard/**
- packages/server/src/app/[locale]/(dashboard)/orders/**
- packages/server/src/app/[locale]/(dashboard)/repositories/**
- packages/server/src/app/[locale]/(dashboard)/teams/**
- packages/server/src/app/[locale]/(dashboard)/reports/**
- packages/server/src/components/layout/**
- packages/server/src/lib/services/home-service.ts
- packages/server/messages/en.json
- packages/server/messages/ru.json
- tests adjacent to these files if needed

Out of scope:
- schema/migrations
- API contract redesign
- worker/queue changes
- full route rename to `/analyses`
- public sharing model
- scheduled reports
- diagnostics/curation slice work

Acceptance criteria:
- `empty` and `first_data` do not feel like full operational mode
- completed analysis results provide explicit onboarding handoff
- first-team-from-repository path is easier to discover
- after first team creation, the product clearly guides the user to save the first view
- mature workspaces continue to work
- typecheck passes

Final report format:
1. Summary
2. Files changed
3. Journey gaps closed
4. Acceptance criteria status
5. Tests run
6. Risks/follow-ups
```
