# Operator Prompt: Canonical Identity Curation

Use this when the builder-AI should implement the target-state identity solution instead of another bridge.

## Prompt

```text
Implement a target-state identity slice: `Canonical Identity Curation`.

Read first:
- docs/architecture/team-first-refactor/README.md
- docs/architecture/team-first-refactor/01-decisions.md
- docs/architecture/team-first-refactor/03-domain-model.md
- docs/architecture/team-first-refactor/04-state-and-attribution-rules.md
- docs/architecture/team-first-refactor/05-ux-ia.md
- docs/architecture/team-first-refactor/08-data-and-api-contracts.md
- docs/architecture/team-first-refactor/16-onboarding-and-maturity-journey.md
- docs/architecture/team-first-refactor/12-implementation-packets/05a-canonical-identity-curation.md
- packages/server/src/app/[locale]/(dashboard)/orders/new/page.tsx
- packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx
- packages/server/src/app/api/orders/[id]/analyze/route.ts
- packages/server/src/app/api/orders/[id]/developers/route.ts
- packages/server/src/lib/services/contributor-identity.ts
- packages/server/src/lib/services/analysis-worker.ts
- packages/server/src/app/api/v2/contributors/identity-queue/route.ts
- packages/server/src/app/api/v2/contributors/merge/route.ts
- packages/server/src/app/api/v2/contributors/unmerge/route.ts
- packages/server/src/app/api/v2/contributors/aliases/[aliasId]/resolve/route.ts

Goal:
Make canonical contributor identity the only layer the customer reviews and edits.
Analysis should no longer block on manual raw-developer dedup.
Billing must remain safe.
Manual merge/unmerge must still exist on canonical identity surfaces.
Users must still be able to analyze only a subset of contributors and pay only for that scoped analysis.

What to build:
1. Replace the billing dependency on manual developer review.
   - Billing-safe preflight must derive reservable scope from selected repositories + selected period + selected contributors, not from a manual dedup workflow.
   - Preserve or improve current credit reservation correctness.

2. Remove manual raw developer dedup from the default analysis path.
   - A new user should not land on a blocking developer merge screen before analysis can run.
   - The default path should be: discover contributors -> choose included contributors -> reserve credits -> process -> results.

3. Feed canonical identity directly.
   - Raw author/provider signals should create/update `ContributorAlias`.
   - Canonical `Contributor` resolution should follow from alias ingestion, not from a mandatory manual order-local mapping step.

4. Keep auto-resolution conservative.
   - Auto-merge deterministic matches only.
   - Do not auto-merge fuzzy name/domain/Levenshtein matches.
   - Bias toward false negatives over false positives.

5. Preserve manual merge/unmerge on canonical surfaces.
   - Keep or harden:
     - merge contributors
     - unmerge contributors
     - assign alias to contributor
   - These actions belong to People / identity queue / contributor detail, not analysis setup.

6. Keep contributor selection as a lightweight setup control.
   - The user must still be able to include/exclude contributors before analysis.
   - Estimated credits should respond to that selected contributor scope.
   - This setup step must not become a raw alias merge editor.

7. Route trust review into canonical surfaces.
   - Analysis results should hand off into `People`.
   - Identity issues should be reviewed there, not inside a raw developer preparation step.

Hard rules:
- Do not weaken credit estimation or reservation correctness.
- Do not auto-merge fuzzy matches into canonical contributors.
- Do not remove manual merge / unmerge capabilities.
- Do not keep raw developer dedup as the default onboarding path.
- Do not force customers to pay for all discovered contributors if they selected only a subset.
- Do not make new identity surfaces depend on order-local JSON as the business contract.
- Do not do a cosmetic-only fix; implement the target-state direction.

Allowed write scope:
- packages/server/src/app/[locale]/(dashboard)/orders/**
- packages/server/src/app/api/orders/**
- packages/server/src/app/api/v2/contributors/**
- packages/server/src/app/[locale]/(dashboard)/people/**
- packages/server/src/lib/services/**
- packages/server/src/lib/schemas/**
- packages/server/messages/en.json
- packages/server/messages/ru.json
- tests adjacent to the touched files

Out of scope:
- full route rename away from /orders/*
- total run-engine replacement
- PR/work-item model work
- reports/schedules work
- full diagnostics hub

Acceptance criteria:
- analysis no longer blocks on manual raw developer dedup
- billing is still safely reserved before analysis starts for the selected contributor scope
- canonical contributor identity becomes the review/edit layer
- users can still include/exclude contributors before analysis and see the price implication
- manual merge/unmerge still works on canonical surfaces
- unresolved/suggested identities are reviewable via People / identity queue
- typecheck and relevant tests pass

Final report format:
1. Summary
2. Files changed
3. Billing/preflight strategy
4. Canonical identity changes
5. Acceptance criteria status
6. Tests run
7. Risks/follow-ups
```
