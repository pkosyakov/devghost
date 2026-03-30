# Implementation Packet: Contributor Foundation

## Goal

Introduce canonical contributor identity as a first-class domain layer so new people-facing analytics can stop depending on per-order extracted developer blobs and local dedup mappings.

## Why this slice exists

Every downstream surface in the refactor depends on correct person identity:

- team rollups
- repository contributor summaries
- people directory
- curation
- reporting

If one real person is still split across multiple git identities, every later slice inherits corrupted numbers.

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
- [people-list.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\people-list.md)
- [contributor-detail.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\contributor-detail.md)

## Locked decisions

- `D-003` internal model uses `Contributor`
- `D-004` `User` and `Contributor` are distinct
- `D-005` contributor identity resolution is Phase 1 foundation work
- `D-008` infrastructure run concepts must not become primary UX objects
- `D-015` raw events are append-only; curation is separate
- `D-016` curation should prefer incremental recomputation
- `D-017` legacy run engine stays in place during migration

## Write scope

Allowed write scope for this packet:

- `packages/server/prisma/schema.prisma`
- new Prisma migration files related to contributor identity
- new domain-facing routes under `packages/server/src/app/api/v2/**` or equivalent dedicated domain namespace
- new lib/services/schemas/types for contributor identity under `packages/server/src/lib/**`
- new dashboard pages/components for people surfaces under:
  - `packages/server/src/app/[locale]/(dashboard)/people/**`
  - `packages/server/src/components/**` only where needed for people-specific UI
- translations needed for new people/identity UI in:
  - `packages/server/messages/en.json`
  - `packages/server/messages/ru.json`
- minimal People navigation exposure in:
  - `packages/server/src/components/layout/sidebar.tsx`

## Read-only context

Read but do not rewrite structurally unless escalation is approved:

- legacy order pages under `packages/server/src/app/[locale]/(dashboard)/orders/**`
- legacy order APIs under `packages/server/src/app/api/orders/**`
- current dedup logic in `packages/server/src/lib/deduplication.ts`
- current publication/profile features unless required for type reuse

## Migration constraint

Until full `Organization` and `Team` entities exist in production, treat the authenticated user's accessible data boundary as the temporary workspace boundary.

Practical meaning:

- implement a minimal `Workspace` ownership boundary that is effectively `1:1` with the current `User`;
- do not block this slice on full org/team rollout;
- build `Contributor` foundation over the currently accessible dataset;
- design schema and APIs so they can later attach cleanly to `Organization` and `Team`.

## Out of scope

- full `Team` model
- full `Repository` read model
- global context bar
- `SavedView`
- schedules and report runs
- full curation hub
- replacing all legacy order-based developer flows
- full nav redesign to the final target IA

## Implementation notes

### 1. Introduce canonical contributor entities

At minimum, introduce:

- `Workspace` as a temporary ownership boundary (`1:1` with `User`)
- `Contributor`
- `ContributorAlias`

Do not use a global contributor pool for this slice.

Reason:

- one user must not be able to affect another user's contributor graph during the migration era.

### 2. Build a domain facade, not a direct legacy UI

New People screens must not read directly from:

- `selectedDevelopers`
- `developerMapping`
- `excludedDevelopers`

These can be used as migration inputs, but not as the business-facing contract returned to new pages.

### 3. Alias resolution rules for v1

Required v1 rules:

- exact match by provider ID when available
- exact match by email
- unresolved alias bucket for everything else

Optional if cheap:

- suggested fuzzy matches by name + domain

### 4. Creation lifecycle for contributors

Contributor materialization for this slice should use:

- one-time backfill for existing legacy orders
- idempotent projection when an analysis reaches completed state

Do not rely on lazy creation triggered by the first `/people` page visit.

### 5. First-class identity health

The slice must expose identity quality in the UI, not hide it.

At minimum:

- unresolved alias count
- contributor-level identity health badge/status
- unresolved queue summary/filter on People List
- path from people list into contributor detail / identity review

### 6. Contributor detail in Slice 1

Target-state contributor detail is PR-first, but Slice 1 must not invent fake PR groupings.

Required Slice 1 behavior:

- show aliases
- show summary
- show repository breakdown
- show commit/activity evidence

Allowed Slice 1 compromise:

- PR section may be empty, omitted, or clearly marked as unavailable / coming later.

### 7. New routes should use business naming

Prefer a new domain namespace such as:

- `/api/v2/contributors`
- `/api/v2/contributors/[id]`
- `/api/v2/contributors/identity-queue`

Do not add this as more `/api/orders/*` behavior.

### 8. Legacy coexistence

Do not delete or break:

- existing order detail dedup workflow
- current analysis flow
- current publication/profile flows

This slice should coexist and prepare replacement, not force cutover.

### 9. UI exposure

Add a minimal `People` entry to sidebar navigation in this slice.

Constraint:

- do not redesign the entire sidebar in this packet.

### 10. Localization

Ship full `en` and `ru` localization for all new user-facing People surfaces in this slice.

## Acceptance criteria

- There is a canonical `Contributor` concept in schema and app code.
- There is a temporary `Workspace`-like ownership boundary that prevents cross-user contributor mutation during migration.
- One person with multiple git identities can resolve to one contributor in the new model.
- New people-facing routes/screens use contributor read models, not raw order-local developer blobs.
- `People List` exists and renders one row per canonical contributor.
- `Contributor Detail` exists and shows aliases, summary, repository breakdown, and cross-repo activity context.
- `Contributor Detail` does not need a real PR table in Slice 1 if commit evidence is presented honestly.
- Unresolved aliases are visible through an identity-review-oriented read model.
- In Slice 1, unresolved aliases are visible from the main People surface via summary/section/filter.
- Excluding or classifying a contributor can be expressed through domain-facing actions without deleting raw activity.
- Existing and new People UI ships with both `en` and `ru` strings.
- Existing order-based pages continue to function.

## Validation

### Automated

- schema validation / migration applies cleanly
- route tests for contributor list/detail/identity queue
- unit tests for alias merge rules
- tests cover idempotent backfill/projection behavior if separate projector logic is introduced

### Manual

- create/import data where the same person appears under two emails
- verify People List shows one contributor row, not two aliases
- verify People nav entry is available without broader sidebar churn
- verify Contributor Detail shows alias membership clearly
- verify Contributor Detail remains useful even if PR section is unavailable
- verify unresolved alias appears in queue/read model
- verify existing order detail page still loads

## Risks

- overcoupling new contributor model to legacy `Order` JSON blobs
- premature team/org assumptions in schema
- sidebar churn leaking into this foundational slice
- trying to solve all curation in the same packet

## Escalation rules

Stop and escalate if:

- implementation requires changing any locked decision in `01-decisions.md`
- the packet would require full `Team` rollout before contributor identity can land
- the new API contract cannot avoid direct dependence on legacy order-local semantics
- builder-AI needs to redesign primary navigation beyond a minimal People entry
