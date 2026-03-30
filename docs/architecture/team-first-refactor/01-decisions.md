# Decisions

This file is the compact architectural decision register for the refactor.

## Locked decisions

| ID | Decision | Status | Why it is locked |
|---|---|---|---|
| D-001 | Primary management scope is `Team` | Accepted | Mature engineering analytics products converge on team-first management UX; it solves multi-repo organizations better than repo-first navigation. |
| D-002 | `Repository` stays first-class in the domain and UI, but not as the default landing scope | Accepted | Tech leads still need repo drill-down, but managers should not navigate the product repo-by-repo by default. |
| D-003 | Internal model uses `Contributor`; UI may still say `Developer` where clearer | Accepted | Tracked engineering identity is not the same as a product user and not the same as a single git email. |
| D-004 | `User` and `Contributor` are distinct entities | Accepted | Access control, billing, and tracked engineering activity must not be conflated. |
| D-005 | `Contributor identity resolution` is Phase 1 foundation work | Accepted | Team, repository, and reporting layers become untrustworthy if identity is fragmented. |
| D-006 | `SavedView` is an independent object, not a sub-object of `Team` | Accepted | Managers need cross-team and custom ad hoc scopes; weekly reporting also needs a stable independent scope object. |
| D-007 | Weekly reports are `Schedule + ReportRun` over `SavedView` or `Dashboard` | Accepted | This avoids building a parallel report-authoring model that drifts from live dashboards. |
| D-008 | `AnalysisSnapshot` replaces `Order` as the internal concept; it is not a primary UX entity | Accepted | Jobs/runs are infrastructure and should live in diagnostics/data-health surfaces only. |
| D-009 | Attribution stack is `WorkItem -> PullRequest -> Commit` | Accepted | Commit-only modeling is insufficient for squash merges, review flows, and cross-repo work. |
| D-010 | `PullRequest` is the primary delivery UX object | Accepted | It matches management workflows, review lifecycle, and survives squash-merge better than commit-only UX. |
| D-011 | `Commit` remains as evidence/code-health layer | Accepted | Effort evidence, direct pushes, and fine-grained curation still need commit-level data. |
| D-012 | Team membership uses point-in-time effective dates | Accepted | Current-team-only attribution corrupts historical trends after org changes. |
| D-013 | Multi-team membership is allowed in the data model | Accepted | Real orgs are matrix-shaped; blocking this at the model level creates future dead ends. |
| D-014 | Every contributor should have at most one `primary team` at a time | Accepted | Org-level dedupe and ownership rules need a default attribution anchor. |
| D-015 | Raw events are append-only; curation is modeled separately | Accepted | Trust and auditability require immutable source data plus reversible curation metadata. |
| D-016 | Most curation actions should use incremental recomputation, not full reprocessing | Accepted | Full rebuild after every exclusion or merge is too slow and too expensive for UX trust. |
| D-017 | Legacy run engine stays in place during migration | Accepted | The safest migration path is a strangler facade, not a big-bang rewrite. |
| D-018 | Slice 4 uses a URL-backed `ActiveScope` as the v1 source of truth for unsaved scope state | Accepted | Current analytical pages already depend heavily on route/query state; this gives shared scope without inventing a separate server-side session-scope store. |
| D-019 | `SavedView` is workspace-scoped in production until `Organization` exists | Accepted | The real production boundary today is `Workspace`; waiting for `Organization` would stall reusable scope/reporting work. |
| D-020 | A separate persisted `Dashboard` object is deferred in Slice 4; existing `/dashboard` becomes the scope-aware `Home` surface | Accepted | This keeps Slice 4 focused on shared scope and saved views instead of opening a second authored-object system too early. |
| D-021 | First-team onboarding should prefer `Create team from repository`, while keeping `Team` independent from `Repository` | Accepted | A familiar repository is the fastest bootstrap surface for new users, but a team must remain a durable management object that can span multiple repositories and evolve independently. |

## Decisions intentionally left open

| ID | Question | Current state |
|---|---|---|
| O-001 | Should main nav expose `Repositories`, or keep it secondary/admin-facing? | Open; likely secondary, but validate against DevGhost-specific repo-centric workflows. |
| O-003 | Should org-level rollups use primary-team-only or configurable dedupe policies? | Open; define in attribution rules before team implementation begins. |
| O-004 | How aggressively should bot detection auto-classify AI coding agent activity? | Open; initial version should surface suggestions before full automation. |

## Change protocol

If any locked decision changes:

1. update this file first;
2. note affected docs;
3. update dependent contracts before implementation resumes.
