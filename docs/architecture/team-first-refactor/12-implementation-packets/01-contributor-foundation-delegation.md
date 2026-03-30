# Delegation Brief: Contributor Foundation

Use this brief when handing `Contributor Foundation` to a builder-AI.

## Builder Prompt

```text
Task: Implement packet `01-contributor-foundation`

You are implementing the first architectural slice of the DevGhost team-first refactor.

Read first:
- docs/architecture/team-first-refactor/00-north-star.md
- docs/architecture/team-first-refactor/01-decisions.md
- docs/architecture/team-first-refactor/02-ubiquitous-language.md
- docs/architecture/team-first-refactor/03-domain-model.md
- docs/architecture/team-first-refactor/04-state-and-attribution-rules.md
- docs/architecture/team-first-refactor/05-ux-ia.md
- docs/architecture/team-first-refactor/06-screen-catalog.md
- docs/architecture/team-first-refactor/08-data-and-api-contracts.md
- docs/architecture/team-first-refactor/10-delivery-slices.md
- docs/architecture/team-first-refactor/07-screen-specs/people-list.md
- docs/architecture/team-first-refactor/07-screen-specs/contributor-detail.md
- docs/architecture/team-first-refactor/12-implementation-packets/01-contributor-foundation.md

Primary goal:
Introduce canonical contributor identity as a first-class domain layer so new people-facing analytics stop depending on per-order extracted developer blobs and order-local dedup mappings.

Hard constraints:
- Do not redesign the entire navigation.
- Do not block on full Organization or Team rollout.
- Do not make legacy `Order` semantics the business-facing contract for new People surfaces.
- Do not break existing order-based flows.
- Do not invent new domain terminology outside the glossary.
- Do not expand the task into repository/team/saved-view implementation.

Allowed write scope:
- packages/server/prisma/schema.prisma
- new Prisma migrations needed for contributor identity
- packages/server/src/app/api/v2/**
- packages/server/src/lib/**
- packages/server/src/app/[locale]/(dashboard)/people/**
- people-specific components only
- packages/server/messages/en.json
- packages/server/messages/ru.json
- minimal People sidebar exposure in packages/server/src/components/layout/sidebar.tsx

Read-only unless absolutely required and justified:
- packages/server/src/app/[locale]/(dashboard)/orders/**
- packages/server/src/app/api/orders/**
- packages/server/src/lib/deduplication.ts
- publication/profile features

Implementation requirements:
1. Introduce a temporary `Workspace` ownership boundary (`1:1` with the current `User`) plus canonical contributor entities (`Contributor`, `ContributorAlias`) in schema and app code.
2. Build a business-facing domain facade for contributors.
3. New People surfaces must not read directly from `selectedDevelopers`, `developerMapping`, or `excludedDevelopers` as frontend contracts.
4. Support v1 alias resolution with:
   - exact provider-id match when available
   - exact email match
   - unresolved alias bucket
5. Materialize contributors via:
   - one-time backfill for legacy orders
   - idempotent projection when analysis reaches completed state
   - not via lazy creation on first `/people` visit
6. Expose identity quality visibly in UI:
   - unresolved alias count
   - contributor identity health
   - unresolved queue summary/filter on People List
   - path to identity review/read model
7. In Slice 1, `Contributor Detail` may be commit-centric if canonical PR data is not ready yet. Do not invent fake PR grouping; use repository breakdown + commit evidence honestly.
8. Add minimal People nav exposure.
9. Ship full `en` and `ru` localization for new user-facing People surfaces.
10. Prefer new domain routes under `/api/v2/...`.
11. Preserve coexistence with legacy order flows.

Migration constraint:
Until full Organization and Team entities exist in production, treat the authenticated user's accessible data boundary as the temporary workspace boundary. Implement this as a minimal `Workspace` model that maps `1:1` to the current `User`, and design schema/routes so it can later attach cleanly to Organization and Team.

Out of scope:
- Team model
- Repository read model
- SavedView
- global context bar
- schedules/report runs
- full curation hub
- complete nav rewrite

Acceptance criteria:
- There is a canonical `Contributor` concept in schema and app code.
- There is a temporary `Workspace`-like ownership boundary preventing cross-user contributor mutation during migration.
- One person with multiple git identities can resolve to one contributor in the new model.
- New people-facing routes/screens use contributor read models, not raw order-local developer blobs.
- `People List` exists and renders one row per canonical contributor.
- `Contributor Detail` exists and shows aliases, summary, repository breakdown, and cross-repo activity context.
- `Contributor Detail` may ship without a real PR table in Slice 1 if commit evidence is presented honestly.
- Unresolved aliases are visible through an identity-review-oriented read model.
- In Slice 1, unresolved aliases are visible from the main People surface via summary/section/filter.
- Excluding or classifying a contributor can be expressed through domain-facing actions without deleting raw activity.
- A minimal `People` nav entry exists.
- New People UI ships with both `en` and `ru` strings.
- Existing order-based pages continue to function.

Required output format:
1. Summary of what you changed
2. Files changed
3. Acceptance criteria status, one by one
4. Tests run
5. Known risks / follow-ups
6. Escalations or unresolved gaps

Escalation rules:
Stop and report instead of inventing behavior if:
- a locked decision in 01-decisions.md would need to change
- implementation requires full Team rollout first
- the new API contract cannot avoid direct dependence on legacy order-local semantics
- a broader nav redesign seems necessary
```

## Review Checklist

Use this checklist when reviewing builder-AI output.

### Architecture conformance

- `Contributor` and `ContributorAlias` exist as canonical concepts.
- New code uses the glossary vocabulary and does not reintroduce `Order` as the business term for people surfaces.
- The implementation does not silently smuggle in `Team` or `SavedView` scope logic beyond this slice.
- Legacy run/order engine remains intact.

### Data contract conformance

- New People screens are backed by contributor read models.
- Frontend contracts do not expose `selectedDevelopers`, `developerMapping`, or `excludedDevelopers`.
- New domain routes are business-facing and preferably under `/api/v2/...`.
- contributor ownership is scoped through the temporary workspace boundary, not a global contributor pool

### UX conformance

- People List shows canonical contributors, not aliases.
- Contributor Detail is cross-repo by default.
- Identity health is visible, not hidden.
- unresolved identity queue is surfaced on People List rather than hidden on a separate admin-only page in Slice 1.
- Contributor Detail does not fake PR analytics when only commit evidence exists.
- People nav exposure is minimal and does not mutate unrelated IA.

### Migration safety

- Existing order pages still work.
- Existing dedup/mapping flows are not removed.
- Schema changes do not assume the full future org/team model is already live.

### Validation expectations

- migration/schema checks pass
- route tests cover list/detail/identity queue behavior
- alias merge rules have automated coverage
- backfill/projection behavior is covered if a separate projector exists
- manual scenario for one person with multiple emails is demonstrated

## Rejection Criteria

Reject the implementation if any of these happen:

- builder-AI rewrites large parts of orders UI or sidebar beyond the allowed scope
- contributor logic is just a thin rename of `selectedDevelopers`
- unresolved aliases are not represented in any readable model
- People screens depend directly on legacy order-local JSON contracts
- the task expands into team, repository, or reporting work without explicit approval
