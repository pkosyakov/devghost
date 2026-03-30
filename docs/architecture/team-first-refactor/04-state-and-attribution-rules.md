# State and Attribution Rules

This document captures tricky behavioral rules that implementation must not invent ad hoc.

## Locked baseline rules

### Team membership history

- Attribution is point-in-time by default.
- Historical charts should not silently restate all past work under the contributor's current team.
- Membership changes must carry `effectiveFrom` and optional `effectiveTo`.

### Multi-team membership

- Multi-team membership is allowed.
- One contributor should have one `primary team` at a given point in time.
- Org-level rollups must define dedupe policy explicitly before implementation.

### Slice 3 operating rule

- Before org-level rollups and `SavedView` scopes exist, team-local screens may use full inclusion.
- If a contributor has an active membership in a team during the selected period, that contributor's qualifying activity may appear on that team's page.
- One contributor may legitimately appear in multiple team pages in Slice 3.
- `primary team` is still required and should be used for default labeling, ownership, and future rollup behavior.
- Avoid inventing weighted attribution or org-wide dedupe logic in Slice 3.

### Slice 4 operating rule

- Before `Organization` exists in production, `ActiveScope` and `SavedView` are resolved inside the authenticated user's `Workspace`.
- In Slice 4 v1, unsaved `ActiveScope` state is URL-backed rather than persisted in a separate server-side session-scope store.
- `SavedView` activation must populate `ActiveScope`; unsaved edits after activation create a dirty scope state, not a hidden mutation of the saved view.
- Route identity still wins on entity-detail pages:
  - `/teams/[id]` stays bound to that canonical team;
  - changing the scope selector to another team should navigate to that team's route instead of silently showing mismatched data under the old URL.
- Slice 3 local `from/to` controls must either disappear or synchronize to `ActiveScope` in Slice 4; duplicate unsynced date controls are not allowed.
- Orders/admin/diagnostics surfaces do not participate in `ActiveScope`; the shared context applies only to primary analytical surfaces.

### Work attribution stack

- `WorkItem` is the strategic/reporting intent layer.
- `PullRequest` is the primary delivery layer.
- `Commit` is the evidence layer.

### Special delivery cases

- Squash merge: PR remains canonical delivery object; pre-squash commits should stay attached if ingested in time.
- Direct push: represent as commit evidence and optionally promote to pseudo-PR in team/process surfaces.
- Rebase merge: do not rely only on raw SHA equality for logical dedupe.

### Curation behavior

- Exclusions are metadata, not destructive data mutation.
- Most curation actions should be visible on next query without full reprocessing.
- Regex/global rules may offer explicit historical reprocess as an opt-in escape hatch.

## Open rule areas to specify next

- Org rollup dedupe policy for multi-team contributors
- Repo auto-discovery thresholds for team association
- Primary-team fallback when no primary team is set
- External contributor default inclusion/exclusion policy
- AI agent/bot classification rules
