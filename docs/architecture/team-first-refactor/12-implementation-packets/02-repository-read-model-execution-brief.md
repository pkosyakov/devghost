# Execution Brief: Repository Read Model

Use this brief when handing `Slice 2: Repository Read Model` to a builder-AI for implementation.

## Intent

This is the first repository-facing slice after `Contributor Foundation`.

The builder must treat this slice as:

- a new canonical repository layer;
- workspace-scoped in the current production model;
- dependent on the existing canonical contributor layer;
- explicitly not dependent on `Team`, `SavedView`, or a global context bar.

This brief is intentionally execution-oriented. It assumes the architecture packet has already been approved.

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
- [repository-list.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\repository-list.md)
- [repository-detail.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\repository-detail.md)
- [02-repository-read-model.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\02-repository-read-model.md)
- [02-repository-read-model-delegation.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\02-repository-read-model-delegation.md)

## Base assumptions

The builder must assume all of the following are already true in the base branch/worktree:

- `Workspace` exists and is the current production scope boundary.
- `Contributor` and `ContributorAlias` already exist and are the canonical people layer.
- People-facing v2 APIs already exist and are the reference for entity-centric migration style.
- Legacy order creation/detail/publication flows still exist and must keep working.

If the current branch does not already contain the `Contributor Foundation` slice, stop and escalate instead of re-implementing it.

## Builder prompt

```text
Task: Implement `Slice 2: Repository Read Model`

You are building the second architectural slice of the DevGhost refactor.

Your goal is to introduce canonical repository identity and repository-facing read models so repository surfaces stop depending on order-local `selectedRepos` blobs and order IDs as the main business object.

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
- docs/architecture/team-first-refactor/07-screen-specs/repository-list.md
- docs/architecture/team-first-refactor/07-screen-specs/repository-detail.md
- docs/architecture/team-first-refactor/12-implementation-packets/02-repository-read-model.md
- docs/architecture/team-first-refactor/12-implementation-packets/02-repository-read-model-delegation.md
- docs/architecture/team-first-refactor/12-implementation-packets/02-repository-read-model-execution-brief.md

Primary goal:
Introduce canonical workspace-scoped repository identity and repository-facing read models so new repository surfaces work without exposing legacy Order/run semantics as the business-facing contract.

Hard constraints:
- Do not make repository the default landing experience.
- Do not block on Team, SavedView, schedules, or global context rollout.
- Do not bypass canonical Contributor identity by aggregating repository people from raw author emails.
- Do not fake PRs if canonical PR data does not exist yet.
- Do not break existing order creation/detail/publication flows.
- Do not redesign primary navigation beyond a minimal secondary Repositories entry if needed.
- Do not invent new domain terminology outside the glossary.

Required implementation outcomes:
1. Introduce a canonical workspace-scoped `Repository` concept in schema and app code.
2. Add an explicit repository projector / backfill / best-effort sync pattern, similar in shape to Slice 1.
3. Build repository read models that are business-facing and independent from raw `selectedRepos` JSON.
4. Ensure repeated analyses of the same provider/full-name repository collapse to one canonical repository identity.
5. Add repository-facing routes and screens:
   - repository list
   - repository detail
6. Expose repository freshness in business terms:
   - `lastUpdatedAt`
   - `freshnessStatus`
   - optional `delayedReason`
7. Reuse canonical contributors in repository detail and repository list metrics.
8. If canonical PR modeling is not ready, ship repository detail without fake PRs and with repository-local activity evidence instead.

Allowed write scope:
- packages/server/prisma/schema.prisma
- packages/server/prisma/migrations/**
- packages/server/scripts/**
- packages/server/src/app/api/v2/**
- packages/server/src/lib/**
- packages/server/src/app/[locale]/(dashboard)/repositories/**
- repository-specific components only
- packages/server/messages/en.json
- packages/server/messages/ru.json
- packages/server/src/components/layout/sidebar.tsx only for minimal secondary exposure

Read-only unless absolutely required and justified:
- packages/server/src/app/[locale]/(dashboard)/orders/**
- packages/server/src/app/api/orders/**
- packages/server/src/types/repository.ts
- publication/public profile surfaces
- current People surfaces except for necessary reuse

Important domain rules:
- Current production boundary is `Workspace`.
- Repository identity must be stable within `Workspace`.
- Repository-local people must resolve through canonical Contributor identity.
- Commit-backed activity panels are allowed.
- Commit-backed panels must not be presented as canonical PRs.
- Freshness must be understandable without job IDs or diagnostics-first UX.

Out of scope:
- Team model
- SavedView
- global context bar
- report schedules
- repository curation hub
- PR/work-item replatforming
- order flow replacement
- broad nav redesign

Acceptance criteria:
- There is a canonical workspace-scoped `Repository` concept in schema and app code.
- Repository population uses an explicit projector / backfill / best-effort sync pattern.
- One repository analyzed multiple times resolves to one repository in the new model.
- New repository-facing routes/screens use repository read models, not raw `selectedRepos` JSON.
- Repository list renders one row per canonical repository with freshness information.
- Repository detail is addressed by repository identity rather than order ID.
- Freshness is visible without surfacing run/job IDs as the primary UI.
- Canonical contributors are visible in repository detail.
- If PR data is unavailable, repository detail still provides repository-local activity value without fake PRs.
- Existing order-based pages and publication flows continue to function.

Required output format:
1. Summary of what you changed
2. Files changed
3. Acceptance criteria status, one by one
4. Tests run
5. Known risks / follow-ups
6. Escalations or unresolved gaps

Escalate instead of inventing behavior if:
- implementation would require changing a locked decision
- Team or SavedView rollout is required first
- repository detail can only be built as an order-detail wrapper
- canonical contributors cannot be reused in repository-local views
- you find yourself exposing raw Order IDs or selectedRepos as the main repository contract
```

## Suggested implementation order

1. Add canonical `Repository` schema and migration.
2. Add repository projector / sync service.
3. Add backfill support for historical orders.
4. Add repository read-model queries and v2 APIs.
5. Add repository list UI.
6. Add repository detail UI.
7. Add minimal nav exposure if low-risk.
8. Verify coexistence with legacy order/publication flows.

## Review checklist

### Domain and migration

- `Repository` exists as a canonical concept in schema and app code.
- `Repository` is scoped to `Workspace` in the current production slice.
- Repository identity is stable across repeated analyses of the same repo.
- There is an explicit projector / backfill / sync lifecycle.
- Legacy order engine remains intact.

### Data contracts

- New repository routes are business-facing.
- Repository list/detail do not expose `selectedRepos` JSON as their frontend contract.
- Repository detail is addressed by repository identity, not order ID.
- Repository-local people resolve through canonical contributors.

### UX

- Repository list shows canonical repositories, not order occurrences.
- Freshness is visible in business terms.
- Repository detail remains repo-local.
- If PR data is missing, the UI does not fake PRs.
- Any nav exposure is minimal and secondary.

### Validation

- schema/migration applies cleanly
- route tests cover repository list/detail
- canonicalization and freshness derivation have automated coverage
- projector/backfill/sync idempotency has automated coverage
- manual scenario with one repo appearing in multiple orders is demonstrated

## Rejection criteria

Reject the implementation if any of the following are true:

- repository identity is still effectively `selectedRepos` with a new label
- repository detail is still fundamentally an order-detail wrapper
- repository-local people are built on raw emails instead of canonical contributors
- PR-looking UI is backed only by commit group heuristics and is presented as canonical PR data
- freshness requires users to inspect run IDs or diagnostics to understand basic status
- the slice expands into Team, SavedView, reports, or broad nav refactor without approval
