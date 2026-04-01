# Design: Analysis Results Landing (Slice 4C)

## Context

Slice 4C introduces an explicit customer-facing `Analysis Results` surface in the post-analysis journey. This is a **bounded migration slice** — a transitional landing layer, not a new permanent primary analytics object.

### Problem

After analysis completes, the most valuable insight layer lives only on the legacy `orders/[id]` page. That page reads like an infrastructure console: billing previews, pipeline logs, benchmark launchers, and scope controls appear above the actual results. When the customer leaves the page, there is no way back from Home. The analysis outcome "disappears".

### Referenced architecture

- `docs/architecture/team-first-refactor/12-implementation-packets/04c-analysis-results-landing.md`
- `docs/architecture/team-first-refactor/12-implementation-packets/04c-analysis-results-landing-operator-prompt.md`
- `docs/architecture/team-first-refactor/06-screen-catalog.md`
- `docs/architecture/team-first-refactor/16-onboarding-and-maturity-journey.md`

## Design decisions

### 1. Bounded section decomposition (not monolith reorder, not micro-components)

The current `orders/[id]/page.tsx` (2006 lines) is decomposed into 4 product-level sections plus an orchestrator:

| Layer | File | Responsibility |
|---|---|---|
| **Orchestrator** | `orders/[id]/page.tsx` (existing) | Data fetching, status gating (DRAFT/PROCESSING/COMPLETED/FAILED), role/stage awareness, section assembly |
| **AnalysisResultsSummary** | `components/analysis-results-summary.tsx` | Title + customer-friendly status, summary line ("{repos}, {contributors}, {commits} analyzed"), KPI cards (`GhostKpiCards`), scope/date badge |
| **AnalysisHandoffCard** | `components/analysis-handoff-card.tsx` | Next-step CTAs (People, Repositories, Create team), identity health banner, always visible with stage-dependent prominence |
| **AnalysisResultsOverview** | `components/analysis-results-overview.tsx` | Period/norm selectors, `GhostDistributionPanel`, `GhostDeveloperTable`, existing tabs (Overview/Commits/Calendar) |
| **AnalysisTechnicalPanel** | `components/analysis-technical-panel.tsx` | Publish/share, edit scope, re-analyze, benchmark (launcher + progress + `BenchmarkMatrix` history), pipeline logs, analysis cost |

Cutting rules:
- Cut by product sections, not by JSX fragments.
- Do not extract every small badge/button into a separate component.
- Existing sub-components (`GhostKpiCards`, `GhostDistributionPanel`, `GhostDeveloperTable`, `BenchmarkLauncher`, etc.) are reused as-is.

### 2. Information hierarchy on completed analysis

New render order for `status === 'COMPLETED'`:

```
1. AnalysisResultsSummary
   - headline: analysis name + customer-friendly completion status
   - summary line: "3 repositories, 12 contributors, 847 commits analyzed"
   - GhostKpiCards (avg ghost%, developers, commits, work days)
   - date range + scope badge

2. AnalysisHandoffCard
   - next-step CTAs (stage-dependent)
   - identity health banner (if unresolvedCount > 0)

3. AnalysisResultsOverview
   - period selector + ghost norm selector
   - tabs: Overview (distribution + developer table) / Commits / Calendar
   - bubble chart / ghost insight preserved as migration-era evidence

4. AnalysisTechnicalPanel (collapsible accordion)
   - publish / share
   - edit scope
   - re-analyze
   - benchmark launcher + progress + BenchmarkMatrix comparison/history (admin)
   - pipeline log
   - analysis cost

Note: the existing `benchmark` tab from the current page (which renders `BenchmarkMatrix` for completed benchmark runs) moves into `AnalysisTechnicalPanel`. Admin access to benchmark comparison/history is preserved, not regressed.
```

### 3. Technical panel de-emphasis via collapsible accordion

`AnalysisTechnicalPanel` is wrapped in a collapsible accordion:
- Label: "Technical details" (not just "Advanced").
- `first_data` workspace stage: **collapsed by default**.
- `operational` workspace stage and/or admin role: **expanded by default** (or remember last state via localStorage if pattern already exists in codebase).
- Accordion preserves full access for experienced users and admins.

### 4. Home — latest completed analysis return path

`home-service.ts` adds to its response payload:

```ts
latestCompletedAnalysis: {
  id: string;
  name: string;
  completedAt: string; // ISO
  repoCount: number;
  contributorCount: number;
  commitCount: number;
} | null
```

Query: `prisma.order.findFirst({ where: { userId, status: 'COMPLETED' }, orderBy: { completedAt: 'desc' } })`.

Sort by `completedAt`, not `updatedAt`. Reason: `updatedAt` changes on publish/share/scope edits; `completedAt` reflects when the analysis actually finished.

Counts are **analysis-local** (from the order/result), not workspace aggregates. The card is a return path to a specific analysis, not a workspace summary.

**Authoritative count sources** (applies to both Home card and `AnalysisResultsSummary`):
- `repoCount`: number of repositories in `selectedRepos` that were actually in-scope for the completed run. If scope filtering was applied (e.g. date range excluded a repo), the count should reflect the effective set, not the raw selection.
- `contributorCount`: number of distinct contributors who appear in the completed run's `OrderMetric` / `CommitAnalysis` records — i.e. contributors who were actually included in the analysis, not raw `selectedDevelopers` (which includes excluded candidates). Derive from metrics or the final developer-settings with `excluded = false`.
- `commitCount`: the final analyzed commit count from the completed run (e.g. `totalCommits` on the order after analysis, or `COUNT(CommitAnalysis)` for this order). Not the extraction-time estimate.

Rule: if there is any doubt between "what was selected" and "what was actually analyzed", always prefer **completed-result counts**.

Rendering in Dashboard:
- `empty`: not shown (no completed analysis exists).
- `first_data`: prominent card between KPI summary and People/Repositories CTAs. Text: "Latest analysis ready" + summary + CTA "View analysis results".
- `operational`: compact secondary card in highlights area. One line + link.

Architectural boundary: this is a **transitional return path**, not "Home becoming an order-centric dashboard again".

### 5. Bidirectional return path via AnalysisReturnBanner

New component: `AnalysisReturnBanner`.

Mechanism:
- Handoff CTAs in `AnalysisHandoffCard` append `?fromAnalysis={orderId}` to links targeting People and Repositories.
- `AnalysisReturnBanner` reads `fromAnalysis` from search params.
- If param is present and non-empty: renders a thin info banner at the top of the page.
- Banner: one line of text + CTA "Back to analysis results" linking to `/orders/{fromAnalysis}`.

Hard rules:
1. Used **only** in People page and Repositories page (explicit insertion, not layout-level).
2. Validation: string presence + safe href construction. No fetch to verify order existence.
3. Return link = plain `/orders/{id}`, no attempt to restore previous query state of the analysis page.
4. Visual: thin secondary banner, not sticky, not persistent nav.
5. Banner does not render if param is absent — pages work exactly as before.

Decay path: delete `AnalysisReturnBanner` component + remove `?fromAnalysis` from handoff links = complete cleanup, zero traces in canonical screens.

### 6. AnalysisHandoffCard variants

**`first_data` — prominent variant:**

```
Card (border-primary, bg-primary/5)
  Title: "Your analysis is complete. Here's what to do next."
  Description: brief context about trust -> management flow
  CTAs:
    [Primary] "Review contributors" -> /people?fromAnalysis={id}
    [Secondary] "Check repositories" -> /repositories?fromAnalysis={id}
    [Secondary] "Create first team" -> /repositories/{topCanonicalRepoId}?fromAnalysis={id}
      (fallback if no canonical repo: /repositories?fromAnalysis={id}, with fallback CTA copy)

Resolution of `topCanonicalRepoId`:
- Single authoritative path: server-side lookup in the order detail API response.
- When the orchestrator fetches `/api/orders/{id}`, the response already includes `selectedRepos` (JSONB with fullName).
- The server resolves the first canonical `Repository` record matching any `selectedRepos[].fullName` for the current workspace, and returns `topCanonicalRepoId` alongside the order.
- This is a single `prisma.repository.findFirst({ where: { workspaceId, fullName: { in: repoFullNames } } })` — no client-side guessing.
- If no canonical match exists, `topCanonicalRepoId` is `null` and the handoff card uses the fallback CTA.
  Identity banner (if unresolvedCount > 0):
    inline warning + link to /people?identityHealth=unresolved&fromAnalysis={id}
```

**`operational` — compact variant:**

```
Subtle bordered row / muted panel
  "Review imported data:" + [People] [Repositories] links with fromAnalysis param
  Identity banner if unresolvedCount > 0
  No "Create first team" CTA (teams already exist)
```

Rules:
- Handoff is **always visible** on completed analysis, not gated behind `isFirstRun`.
- `first_data` and `operational` differ by **prominence**, not by presence.
- "Create first team" CTA appears only when `workspaceStage === 'first_data'` (no teams exist).
- All links to People/Repositories carry `fromAnalysis` param.

### 7. i18n

New `analysisResults` namespace in `en.json` / `ru.json`:

```
analysisResults.summary.title = "Analysis Results"
analysisResults.summary.subtitle = "{repoCount} repositories, {contributorCount} contributors, {commitCount} commits analyzed"
analysisResults.summary.completedAt = "Completed {date}"
analysisResults.handoff.title = "Your analysis is complete. Here's what to do next."
analysisResults.handoff.description = "Review the imported data, then create your first team."
analysisResults.handoff.peopleCta = "Review contributors"
analysisResults.handoff.repositoriesCta = "Check repositories"
analysisResults.handoff.teamCta = "Create first team"
analysisResults.handoff.teamFallbackCta = "Find a repository to start your first team"
analysisResults.handoff.operationalPeople = "People"
analysisResults.handoff.operationalRepositories = "Repositories"
analysisResults.handoff.operationalLabel = "Review imported data:"
analysisResults.technical.label = "Technical details"
analysisResults.returnBanner.text = "You came here from analysis results."
analysisResults.returnBanner.cta = "Back to analysis results"
```

Additions to `home` namespace:

```
home.firstData.latestAnalysis.title = "Latest analysis ready"
home.firstData.latestAnalysis.subtitle = "{repoCount} repos, {contributorCount} contributors, {commitCount} commits"
home.firstData.latestAnalysis.cta = "View analysis results"
home.operational.latestAnalysis.label = "Latest analysis"
```

Rules:
- New components use `analysisResults.*` namespace exclusively.
- Do not mass-rewrite legacy `orders.*` i18n keys in this slice. Cleanup is a separate follow-up.
- Legacy keys remain for non-COMPLETED statuses (DRAFT, PROCESSING, FAILED).

## Constraints

- No schema changes.
- No backend/domain rename of `Order`.
- No route rename away from `/orders/*`.
- No new all-analyses library (reuse existing `Analyses` navigation for broad access).
- No migration of order-scoped metrics into canonical contributor/repository/team models.
- Existing analysis engine and APIs stay unless thin presentation-layer change is enough.
- Preserved bubble chart / ghost insight = migration-era evidence, not final analytical center.
- Return path from People/Repositories = contextual and temporary, not permanent navigation contract.

## Exit strategy

As later slices add stronger canonical delivery and management read models:
- `AnalysisResultsSummary` should become thinner or unnecessary.
- `AnalysisResultsOverview` should shrink as canonical contributor/repository surfaces absorb the insight value.
- `AnalysisTechnicalPanel` should migrate to a dedicated `Data Health` surface.
- `AnalysisReturnBanner` should be deleted when canonical surfaces carry enough value on their own.
- `latestCompletedAnalysis` in Home payload should be deprecated when Home operates entirely on canonical workspace data.

## Acceptance criteria

1. After a completed analysis, the customer sees imported value on a customer-facing results screen (not an infrastructure console).
2. Bubble chart and ghost insight remain visible as migration-era evidence without legacy-infrastructure framing.
3. Analysis results explicitly hand off into People, Repositories, and first-team creation.
4. Transitional Home provides a clear return path to latest completed analysis results.
5. People and Repositories offer a lightweight return path (`AnalysisReturnBanner`) when entered from analysis-results handoff.
6. Technical panels no longer dominate the first-run completed-analysis experience (collapsible accordion, collapsed for `first_data`).
7. No schema changes introduced.
8. Typecheck passes.
9. Implementation clearly reads as a transitional landing layer, not a new permanent analytics center.
