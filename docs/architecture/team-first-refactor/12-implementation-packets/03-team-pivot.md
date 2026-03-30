# Implementation Packet: Team Pivot

## Goal

Introduce `Team` as the next stable business-facing entity so managers can work from a team-centered surface instead of stitching context together from repositories and individual contributors.

## Why this slice exists

After `Contributor Foundation` and `Repository Read Model`, DevGhost has the two core supporting entities needed for a real management scope.

This slice turns that foundation into the product's first team-centered workflow:

- teams become explicit objects instead of an implied org chart in someone's head;
- team pages aggregate canonical contributors and activity-derived repositories;
- managers gain a durable entry point that is closer to the target product than repo-by-repo navigation.

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
- [team-list.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\team-list.md)
- [team-detail.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\team-detail.md)

## Locked decisions

- `D-001` Primary management scope is `Team`
- `D-002` `Repository` stays first-class but not the default landing scope
- `D-003` Internal model uses `Contributor`
- `D-005` Contributor identity resolution is Phase 1 foundation work
- `D-012` Team membership uses point-in-time effective dates
- `D-013` Multi-team membership is allowed in the data model
- `D-014` Every contributor should have at most one primary team at a time
- `D-017` Legacy run engine stays in place during migration

## Write scope

Allowed write scope for this packet:

- `packages/server/prisma/schema.prisma`
- new Prisma migration files related to team identity or membership
- new domain-facing routes under `packages/server/src/app/api/v2/**`
- new lib/services/schemas/types for team read models under `packages/server/src/lib/**`
- new dashboard pages/components for team surfaces under:
  - `packages/server/src/app/[locale]/(dashboard)/teams/**`
  - `packages/server/src/components/**` only where needed for team-specific UI
- translations needed for new team UI in:
  - `packages/server/messages/en.json`
  - `packages/server/messages/ru.json`
- minimal nav exposure in:
  - `packages/server/src/components/layout/sidebar.tsx`
  - `packages/server/src/proxy.ts`

## Read-only context

Read but do not rewrite structurally unless escalation is approved:

- People surfaces under `packages/server/src/app/[locale]/(dashboard)/people/**`
- Repository surfaces under `packages/server/src/app/[locale]/(dashboard)/repositories/**`
- contributor/repository v2 APIs under `packages/server/src/app/api/v2/**`
- contributor identity/workspace services under `packages/server/src/lib/services/**`
- legacy order pages and APIs
- publication/public profile surfaces

## Out of scope

- `Organization`
- `SavedView`
- global context bar
- full `Home` redesign
- schedule/report delivery
- org-level rollup dedupe customization
- canonical PR/work-item model
- team repository pin/exclude rules if they require a separate settings subsystem
- broad settings/admin IA cleanup

## Implementation notes

### 1. Use `Workspace` as the production boundary

Until `Organization` exists in production, `Team` must be implemented as workspace-scoped.

Practical rule:

- do not block this slice on org rollout;
- do not invent temporary pseudo-org selectors;
- team routes and reads resolve through authenticated user's `Workspace`.

### 2. Introduce real `Team` and `TeamMembership`

This slice is not just a filtered contributors page.

Required v1 concepts:

- canonical `Team` identity
- `TeamMembership` with:
  - `effectiveFrom`
  - optional `effectiveTo`
  - `isPrimary`
  - optional `role`

### 3. Include a minimal setup path

Teams do not exist implicitly in the current product.

Therefore Slice 3 must include a minimal write path so the user can:

- create a team
- update team metadata
- add/remove contributors from the team
- set effective dates
- set/unset primary team membership

If there is no setup path, the slice is incomplete even if the read models exist.

### 4. Reuse canonical contributors and repositories

Team screens must not rebuild people or repo identity from raw legacy blobs.

Rules:

- team members are canonical `Contributor` records;
- team repositories are derived from member activity using the canonical contributor layer;
- repository rows on a team page should link to canonical repository detail, not order detail.

### 5. Slice 3 attribution behavior

Use the Slice 3 operating rule from [04-state-and-attribution-rules.md](C:\Projects\devghost\docs\architecture\team-first-refactor\04-state-and-attribution-rules.md):

- if a contributor has an active membership in a team during the selected period, their qualifying activity may appear on that team's page;
- one contributor may appear in multiple team pages in Slice 3;
- do not invent weighted attribution or org-wide dedupe behavior in this slice.

### 6. Team repositories are activity-derived

A repository should appear on a team page because team members were active there in the selected period.

Required Slice 3 behavior:

- derive repositories from team-member activity;
- do not require static repository assignment before the page becomes useful;
- manual pin/exclude controls may be deferred if not needed for the first useful version.

### 7. Date range is local in Slice 3

Because global context is not yet implemented:

- local query params may define team-page date range in Slice 3;
- this is acceptable as long as route identity remains canonical `teamId`;
- future global context must be able to replace local date-range state without redesigning the page.

### 8. PR section may remain unavailable

Target-state team UX is PR-centric.

Slice 3 may still ship without canonical PR modeling if:

- the PR section is empty or explicitly unavailable;
- contributors and repositories are still visible and useful;
- commit-backed tables are not mislabeled as canonical PRs.

## Acceptance criteria

- There is a canonical workspace-scoped `Team` concept in schema and app code.
- There is a canonical workspace-scoped `TeamMembership` concept with effective dates and primary-team support.
- A minimal setup path exists to create a team and assign contributors.
- `Teams List` exists and shows one row per canonical team.
- `Team Detail` exists and is addressed by team identity rather than order or repository identity.
- Team detail shows canonical contributors in team-local context.
- Team detail shows repositories derived from member activity in the selected period.
- Team-local routes and read models do not expose `Order`/job IDs as the main business-facing contract.
- Team slice works without requiring `SavedView`, global context bar, or canonical PR model first.
- Existing people, repository, and legacy order/publication flows continue to function.

## Validation

### Automated

- schema/migration applies cleanly
- route tests cover teams list and team detail
- team membership effective-date logic has automated coverage
- activity-derived repository list for a team has automated coverage

### Manual

- create a team in a workspace with existing contributors
- assign contributors with effective dates
- open team detail and verify members are visible
- verify active repositories are derived from member activity
- verify contributor and repository drill-down links work
- verify a contributor with multiple aliases still appears once on the team page

## Risks

- team setup can sprawl into full admin/settings UX if not bounded
- point-in-time membership logic can be implemented incorrectly if current-state shortcuts leak in
- lack of canonical PR data may tempt fake PR UI

## Escalation rules

Stop and escalate if:

- a locked decision would need to change;
- implementation would require `SavedView`, global context bar, or `Organization` first;
- team pages can only be implemented as thin wrappers around order detail;
- contributor identity would need to be reimplemented using raw email;
- org-wide dedupe or weighted multi-team attribution becomes necessary to complete the slice.
