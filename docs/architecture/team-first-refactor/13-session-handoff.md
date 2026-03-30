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

- implemented
- reviewed
- merged to `master`

Meaning:

- `Team` CRUD, membership, activity-derived repositories, detail page
- team list/detail APIs and screens are production code
- team detail uses shared scope params via `GlobalContextBar` (introduced in Slice 4)

### Slice 4: Global Scope and Saved Views

Status:

- implemented
- reviewed
- merged to `master`

Meaning:

- `ActiveScope` is URL-backed (`scopeKind`, `scopeId`, `from`, `to`, `repositoryIds`, `contributorIds`)
- `SavedView` CRUD with workspace-scoped visibility
- `GlobalContextBar` provides shared scope controls on analytical paths
- `/dashboard` is now scope-aware `Home` with maturity-based stages
- `Reports` page lists/manages saved views

### Slice 4A: Onboarding Journey Hardening

Status:

- implemented
- reviewed (two review rounds, all findings resolved)
- merged to `master`

Meaning:

- `/api/v2/workspace-stage` lightweight endpoint drives maturity-aware UX
- `useWorkspaceStage()` client hook with 5-min cache + invalidation on all mutations
- `GlobalContextBar` hidden for `empty`/`first_data` stages (queries also disabled)
- sidebar dims Teams and Reports for early-stage users
- analysis results show onboarding handoff card for `first_data` users
- repository list shows first-team bootstrap banner
- team detail prompts first saved view when `needsFirstSavedView`
- `workspace-stage` cache invalidated on: analysis completion, team creation (2 paths), saved view creation, saved view archive/restore (2 paths)

## Current Git/worktree state

At the time this handoff was written (2026-03-31):

- main workspace: [C:\Projects\devghost](C:\Projects\devghost)
- active branch in the main workspace: `master`
- no active worktrees or feature branches
- all slices through 4A are merged to `master`

Important operating rule:

- always run `git worktree list --porcelain` at the start of a fresh session;
- do not assume the active implementation is in the main workspace;
- review and edits should happen in the worktree that actually appears in `git worktree list --porcelain`, not in a remembered path from an earlier session.

## Review history (merged slices)

All slices through 4A have been reviewed and merged. Key non-blocking notes for future slices:

- `activeContributorCount` is computed but not yet shown in TeamTable (UI simplification, not a contract gap).
- Summary strip is workspace-wide while table is search-filtered — may need copy/tooltip later for clarity.
- Derived-sort fetches all matching teams into memory — acceptable at current scale, may need precomputed aggregates later.
- `next lint` is no longer functional (removed in Next.js 16, no eslint.config exists). Pre-existing build failures on `/settings`, `/admin/users`, `/admin/audit` from missing Suspense boundaries around `useSearchParams()`.

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

Slices 1–4A are all merged. The next action will usually be:

1. Design and implement Slice 5: Curation and Diagnostics.
2. Address pre-existing build issues (Suspense boundaries, eslint config) if blocking deployment.
