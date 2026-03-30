# Execution Brief: Team Pivot

Use this brief when handing `Slice 3: Team Pivot` to a builder-AI for implementation.

## Intent

This is the first team-centered management slice after `Contributor Foundation` and `Repository Read Model`.

The builder must treat this slice as:

- a real `Team` and `TeamMembership` layer;
- workspace-scoped in the current production model;
- dependent on existing canonical `Contributor` and `Repository` layers;
- explicitly not dependent on `SavedView`, a global context bar, or final PR/work-item modeling.

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
- [team-list.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\team-list.md)
- [team-detail.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\team-detail.md)
- [03-team-pivot.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\03-team-pivot.md)

## Base assumptions

The builder must assume all of the following are already true in the base branch/worktree:

- `Workspace` exists and is the current production scope boundary.
- `Contributor` and `ContributorAlias` already exist and are the canonical people layer.
- repository-facing v2 APIs and screens already exist or are actively landing as the canonical repository layer.
- legacy order creation/detail/publication flows still exist and must keep working.

If the current branch does not already contain the `Contributor Foundation` slice, stop and escalate instead of re-implementing it.

## Builder prompt

```text
Task: Implement `Slice 3: Team Pivot`

You are building the third architectural slice of the DevGhost refactor.

Your goal is to introduce Team as the first real management scope so managers can work from a team-centered surface rather than composing context manually from contributors and repositories.

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
- docs/architecture/team-first-refactor/07-screen-specs/team-list.md
- docs/architecture/team-first-refactor/07-screen-specs/team-detail.md
- docs/architecture/team-first-refactor/12-implementation-packets/03-team-pivot.md
- docs/architecture/team-first-refactor/12-implementation-packets/03-team-pivot-execution-brief.md

Primary goal:
Introduce canonical workspace-scoped Team identity and TeamMembership so DevGhost gains a real team-centered management surface.

Hard constraints:
- Do not block on Organization rollout.
- Do not block on SavedView or global context bar.
- Do not reimplement contributor identity from raw emails.
- Do not make the team page an order-detail wrapper.
- Do not fake PRs if canonical PR data does not exist yet.
- Do not redesign the full Home/dashboard in this slice.
- Do not invent new domain terminology outside the glossary.

Required implementation outcomes:
1. Introduce a canonical workspace-scoped `Team` concept in schema and app code.
2. Introduce `TeamMembership` with effective dates and primary-team support.
3. Add a minimal write path so users can:
   - create a team
   - update team metadata
   - add/remove contributors
   - set effective dates
   - set/unset primary team
4. Add team-facing routes and screens:
   - teams list
   - team detail
5. Build team read models that reuse canonical contributors and canonical repositories.
6. Ensure repositories shown on a team page are derived from team-member activity in the selected period.
7. Allow local date-range query params on team pages for Slice 3.
8. If canonical PR modeling is not ready, ship team detail without fake PRs and with useful contributor/repository sections.

Allowed write scope:
- packages/server/prisma/schema.prisma
- packages/server/prisma/migrations/**
- packages/server/src/app/api/v2/**
- packages/server/src/lib/**
- packages/server/src/app/[locale]/(dashboard)/teams/**
- team-specific components only
- packages/server/messages/en.json
- packages/server/messages/ru.json
- packages/server/src/components/layout/sidebar.tsx
- packages/server/src/proxy.ts

Read-only unless absolutely required and justified:
- packages/server/src/app/[locale]/(dashboard)/people/**
- packages/server/src/app/[locale]/(dashboard)/repositories/**
- packages/server/src/app/api/orders/**
- packages/server/src/app/[locale]/(dashboard)/orders/**
- publication/public profile surfaces

Important domain rules:
- Current production boundary is `Workspace`.
- Team identity must be stable within `Workspace`.
- Team members are canonical contributors.
- Team repositories are activity-derived from member activity.
- Slice 3 may use full inclusion for multi-team contributors in team-local views.
- `primary team` is still required and should be respected for defaults and labels.
- Commit-backed evidence is allowed.
- Commit-backed evidence must not be presented as canonical PRs.

Out of scope:
- Organization
- SavedView
- global context bar
- full Home redesign
- schedule/report system
- org-level rollup dedupe customization
- PR/work-item replatforming
- full team repository pin/exclude settings subsystem

Acceptance criteria:
- There is a canonical workspace-scoped `Team` concept in schema and app code.
- There is a canonical workspace-scoped `TeamMembership` concept with effective dates and primary-team support.
- A minimal setup path exists to create a team and assign contributors.
- Teams list renders one row per canonical team.
- Team detail is addressed by team identity rather than order/repository identity.
- Team detail shows canonical contributors in team-local context.
- Team detail shows repositories derived from member activity in the selected period.
- Team routes and read models do not expose Order/job IDs as the main contract.
- The slice works without requiring SavedView, global context bar, or canonical PR model first.
- Existing people, repository, and order/publication flows continue to function.

Required output format:
1. Summary of what you changed
2. Files changed
3. Acceptance criteria status, one by one
4. Tests run
5. Known risks / follow-ups
6. Escalations or unresolved gaps

Escalate instead of inventing behavior if:
- implementation would require changing a locked decision
- SavedView or global context is required first
- team pages can only be built as order wrappers
- contributor identity would need to be rebuilt from raw emails
- org-wide dedupe logic becomes necessary to complete the slice
```

## Suggested implementation order

1. Add canonical `Team` and `TeamMembership` schema plus migration.
2. Add minimal team write-path services and APIs.
3. Add team read-model queries and v2 APIs.
4. Add teams list UI.
5. Add team detail UI.
6. Add minimal nav exposure.
7. Verify coexistence with people, repository, and legacy order/publication flows.

## Review checklist

### Domain and migration

- `Team` exists as a canonical concept in schema and app code.
- `TeamMembership` exists with effective dates and primary-team support.
- `Team` is scoped to `Workspace` in the current production slice.
- Team setup path exists and is usable.

### Data contracts

- Team routes are business-facing.
- Team list/detail do not expose order-local blobs as their frontend contract.
- Team detail is addressed by canonical team identity.
- Team-local people resolve through canonical contributors.
- Team repositories are derived from member activity.

### UX

- Teams list is a meaningful entry surface for managers.
- Team detail acts as a team-local workspace rather than a repo inventory page.
- If PR data is missing, the UI does not fake PRs.
- Any nav exposure is minimal and consistent with the current partial IA.

### Validation

- schema/migration applies cleanly
- route tests cover teams list/detail and membership write paths
- effective-date logic has automated coverage
- activity-derived repository list for a team has automated coverage
- manual scenario with one contributor on multiple teams is demonstrated

## Rejection criteria

Reject the implementation if any of the following are true:

- team identity is still effectively a saved filter over contributors with no real model
- team detail is fundamentally an order-detail wrapper
- team-local people are built from raw emails instead of canonical contributors
- repository list on a team page depends only on static assignment and not member activity
- PR-looking UI is backed only by commit heuristics and presented as canonical PR data
- the slice expands into SavedView, global context, reports, or broad Home redesign without approval
