# Implementation Packet: Repository Read Model

## Goal

Introduce canonical repository identity and repository-facing read models so new repository surfaces can work without treating legacy orders or snapshots as the primary business object.

## Why this slice exists

Repository is already a first-class concept in the target architecture, but today it only exists as `selectedRepos` embedded inside orders. That creates duplication, weak drill-down, and no stable freshness story across repeated analyses of the same repository.

Slice 1 changed the ground truth:

- `Workspace` now exists as the current production scope boundary;
- canonical `Contributor` / `ContributorAlias` now exist and must be reused;
- People surfaces proved we can add a new business-facing entity layer without replacing the legacy run engine.

This slice creates the operational repository catalog that later team, home, and reporting surfaces can build on.

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
- [repository-list.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\repository-list.md)
- [repository-detail.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\repository-detail.md)

## Locked decisions

- `D-001` `Team` is the primary management scope
- `D-002` `Repository` is first-class but not the default landing lens
- `D-008` `AnalysisSnapshot` replaces `Order` internally and must not be a primary UX object
- `D-010` `PullRequest` is the primary delivery unit in user-facing analytics
- `D-011` `Commit` remains the evidence layer, not the primary reporting surface
- `D-015` raw activity stays append-only; curation is layered on top
- `D-017` legacy run engine stays in place during migration

Slice 2 interpretation of locked decisions:

- `PullRequest` remains the target-state delivery object;
- Slice 2 is allowed to ship without canonical PR modeling if it does not fake PRs and remains repository-local, contributor-aware, and freshness-aware.

## Write scope

Allowed write scope for this packet:

- `packages/server/prisma/schema.prisma`
- new Prisma migration files related to canonical repository identity
- new domain-facing routes under `packages/server/src/app/api/v2/**` or equivalent dedicated domain namespace
- new lib/services/schemas/types for repository read models under `packages/server/src/lib/**`
- new dashboard pages/components for repository surfaces under:
  - `packages/server/src/app/[locale]/(dashboard)/repositories/**`
  - `packages/server/src/components/**` only where needed for repository-specific UI
- translations needed for new repository UI in:
  - `packages/server/messages/en.json`
  - `packages/server/messages/ru.json`
- optional low-risk secondary navigation exposure in:
  - `packages/server/src/components/layout/sidebar.tsx`

## Read-only context

Read but do not rewrite structurally unless escalation is approved:

- legacy order pages under `packages/server/src/app/[locale]/(dashboard)/orders/**`
- legacy order APIs under `packages/server/src/app/api/orders/**`
- current repository selection types in `packages/server/src/types/repository.ts`
- publication and public profile surfaces that currently inspect `selectedRepos`
- current analysis/snapshot services under `packages/server/src/lib/services/**` where repository freshness may be derived

## Migration constraint

Until full `Organization`, `Team`, and `SavedView` entities exist in production, `Workspace` is the real production boundary.

Practical meaning:

- do not block this slice on team rollout;
- model canonical repository identity as workspace-scoped;
- derive repository catalog and freshness from currently accessible legacy orders/snapshots through a facade;
- preserve a stable canonical repository identity across repeated analyses of the same repo;
- do not require users to understand order IDs or job IDs to use repository surfaces.

## Out of scope

- full `Team` model
- team auto-discovery logic
- global context bar
- `SavedView`
- schedules and report runs
- repository curation hub
- replacing existing order creation/selection flow
- full home/dashboard redesign
- full PR/work-item replatforming

## Implementation notes

### 1. Introduce canonical repository identity

At minimum, introduce a canonical `Repository` concept in schema and app code.

The implementation may derive its initial population from legacy order data, but it must stop treating each `selectedRepos` occurrence as a separate business object.

Required v1 rule:

- repository identity is stable inside `Workspace`;
- repeated analyses of one provider/full-name combination collapse to one canonical repository;
- repository routes and read models use canonical repository identity, not order ID.

### 2. Build the same projection pattern used in Slice 1

Repository population must not be a one-off ad hoc query buried in the UI.

Required pattern:

- idempotent repository projector / sync logic;
- one-time backfill for historical orders;
- best-effort update after analysis completion;
- canonicalization rules that can be rerun safely.

This can still be backed by legacy order data, but the lifecycle must be explicit.

### 3. Build a domain facade, not a direct legacy UI

New repository screens must not read directly from:

- `selectedRepos`
- order-local repo counts
- raw order IDs as the route identity

These can be used as migration inputs, but not as the business-facing contract returned to new pages.

### 4. Reuse canonical contributors

When repository read models show people:

- use canonical `Contributor` identity from Slice 1;
- do not aggregate or render repository-local people purely by raw author email;
- do not create a second parallel identity layer for repository pages.

If repository-local activity must still be derived from legacy commit rows, the facade must resolve those rows through the canonical contributor layer first.

### 5. Freshness must be business-facing

Repository surfaces must expose at least:

- `lastUpdatedAt`
- `freshnessStatus`
- optional `delayedReason`

Do not make users open diagnostics or inspect job IDs just to understand whether the repository data is fresh enough.

### 6. One repo, many legacy analyses

The same repository may already appear in many legacy orders.

Required v1 behavior:

- repeated analyses of the same provider/full-name combination resolve to one canonical repository;
- repository list shows one row per canonical repository;
- repository detail uses repository identity, not order identity;
- freshness is derived from the latest relevant legacy snapshot/activity.

### 7. Repository detail is target-state PR-first, Slice-2 commit-aware

Target-state repository detail should prioritize:

- PR activity
- active contributors
- anomalies / health

But Slice 2 must not block on a nonexistent PR domain layer.

Allowed Slice 2 behavior:

- PR section may be empty, unavailable, or explicitly marked as pending canonical PR modeling;
- contributor and repository-local activity sections are required;
- commit-level information may back summaries or evidence panels;
- commit groups must not be mislabeled as canonical PRs.

### 8. Legacy coexistence

Do not delete or break:

- existing order creation and order detail flows
- current publication flow that validates repo membership through order data
- public dev/profile surfaces that still read legacy repository metadata

This slice prepares a replacement path; it does not force cutover.

### 9. UI exposure

Acceptable options:

- add a `Repositories` route and expose it as secondary navigation if low-risk
- or ship the route without final IA cleanup if needed

Do not redesign the entire sidebar in this packet.

## Acceptance criteria

- There is a canonical `Repository` concept in schema and app code.
- `Repository` is scoped to `Workspace` in the current production model.
- One repository analyzed multiple times resolves to one repository in the new model.
- Repository population uses an explicit projector/sync pattern rather than ad hoc UI-only derivation.
- New repository-facing routes/screens use repository read models, not raw `selectedRepos` JSON as the frontend contract.
- `Repository List` exists and renders one row per canonical repository with freshness information.
- `Repository Detail` exists and is addressed by repository identity rather than order ID.
- Freshness is visible in repository surfaces without surfacing run/job IDs as the primary UI.
- Canonical contributors are visible in repository detail.
- If PR data is not canonically available yet, repository detail remains valid only if it does not fake PRs and still exposes repository-local activity evidence.
- Existing order-based pages and publication flows continue to function.

## Validation

### Automated

- schema validation / migration applies cleanly
- route tests for repository list/detail
- unit tests for repository canonicalization and freshness derivation
- unit tests for repository projector/backfill / sync idempotency
- tests proving repository-local people resolve through canonical contributors rather than raw email-only rows

### Manual

- create/import data where the same repository appears in multiple orders
- verify Repository List shows one canonical repository row, not repeated order-local entries
- verify Repository Detail shows freshness without exposing job IDs in the main layout
- verify repository detail shows canonical contributors rather than duplicate email identities
- verify order detail page still loads
- verify publication flow depending on legacy order repositories still works

## Risks

- overcoupling canonical repository identity to the legacy `selectedRepos` shape
- reintroducing raw email-only contributor aggregation in repository surfaces
- making repository catalog the de facto primary landing experience
- leaking snapshot/job semantics into primary repository UX
- assuming team/saved-view infrastructure or canonical PR modeling already exists

## Escalation rules

Stop and escalate if:

- implementation requires changing any locked decision in `01-decisions.md`
- the packet would require full `Team` or `SavedView` rollout before repository surfaces can land
- repository detail can only be implemented as a thin wrapper around order detail
- the new API contract cannot avoid direct business-facing dependence on legacy order-local repository semantics
- repository-local people can only be shown by bypassing canonical contributor identity
- builder-AI needs to redesign primary navigation beyond a minimal secondary `Repositories` entry
