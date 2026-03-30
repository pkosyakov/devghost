# Session Handoff

## Purpose

This document preserves the current state of the large DevGhost UX/domain refactor so a new Codex session can resume work without relying on chat memory.

Use this file together with:

- [README.md](C:\Projects\devghost\docs\architecture\team-first-refactor\README.md)
- [14-new-session-bootstrap.md](C:\Projects\devghost\docs\architecture\team-first-refactor\14-new-session-bootstrap.md)

## Program scope

This refactor is moving DevGhost from an order-centric UX to a team-first architecture with first-class:

- `Team`
- `Repository`
- `Contributor`
- `SavedView`

Current production bridge concepts:

- `Workspace` is the active scope boundary in the implemented slices.
- `AnalysisSnapshot` is the internal replacement concept for user-facing `Order`.

Primary source-of-truth package:

- [docs/architecture/team-first-refactor](C:\Projects\devghost\docs\architecture\team-first-refactor)

Broader narrative context:

- [2026-03-29-repository-developer-first-ux-design.md](C:\Projects\devghost\docs\plans\2026-03-29-repository-developer-first-ux-design.md)
- [docs/consultations/ux refactoring](C:\Projects\devghost\docs\consultations\ux%20refactoring)

## Completed architecture work

The artifact system is in place and should be treated as canonical:

- [00-north-star.md](C:\Projects\devghost\docs\architecture\team-first-refactor\00-north-star.md)
- [01-decisions.md](C:\Projects\devghost\docs\architecture\team-first-refactor\01-decisions.md)
- [02-ubiquitous-language.md](C:\Projects\devghost\docs\architecture\team-first-refactor\02-ubiquitous-language.md)
- [03-domain-model.md](C:\Projects\devghost\docs\architecture\team-first-refactor\03-domain-model.md)
- [04-state-and-attribution-rules.md](C:\Projects\devghost\docs\architecture\team-first-refactor\04-state-and-attribution-rules.md)
- [05-ux-ia.md](C:\Projects\devghost\docs\architecture\team-first-refactor\05-ux-ia.md)
- [06-screen-catalog.md](C:\Projects\devghost\docs\architecture\team-first-refactor\06-screen-catalog.md)
- [08-data-and-api-contracts.md](C:\Projects\devghost\docs\architecture\team-first-refactor\08-data-and-api-contracts.md)
- [10-delivery-slices.md](C:\Projects\devghost\docs\architecture\team-first-refactor\10-delivery-slices.md)
- [11-validation-pack.md](C:\Projects\devghost\docs\architecture\team-first-refactor\11-validation-pack.md)

Execution-ready packets exist for:

- [01-contributor-foundation.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\01-contributor-foundation.md)
- [02-repository-read-model.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\02-repository-read-model.md)
- [03-team-pivot.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\03-team-pivot.md)
- [04-global-scope-and-saved-views.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\04-global-scope-and-saved-views.md)

## Completed product/design work

Contributor Foundation design and plan are complete and reviewed:

- Spec: [2026-03-29-contributor-foundation-design.md](C:\Projects\devghost\docs\superpowers\specs\2026-03-29-contributor-foundation-design.md)
- Plan: [2026-03-29-contributor-foundation.md](C:\Projects\devghost\docs\superpowers\plans\2026-03-29-contributor-foundation.md)

Repository Read Model architecture was rewritten after Slice 1 so it matches the implemented `Workspace` and `Contributor` foundation:

- Packet: [02-repository-read-model.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\02-repository-read-model.md)
- Delegation brief: [02-repository-read-model-delegation.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\02-repository-read-model-delegation.md)
- Execution brief: [02-repository-read-model-execution-brief.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\02-repository-read-model-execution-brief.md)
- Operator prompt: [02-repository-read-model-operator-prompt.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\02-repository-read-model-operator-prompt.md)

## Delivery status by slice

### Slice 1: Contributor Foundation

Status:

- implemented
- reviewed
- merged to `master`

Meaning:

- `Workspace`
- `Contributor`
- `ContributorAlias`
- contributor projection
- people screens
- contributor APIs

...are now real code and must be treated as existing production foundation, not as future architecture.

### Slice 2: Repository Read Model

Status:

- implemented
- reviewed
- merged to `master`

Repository slice must build on Slice 1:

- repository identity is `Workspace`-scoped
- contributor attribution must reuse canonical `Contributor`
- repository UX must not surface legacy order/job identity as the main business object

### Slice 3: Team Pivot

Status:

- implementation is active on `feature/team-pivot`
- the branch contains Team schema, APIs, screens, and tests
- this slice should be treated as the current code baseline for designing Slice 4

Practical meaning:

- team list/detail already exist in code;
- team detail currently owns local `from/to` analytical state;
- Slice 4 must design against this real implementation, not against the older plan-only picture.

### Slice 4: Global Scope and Saved Views

Status:

- architecture packet exists
- execution brief exists
- operator prompt exists
- screen specs exist for `Home`, `Global Context Bar`, `Saved View List`, and `Saved View Detail`

Current next-step packet:

- [04-global-scope-and-saved-views.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\04-global-scope-and-saved-views.md)
- [04-global-scope-and-saved-views-execution-brief.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\04-global-scope-and-saved-views-execution-brief.md)
- [04-global-scope-and-saved-views-operator-prompt.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\04-global-scope-and-saved-views-operator-prompt.md)

## Current Git/worktree state

At the time this handoff was written:

- main workspace: [C:\Projects\devghost](C:\Projects\devghost)
- active branch in the main workspace: `feature/team-pivot`
- current `git worktree list --porcelain` shows only the main workspace worktree
- the former Slice 2 worktree at [C:\Projects\devghost\.worktrees\repository-read-model](C:\Projects\devghost\.worktrees\repository-read-model) has been removed
- the former branch `feature/repository-read-model` has been deleted after merge

Main workspace note:

- the main workspace currently contains local doc/architecture changes that are not committed on `master`;
- treat the files on disk under `docs/architecture/team-first-refactor` as the latest local source of truth for this machine, even if `git status` is dirty.

Important operating rule:

- always run `git worktree list --porcelain` at the start of a fresh session;
- do not assume the active implementation is in the main workspace;
- review and edits should happen in the worktree that actually appears in `git worktree list --porcelain`, not in a remembered path from an earlier session.

## Latest known review state for Slice 2

Repository Read Model was iteratively reviewed in:

- the former dedicated worktree [C:\Projects\devghost\.worktrees\repository-read-model](C:\Projects\devghost\.worktrees\repository-read-model)

Latest known state:

- the previously raised static code-review findings for Slice 2 were addressed;
- the last review pass did not identify new code findings;
- Slice 2 is already merged to `master`;
- the dedicated repository worktree and feature branch were cleaned up after merge.

## Latest known review state for Slice 3 plan and code

The current Team Pivot implementation plan is:

- [2026-03-30-team-pivot.md](C:\Projects\devghost\docs\superpowers\plans\2026-03-30-team-pivot.md)

All previously open plan-review findings were resolved across four review rounds:

1. Migration: uses `prisma migrate dev` (local) / `prisma migrate deploy` (staging/prod), never `db:push`. DDL verification via `rg`.
2. Membership overlap: validated as domain invariant in both `addMember()` and `updateMembership()`, with dedicated test coverage.
3. Teams List: matches locked contracts — `teamId`, `memberCount` (distinct contributors), `activeRepositoryCount`, `lastActivityAt`, `healthStatus` (Slice 3 placeholder), workspace-wide summary (`teamCount`/`activeTeamCount`/`memberedContributorCount`), sortable repos column.
4. Derived-key sorting: two-path strategy (DB-sort + skip/take for `name`/`createdAt`; fetch-all + in-memory sort + splice for derived fields). Tests cover global sort correctness across pages.
5. memberCount semantics: unified to distinct contributors across list rows, sort, and detail KPIs.

Non-blocking notes for future slices:

- `activeContributorCount` is computed but not yet shown in TeamTable (UI simplification, not a contract gap).
- Summary strip is workspace-wide while table is search-filtered — may need copy/tooltip later for clarity.
- Derived-sort fetches all matching teams into memory — acceptable for Slice 3 scale, may need precomputed aggregates at scale.

Current code reality on `feature/team-pivot`:

- Team list/detail APIs and screens exist;
- team detail uses shared `from/to` params across local widgets, but still owns that state locally;
- the dashboard layout remains the obvious insertion point for Slice 4 global scope chrome;
- `/dashboard` is still order-centric and must be replaced by scope-aware `Home` in Slice 4.

## Latest known design state for Slice 4

Slice 4 has been designed against the real Slice 3 implementation baseline.

Prepared artifacts:

- [04-global-scope-and-saved-views.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\04-global-scope-and-saved-views.md)
- [04-global-scope-and-saved-views-execution-brief.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\04-global-scope-and-saved-views-execution-brief.md)
- [04-global-scope-and-saved-views-operator-prompt.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\04-global-scope-and-saved-views-operator-prompt.md)
- [home.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\home.md)
- [global-context-bar.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\global-context-bar.md)
- [saved-view-list.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\saved-view-list.md)
- [saved-view-detail.md](C:\Projects\devghost\docs\architecture\team-first-refactor\07-screen-specs\saved-view-detail.md)

Locked Slice 4 decisions already reflected in the architecture package:

- `ActiveScope` is URL-backed in Slice 4 v1;
- `SavedView` is workspace-scoped in production until `Organization` exists;
- separate persisted `Dashboard` object is deferred;
- `/dashboard` becomes the scope-aware `Home`;
- Team Detail local date controls must be replaced or synchronized where the global context bar is introduced.

## Recommended resume protocol

When resuming this initiative in a new session:

1. Read [README.md](C:\Projects\devghost\docs\architecture\team-first-refactor\README.md).
2. Read this handoff file.
3. Read [14-new-session-bootstrap.md](C:\Projects\devghost\docs\architecture\team-first-refactor\14-new-session-bootstrap.md).
4. Check `git worktree list --porcelain`.
5. Inspect the relevant worktree status before making any assumptions.
6. Treat the architecture package as source of truth unless a more recent spec/plan explicitly supersedes it.
7. If implementation and contracts diverge, fix the contracts first or record the delta explicitly before continuing.

## Rules for future sessions

- Do not trust chat memory over repo artifacts.
- Do not let builder-AI invent behavior outside the packet/contracts.
- Do not review or edit the wrong worktree.
- Do not silently replace `Contributor` logic with raw email aggregation.
- Do not reintroduce `Order` as a primary UX entity in new slices.

## Next likely steps

Depending on where the code stands when the next session begins, the next action will usually be one of:

1. review or complete the active `feature/team-pivot` implementation;
2. if Slice 3 is merge-ready, merge it and clean up the branch/worktree state;
3. then hand off [04-global-scope-and-saved-views.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\04-global-scope-and-saved-views.md) for implementation.
