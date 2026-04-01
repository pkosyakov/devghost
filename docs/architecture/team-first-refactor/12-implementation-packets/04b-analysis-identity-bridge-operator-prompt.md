# Operator Prompt: Analysis Identity Bridge

Use this when the builder-AI needs a short, concrete handoff instead of the full architecture packet.

## Prompt

```text
Implement a bounded post-Slice-4A bridge slice: `Analysis Identity Bridge`.

Read first:
- docs/architecture/team-first-refactor/README.md
- docs/architecture/team-first-refactor/01-decisions.md
- docs/architecture/team-first-refactor/03-domain-model.md
- docs/architecture/team-first-refactor/16-onboarding-and-maturity-journey.md
- docs/architecture/team-first-refactor/12-implementation-packets/04b-analysis-identity-bridge.md
- packages/server/src/app/[locale]/(dashboard)/orders/new/page.tsx
- packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx
- packages/server/src/app/api/orders/[id]/developers/route.ts
- packages/server/src/app/api/orders/[id]/mapping/route.ts
- packages/server/src/app/api/orders/[id]/analyze/route.ts
- packages/server/src/lib/services/contributor-identity.ts
- packages/server/src/lib/services/analysis-worker.ts

Goal:
Remove the manual developer-loading / deduplication step from the default customer analysis path, without rewriting the current worker or schema.

Important constraint:
This is a paid product. Credit estimation and reservation must remain correct.
Do not start analysis until the compatibility identity inputs used by the current billing-safe analyze path are prepared.

Target customer path:
Home
  -> Run first analysis
  -> Analysis setup
  -> Preparing contributors
  -> Analysis processing
  -> Analysis results
  -> People review

What to build:
1. Auto-prepare legacy identity compatibility fields.
   - Reuse the current author extraction and duplicate-detection logic.
   - Automatically produce the payloads currently stored in:
     - `selectedDevelopers`
     - `developerMapping`
   - Keep these as compatibility artifacts for the existing worker/projector pipeline.

2. Remove manual dedup from the default happy path.
   - A new customer should not be blocked on raw developer dedup before analysis can run.
   - Show a neutral preparation state instead of a manual merge screen.

3. Progress automatically into analysis processing for the standard path.
   - Preferred behavior: after preparation, launch the analysis automatically.
   - The auto-start must still go through the existing billing-safe analyze flow after valid compatibility inputs exist.
   - If you hit a strong implementation constraint, the fallback is a minimal one-CTA ready state.
   - The manual dedup editor must still not be the default continuation path.

4. Keep identity trust in canonical surfaces.
   - Analysis results should hand off into `People`.
   - Any unresolved identity issues should be surfaced as “needs review”, not as a setup blocker.

5. Preserve advanced/manual escape hatches if needed.
   - If the current dedup tooling is still useful, keep it behind an advanced/internal affordance.
   - Do not leave it as the primary first-run UI.

Hard rules:
- Do not remove or rename `selectedDevelopers` / `developerMapping` yet.
- Do not add schema changes or migrations.
- Do not rename backend/domain `Order`.
- Do not rename routes away from `/orders/*`.
- Do not rewrite billing or the analysis worker.
- Do not weaken credit estimation or credit reservation correctness.
- Do not bypass canonical contributor projection.
- Do not make the manual dedup editor part of the default onboarding path.

Allowed write scope:
- packages/server/src/app/[locale]/(dashboard)/orders/**
- packages/server/src/app/api/orders/**
- packages/server/src/lib/services/**
- packages/server/src/lib/deduplication.ts
- packages/server/src/lib/schemas/**
- packages/server/messages/en.json
- packages/server/messages/ru.json
- tests adjacent to the touched order/service files

Out of scope:
- schema/migrations
- full `Order` -> `AnalysisSnapshot` domain refactor
- route rename to `/analyses`
- Slice 5 curation/diagnostics work
- redesigning identity rules
- deleting all manual repair tooling

Acceptance criteria:
- after repository selection, a new customer no longer sees a mandatory manual developer-dedup step
- the system auto-prepares compatibility identity inputs required by the existing worker
- the existing billing path still reserves credits correctly before analysis starts
- the default path continues into processing/results with no raw-identity gate
- analysis results clearly point users toward canonical contributor review
- existing worker/projector flow still functions
- typecheck passes

Final report format:
1. Summary
2. Files changed
3. Happy-path changes
4. Compatibility strategy
5. Acceptance criteria status
6. Tests run
7. Risks/follow-ups
```
