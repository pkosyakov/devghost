# Delegation Brief: Repository Read Model

Use this brief when handing `Repository Read Model` to a builder-AI.

## Builder Prompt

```text
Task: Implement packet `02-repository-read-model`

You are implementing the second architectural slice of the DevGhost team-first refactor.

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

Primary goal:
Introduce canonical repository identity and repository-facing read models so new repository surfaces stop depending on order-local `selectedRepos` blobs and order IDs as the primary business object.

Hard constraints:
- Do not make repository the default landing experience.
- Do not block on full Team, SavedView, or global context rollout.
- Do not expose legacy `Order` or run/snapshot semantics as the business-facing contract for repository surfaces.
- Do not bypass canonical `Contributor` identity by aggregating repository people directly from raw author emails.
- Do not break existing order creation/detail/publication flows.
- Do not invent new domain terminology outside the glossary.
- Do not expand the task into team, reports, or curation-hub implementation.

Allowed write scope:
- packages/server/prisma/schema.prisma
- new Prisma migrations needed for canonical repository identity
- packages/server/src/app/api/v2/**
- packages/server/src/lib/**
- packages/server/src/app/[locale]/(dashboard)/repositories/**
- repository-specific components only
- packages/server/messages/en.json
- packages/server/messages/ru.json
- optional minimal secondary nav exposure in packages/server/src/components/layout/sidebar.tsx if low-risk

Read-only unless absolutely required and justified:
- packages/server/src/app/[locale]/(dashboard)/orders/**
- packages/server/src/app/api/orders/**
- packages/server/src/types/repository.ts
- publication/public profile surfaces using legacy repo metadata
- current analysis/snapshot services under packages/server/src/lib/services/**

Implementation requirements:
1. Introduce a canonical workspace-scoped `Repository` concept in schema and app code.
2. Build an explicit projector / backfill / best-effort sync pattern for repository identity and freshness, similar in shape to Slice 1.
3. Build a business-facing domain facade for repositories.
4. New repository surfaces must not use `selectedRepos` JSON or order IDs as the frontend contract.
5. Support stable repository identity across repeated analyses of the same provider/full-name repo.
6. Reuse canonical `Contributor` identity when repository surfaces show people.
7. Expose business-facing freshness in UI:
   - `lastUpdatedAt`
   - `freshnessStatus`
   - optional `delayedReason`
8. Prefer new domain routes under `/api/v2/...`.
9. Preserve coexistence with legacy order and publication flows.
10. Treat PR-first as target-state only: if canonical PR data is not available yet, ship repository detail as freshness-aware and contributor/activity-aware without faking PRs.

Migration constraint:
Until full Organization, Team, and SavedView entities exist in production, treat `Workspace` as the real production boundary. Derive repository catalog and freshness from currently accessible legacy orders/snapshots through a facade, but keep canonical repository identity stable for future attachment to org/team scope.

Out of scope:
- Team model
- team auto-discovery
- SavedView
- global context bar
- schedules/report runs
- repository curation hub
- full home/dashboard redesign
- order flow replacement

Acceptance criteria:
- There is a canonical workspace-scoped `Repository` concept in schema and app code.
- One repository analyzed multiple times resolves to one repository in the new model.
- Repository population uses an explicit projector / sync pattern rather than ad hoc UI-only derivation.
- New repository-facing routes/screens use repository read models, not raw `selectedRepos` JSON.
- `Repository List` exists and renders one row per canonical repository with freshness information.
- `Repository Detail` exists and is addressed by repository identity rather than order ID.
- Freshness is visible without surfacing run/job IDs as the primary UI.
- Canonical contributors are visible in repository detail.
- If PR data is not canonically available yet, repository detail does not fake PRs and still shows repository-local activity evidence.
- Existing order-based pages and publication flows continue to function.

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
- implementation requires full Team or SavedView rollout first
- repository detail can only be built as an order-detail wrapper
- the new API contract cannot avoid direct dependence on legacy order-local repository semantics
- a broader navigation redesign seems necessary
```

## Review Checklist

Use this checklist when reviewing builder-AI output.

### Architecture conformance

- `Repository` exists as a canonical concept.
- `Repository` is workspace-scoped in the current production slice.
- New code uses glossary vocabulary and does not reintroduce `Order` as the business term for repository surfaces.
- The implementation does not silently turn repository into the primary management scope.
- Legacy run/order engine remains intact.

### Data contract conformance

- New repository screens are backed by repository read models.
- Frontend contracts do not expose `selectedRepos` JSON or order IDs as the main repository identity.
- New domain routes are business-facing and preferably under `/api/v2/...`.
- Repeated analyses of the same repository collapse to one canonical repository record or facade identity.
- Repository-local people resolve through canonical contributors, not a second email-only identity layer.

### UX conformance

- Repository List shows canonical repositories, not order occurrences.
- Repository Detail is repo-local.
- Freshness is visible in business terms.
- If canonical PR data is missing, the UI does not fake PRs and still provides repository-local contributor/activity value.
- Any nav exposure for `Repositories` is minimal and stays secondary.

### Migration safety

- Existing order creation/detail pages still work.
- Existing publication flow that relies on order-local repository membership still works.
- Schema changes do not assume the full future org/team/saved-view model is already live.

### Validation expectations

- migration/schema checks pass
- route tests cover repository list/detail behavior
- canonicalization/freshness derivation has automated coverage
- projector/backfill/sync idempotency has automated coverage
- manual scenario for one repository appearing in multiple orders is demonstrated

## Rejection Criteria

Reject the implementation if any of these happen:

- builder-AI rewrites large parts of orders UI or primary navigation beyond the allowed scope
- repository logic is just a thin rename of `selectedRepos`
- repository detail is still fundamentally addressed by order ID
- freshness requires users to inspect run IDs or diagnostics to understand basic status
- repository-local people are rendered by bypassing canonical contributor identity
- the task expands into team, reporting, or curation-hub work without explicit approval
