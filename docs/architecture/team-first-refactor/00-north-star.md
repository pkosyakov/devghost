# North Star

## Objective

Refactor DevGhost from an `Order`/job-centric analytics product into a business-facing system centered on:

- `Team`
- `Contributor`
- `Repository`
- `SavedView`

while keeping the current ingestion engine usable during migration.

## Product thesis

DevGhost should help managers answer:

- What is happening in my team?
- Which repositories are consuming that team's effort?
- Which contributors are driving or blocking delivery?
- Which saved slice should I monitor every week?

It should not force users to think in:

- orders;
- reruns;
- benchmark jobs;
- raw processing state.

## Default scope hierarchy

1. `Organization`
2. `Team` or `SavedView`
3. `Date Range`

This scope must persist across the session.

## Primary UX stance

- `Team` is the default management scope.
- `Repository` remains first-class, but mainly as drill-down and operational surface.
- `Contributor` is first-class for identity, attribution, and people analytics.
- `SavedView` is the reusable reporting object.
- `AnalysisSnapshot` is infrastructure, not primary UX.

## Domain stance

- Separate `User` from `Contributor`.
- Separate `Contributor` from `ContributorAlias`.
- Use `WorkItem -> PullRequest -> Commit` as the attribution stack.
- Use immutable raw events plus separate curation metadata.
- Use point-in-time team membership by default.

## Reporting stance

- Weekly reports are scheduled deliveries of `SavedView` or `Dashboard`.
- No standalone authored "weekly report" object should be introduced.

## Migration stance

- No big-bang rewrite.
- Keep the legacy run engine.
- Build an anti-corruption/domain facade.
- Move the frontend one surface at a time to business entities.

## Success criteria

The refactor is successful when:

- managers land on team-scoped dashboards by default;
- contributor identity is unified before downstream rollups;
- repository drill-down works without exposing jobs;
- saved views can power both live dashboards and weekly schedules;
- curation can exclude or merge data without full re-analysis by default.
