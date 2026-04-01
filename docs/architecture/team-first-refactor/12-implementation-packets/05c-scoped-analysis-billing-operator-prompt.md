# Operator Prompt: Scoped Analysis Billing

Use this when the builder-AI should implement the target-state billing model for analysis scope, not another stopgap estimate patch.

## Prompt

```text
Implement a target-state billing slice: `Scoped Analysis Billing`.

Read first:
- docs/architecture/team-first-refactor/README.md
- docs/architecture/team-first-refactor/01-decisions.md
- docs/architecture/team-first-refactor/03-domain-model.md
- docs/architecture/team-first-refactor/04-state-and-attribution-rules.md
- docs/architecture/team-first-refactor/10-delivery-slices.md
- docs/architecture/team-first-refactor/12-implementation-packets/05a-canonical-identity-curation.md
- docs/architecture/team-first-refactor/12-implementation-packets/05c-scoped-analysis-billing.md
- packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx
- packages/server/src/app/api/orders/[id]/analyze/route.ts
- packages/server/src/app/api/orders/[id]/developers/route.ts
- packages/server/src/app/api/llm-info/route.ts
- packages/server/src/lib/services/analysis-worker.ts
- packages/server/src/lib/services/credit-service.ts
- packages/server/src/lib/services/scope-filter.ts

Goal:
Make analysis credit estimation and reservation derive from the authoritative scoped commit universe, not from stale extraction-time developer aggregates.

What to build:
1. Introduce one authoritative billing-preview path.
   - The UI and `/api/orders/[id]/analyze` must use the same server-side source of truth for billable commit count.
   - Do not leave one estimate in the client and another on the server.

2. Derive billable work from selected analysis scope.
   - Scope includes:
     - selected repositories
     - selected period
     - selected included/excluded contributors
     - cache mode
   - Billable credits must be based on in-scope non-cached commits, not developer-count heuristics.

3. Remove the artificial minimum credit floor.
   - If billable work is zero, preview should show zero billable credits.
   - Analyze preflight should allow launch with zero available credits when the authoritative billable count is zero.

4. Keep billing safe and conservative.
   - Preserve reservation correctness.
   - Preserve debit/release behavior.
   - Preserve auditability.
   - Do not under-reserve because of stale preview logic.

5. Harden customer-facing price language.
   - Credits remain the authoritative billing unit.
   - Any USD display must be explicitly approximate / best-effort.
   - Do not present rough average-token math as exact price.

6. Keep legacy compatibility while moving to target-state logic.
   - Historical payloads may still contain `commit_count`.
   - Some old rows may have blank email and must not inflate billing.
   - Do not regress old orders/tests while replacing the core estimate path.

7. Keep admin and customer logic aligned.
   - Admin may bypass wallet charging, but previewed scoped billable work must still reflect the same scope semantics.

Implementation guidance:
- Prefer a shared server service such as `analysis-billing-preview-service` or equivalent.
- The analyze route should not independently recalculate a different estimate from the UI.
- If exact scoped commit enumeration needs a machine-generated preview snapshot or index, that is acceptable, but it must be server-owned and regenerated when scope changes.
- Do not keep `selectedDevelopers.commitCount` as the authoritative business contract for billing.

Hard rules:
- Do not weaken reservation/debit/release correctness.
- Do not keep `Math.max(1, ...)` as a fake safety mechanism.
- Do not bill excluded contributors.
- Do not let hidden blank-email legacy rows inflate or block billing.
- Do not make approximate USD language look exact.
- Do not do a cosmetic-only change; implement the target-state direction.

Allowed write scope:
- packages/server/src/app/[locale]/(dashboard)/orders/**
- packages/server/src/app/api/orders/**
- packages/server/src/app/api/llm-info/route.ts
- packages/server/src/lib/services/**
- packages/server/src/lib/schemas/**
- packages/server/messages/en.json
- packages/server/messages/ru.json
- tests adjacent to the touched files

Out of scope:
- pricing-plan redesign
- seat pricing / org monetization
- route rename away from /orders/*
- total worker rewrite
- diagnostics hub
- public report pricing / schedules pricing

Acceptance criteria:
- UI preview and analyze preflight resolve the same billable commit count for the same scope
- changing contributor scope or period updates the preview from authoritative scoped data
- fully cached / zero-net runs can launch with zero available credits
- positive billable runs still reserve credits safely before execution
- legacy mixed payloads do not inflate the estimate or break the selector
- credits and approximate USD are clearly distinguished in the UI
- typecheck and relevant tests pass

Final report format:
1. Summary
2. Files changed
3. Billing-preview strategy
4. Credit reservation behavior
5. UI language changes
6. Acceptance criteria status
7. Tests run
8. Risks/follow-ups
```
