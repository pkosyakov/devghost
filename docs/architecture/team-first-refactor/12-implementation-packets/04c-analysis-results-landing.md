# Slice 4C: Analysis Results Landing

## Goal

Introduce an explicit customer-facing `Analysis Results` surface in the new journey, so the first value moment after a completed analysis is no longer trapped in the legacy order dashboard.

This is a **bounded migration slice**, not a new permanent primary analytics object.

This slice does not require a full `Order` rewrite.

It defines how the product should present:

- the completed analysis outcome;
- bubble chart / ghost insight / contributor comparison;
- the handoff from one finished analysis into canonical workspace surfaces.

The target is not:

- “move every legacy metric into `Home`”

The target is:

- “make completed analysis results a deliberate product surface, then hand the customer into `People`, `Repositories`, and first-team creation”.

The target is **not**:

- “elevate analysis-run UX into a permanent top-level analytical center equal to `Home`, `People`, `Repositories`, or `Teams`”.

## Why this exists

The refactor already projects important data into canonical entities:

- `Contributor`
- `ContributorAlias`
- `Repository`
- `Team`
- `SavedView`

But the customer still experiences a serious gap:

- after analysis completes, the most valuable insight layer still lives only on the legacy analysis page;
- canonical screens show the projected workspace state, but not the immediate “what did this analysis find?” moment;
- `Home` orchestrates next steps, but does not currently provide a strong way to revisit or understand the analysis outcome itself.
- existing sidebar access to `Analyses` is not enough, because it is generic navigation, not an explicit part of the post-analysis journey.

This creates a broken mental model:

- the analysis did real work;
- the data did land in the new model;
- but the customer cannot tell where to see the actual result unless they stay inside legacy `orders/[id]`.

Important clarification:

- this is **not** primarily an access problem;
- it is a journey and information-architecture problem.

The customer can technically reach analyses through existing navigation, but the product still fails to make completed results feel like a deliberate stage in the new path.

Architectural clarification:

- `Analysis Results` in this slice is a **transitional post-analysis landing**;
- it exists to bridge legacy order-scoped evidence into the new workspace model;
- it should shrink over time as canonical management and delivery surfaces absorb more long-term value.

## Locked decisions this packet depends on

- `D-008`: `AnalysisSnapshot` replaces `Order` as the internal concept; it is not a primary UX entity.
- `D-017`: legacy run engine stays in place during migration.
- `D-020`: `/dashboard` is the scope-aware `Home` surface.
- `D-021`: first-team onboarding should prefer `Create team from repository`.

Important interpretation:

- this slice does **not** turn `Order` into a primary navigation object;
- it turns completed analysis detail into an intentional post-analysis landing surface in the journey.

## Product model

There are now three distinct surfaces and they must not be conflated.

### 1. `Home`

Role:

- orchestrator of the next best action by workspace maturity.

It should answer:

- what the workspace already knows;
- what to do next.

It should **not** be forced to carry every order-scoped result visualization.

### 2. `Analysis Results`

Role:

- first value moment after one completed analysis.

It should answer:

- what this completed analysis found;
- who and what stand out;
- where to go next in canonical workspace surfaces.

This is where bubble chart / ghost interpretation belongs for now.

Important limitation:

- these visuals are preserved here as **migration evidence**;
- they should not be treated as proof that commit/ghost-centric interpretation is the final long-term center of the product.

### 3. Canonical workspace surfaces

- `People`
- `Repositories`
- `Teams`
- `Reports`

Role:

- durable operational model.

These screens should carry the stable management workflow, not the entire first-run explanation burden of one specific analysis.

## Exit strategy

This slice should be implemented with an explicit decay path:

- `Analysis Results` is important now because it carries unique analysis-scoped value that canonical surfaces do not yet express well;
- as later slices add stronger canonical delivery and management read models, `Analysis Results` should become thinner;
- over time it should trend toward:
  - a post-analysis landing,
  - a recent-results entrypoint,
  - and a compatibility evidence surface,
  not a dominant permanent analytics home.

## Required outcomes

### 1. Completed analysis detail becomes customer-facing `Analysis Results`

The current completed analysis page should be reframed as:

- a results landing;
- not an internal run console.

The first visible content on a completed analysis should be:

- analysis title and status in customer language;
- summary of what was analyzed;
- bubble chart / ghost insight / contributor comparison;
- clear next-step actions.

Technical and infra-heavy content may still exist, but must not dominate the first-run experience.

### 2. Bubble chart and ghost insight remain analysis-scoped

Do **not** try to force-fit bubble chart / ghost comparison into:

- `Home`
- `People List`
- `Repositories List`

in this slice.

Those insights are still derived from one analysis scope and should remain analysis-scoped evidence until a later canonicalization slice exists.

This slice should preserve them, but place them inside an intentional `Analysis Results` surface.

They should be described as:

- preserved legacy evidence with current customer value,

not as:

- the final durable center of the target analytics model.

### 3. Strong handoff into canonical surfaces

`Analysis Results` must explicitly hand off into:

1. `People`
2. `Repositories`
3. `Create first team from repository`

Expected user understanding:

- “I see what the analysis found.”
- “Now I know who to review.”
- “Now I know which repositories were imported.”
- “Now I know how to turn this into a team/workflow.”

### 4. `Home` should not drop the analysis outcome on the floor

For `first_data` workspaces, `Home` should provide a clear way back to the latest relevant results.

Examples of acceptable implementations:

- latest completed analysis card;
- `View latest analysis results` CTA;
- first-analysis completion card that links back into results.

This is not meant to make `Home` analysis-centric forever.

It is meant to prevent the feeling:

- “I ran analysis, but now I have no idea where that value lives.”

Bounded decision for this slice:

- do **not** build a brand-new “all analyses library” as part of this work;
- reuse the existing `Analyses` navigation for broad access to multiple analyses;
- add an explicit `latest completed analysis` return path in `Home` so the main journey is clear.

### 5. Advanced/technical analysis controls should be secondary

For first-run or `first_data` customers:

- diagnostics, pipeline logs, benchmarks, advanced run controls, and similar technical elements should be lower-priority or visually de-emphasized.

They may still be available for experienced users and admins.

But the top of the screen should read like:

- results,
- interpretation,
- next steps.

Not:

- jobs,
- logs,
- benchmarking,
- infra tuning.

### 6. Handoff should be bidirectional where the customer is actively redirected

When the customer follows explicit CTA handoffs from `Analysis Results` into:

- `People`
- `Repositories`

the product should preserve a lightweight contextual way back to that analysis results screen.

Acceptable implementations:

- `fromAnalysisId` / `returnTo` query-param propagation;
- small return banner;
- contextual `Back to analysis results` CTA near the top of the destination screen.

This does **not** mean every screen in the app must permanently expose analysis-return affordances.

It means:

- if the product sends the customer from results into trust/coverage review,
- the customer should not lose their place immediately.

Architectural boundary:

- this return path must remain contextual, temporary, and local to the handoff flow;
- it must not become permanent global navigation semantics inside canonical screens.

## In scope

- customer-facing reframe of completed analysis detail into `Analysis Results`
- top-of-screen results composition on completed analysis
- explicit next-step handoff to `People`, `Repositories`, and first-team creation
- latest-results return path from transitional `Home`
- lightweight contextual return path from `People` / `Repositories` when entered from `Analysis Results`
- copy, layout, and CTA hardening needed to support this journey
- visual de-emphasis or gating of technical panels for first-run customers
- canonical links from results elements into `People` / `Repositories` / first-team path

## Out of scope

- full `Order` -> `AnalysisSnapshot` rename
- schema changes
- migration of all ghost metrics into canonical contributor/team/repository read models
- benchmark redesign
- diagnostics/data-health redesign
- worker rewrite
- replacing `/orders/*` routes
- public sharing / scheduled delivery

## Key constraints

- keep the existing analysis engine and existing result APIs unless a light presentation-layer facade is enough;
- do not regress experienced-user access to detailed analysis information;
- do not make `Analysis Results` a permanent primary nav concept above `Home`, `People`, `Repositories`, or `Teams`;
- do not treat preserved bubble/ghost insight as proof that commit-centric legacy analytics are the long-term target center;
- preserve the onboarding rule that `Create team from repository` is the preferred first management step.

## Recommended implementation areas

### A. Analysis results information hierarchy

On completed analysis:

- surface the result summary first;
- show bubble chart / ghost insight early;
- keep contributor/repository highlights near the top;
- move technical tabs or controls later in the page, behind tabs, or behind conditional affordances.

### B. Canonical handoff card

The completed analysis page should contain a strong handoff area with actions such as:

- `Review contributors`
- `Check repositories`
- `Create first team from repository`

This should be especially strong for `first_data` workspaces.

### C. Latest-results return path from `Home`

For workspaces that have completed analysis but no stable management scope yet, `Home` should expose a clear CTA back into the latest results.

This can be conditional by maturity stage.

This slice only requires:

- `latest completed analysis` return path.

It does not require:

- a full new list/library for all analyses.

Broad access to older analyses may continue to rely on the existing `Analyses` navigation.

### D. Results-to-canonical linking

Where possible:

- contributor items should link into canonical `People` / contributor detail when identity is resolved;
- repository items should link into canonical `Repository Detail`;
- unresolved identity or freshness issues should still hand off into canonical review surfaces.

### E. Context-preserving return from handoff destinations

If `People` or `Repositories` is opened from explicit `Analysis Results` handoff CTAs, preserve enough context to offer a lightweight return path back to that results screen.

This is especially important in the first-run journey.

Implementation preference:

- use query-param-driven or similarly lightweight context propagation;
- avoid embedding durable analysis-run dependencies into canonical screen contracts.

## Acceptance criteria

- after a completed analysis, the customer can clearly see the imported value on a customer-facing results screen;
- bubble chart and ghost insight remain available without forcing the user into legacy-infrastructure framing;
- analysis results explicitly hand off into `People`, `Repositories`, and first-team creation;
- `Home` provides a clear path back to the latest results for transitional workspaces;
- `People` and `Repositories` can offer a lightweight return path when entered from analysis-results handoff;
- technical analysis controls no longer dominate the first-run completed-analysis experience;
- no schema changes are introduced.

## Expected deliverables

- updated completed-analysis UX
- explicit post-analysis handoff flow
- latest-results return path from transitional `Home`
- copy updates where needed
- tests for any new maturity gating / conditional rendering introduced
- short report describing how the post-analysis path changed
