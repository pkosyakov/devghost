# Operator Prompt: Analysis Results Landing

Use this when the builder-AI needs a short, concrete handoff instead of the full architecture packet.

## Prompt

```text
Implement a bounded post-analysis slice: `Analysis Results Landing`.

Read first:
- docs/architecture/team-first-refactor/README.md
- docs/architecture/team-first-refactor/01-decisions.md
- docs/architecture/team-first-refactor/06-screen-catalog.md
- docs/architecture/team-first-refactor/16-onboarding-and-maturity-journey.md
- docs/architecture/team-first-refactor/12-implementation-packets/04c-analysis-results-landing.md
- packages/server/src/app/[locale]/(dashboard)/dashboard/page.tsx
- packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx
- packages/server/src/app/api/orders/[id]/route.ts
- packages/server/src/app/api/orders/[id]/metrics/route.ts
- packages/server/src/app/api/v2/home/route.ts
- packages/server/src/app/[locale]/(dashboard)/people/page.tsx
- packages/server/src/app/[locale]/(dashboard)/repositories/page.tsx

Goal:
Make completed analysis results a first-class customer-facing surface in the new journey, so the user can immediately see the value of a finished analysis and then move into canonical workspace screens.

Important clarification:
- existing `Analyses` navigation already provides generic access to analyses;
- this slice is about fixing the customer journey and information hierarchy, not inventing access from zero.
- this is a bounded migration slice, not a new permanent primary analytics object.

Target journey:
Home
  -> Run first analysis
  -> Analysis Results
  -> People review
  -> Repositories review
  -> Create first team from repository
  -> Team detail
  -> Save first view

What to build:
1. Reframe completed analysis detail as `Analysis Results`.
   - It should read like a results landing, not an internal run console.
2. Keep bubble chart / ghost insight / contributor comparison visible early on the completed-analysis screen.
   - Do not force these visuals into `Home` in this slice.
3. Add strong next-step handoff from completed analysis into:
   - `People`
   - `Repositories`
   - `Create first team from repository`
4. Add a clear way from transitional `Home` back into the latest completed analysis results.
   - Prevent the feeling that the analysis outcome disappeared after processing.
5. Preserve a lightweight return path when the user follows handoff CTAs from results into `People` or `Repositories`.
   - Query-param or contextual-banner approaches are fine.
   - The goal is not permanent global nav duplication; it is not losing the current analysis context immediately.
6. De-emphasize technical panels for first-run users.
   - Logs, benchmark controls, infra-heavy sections, and similar panels should not dominate the top of the completed-analysis experience.

Framing requirement:
- Describe `Analysis Results` as a transitional post-analysis landing.
- Preserve bubble chart / ghost insight as migration-era evidence with current customer value.
- Do not frame them as the final long-term analytical center of the product.

Hard rules:
- Do not add new schema or entities.
- Do not rename backend/domain `Order`.
- Do not rename routes away from `/orders/*`.
- Do not migrate all order-scoped metrics into canonical contributor/repository/team models in this slice.
- Keep existing analysis engine and APIs unless a thin presentation-layer change is enough.
- Preserve access to advanced technical panels for experienced users/admins.
- Keep `Create team from repository` as the preferred first management step.
- Do not build a brand-new all-analyses library in this slice.
- Reuse the existing `Analyses` navigation for broad access to older analyses; this slice only needs an explicit `latest results` journey path.
- Any return path from `People` / `Repositories` must be contextual and temporary, not a permanent new navigation contract.
- Prefer lightweight query-param or return-context propagation over durable coupling.

Allowed write scope:
- packages/server/src/app/[locale]/(dashboard)/dashboard/**
- packages/server/src/app/[locale]/(dashboard)/orders/**
- packages/server/src/app/api/orders/**
- packages/server/src/app/api/v2/home/**
- packages/server/src/components/**
- packages/server/src/hooks/**
- packages/server/src/lib/services/home-service.ts
- packages/server/messages/en.json
- packages/server/messages/ru.json
- adjacent tests if needed

Out of scope:
- schema/migrations
- worker rewrite
- benchmark redesign
- diagnostics/data-health redesign
- route rename to `/analyses`
- public sharing / schedules
- full canonicalization of ghost metrics

Acceptance criteria:
- a completed analysis clearly exposes the value of the run on a customer-facing results screen
- bubble chart / ghost insight remain visible and easy to understand
- results explicitly hand off into `People`, `Repositories`, and first-team creation
- transitional `Home` provides a clear return path to latest results
- `People` / `Repositories` can offer a lightweight return path when entered from analysis-results handoff
- technical panels no longer dominate the first-run completed-analysis experience
- typecheck passes
- the implementation clearly reads as a transitional landing layer, not a new permanent analytics center

Final report format:
1. Summary
2. Files changed
3. Results-path gaps closed
4. Acceptance criteria status
5. Tests run
6. Risks / follow-ups
```
