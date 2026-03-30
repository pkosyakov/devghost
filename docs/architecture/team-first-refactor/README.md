# Team-First Refactor Artifact System

This directory is the source-of-truth artifact set for the DevGhost UX/domain refactor.

## Goal

Enable architecture-led development where:

- product direction is frozen in a small number of canonical docs;
- implementation can be delegated to another AI without re-explaining the problem each time;
- decisions, contracts, and delivery slices stay separated.

## Reading order

1. [00-north-star.md](C:\Projects\devghost\docs\architecture\team-first-refactor\00-north-star.md)
2. [01-decisions.md](C:\Projects\devghost\docs\architecture\team-first-refactor\01-decisions.md)
3. [02-ubiquitous-language.md](C:\Projects\devghost\docs\architecture\team-first-refactor\02-ubiquitous-language.md)
4. [03-domain-model.md](C:\Projects\devghost\docs\architecture\team-first-refactor\03-domain-model.md)
5. [04-state-and-attribution-rules.md](C:\Projects\devghost\docs\architecture\team-first-refactor\04-state-and-attribution-rules.md)
6. [05-ux-ia.md](C:\Projects\devghost\docs\architecture\team-first-refactor\05-ux-ia.md)
7. [10-delivery-slices.md](C:\Projects\devghost\docs\architecture\team-first-refactor\10-delivery-slices.md)
8. [12-implementation-packets/01-contributor-foundation.md](C:\Projects\devghost\docs\architecture\team-first-refactor\12-implementation-packets\01-contributor-foundation.md)

## Session restart

If a new Codex session needs to continue this refactor, start here:

1. [13-session-handoff.md](C:\Projects\devghost\docs\architecture\team-first-refactor\13-session-handoff.md)
2. [14-new-session-bootstrap.md](C:\Projects\devghost\docs\architecture\team-first-refactor\14-new-session-bootstrap.md)

The handoff doc captures current state, active worktrees, completed slices, and open issues.
The bootstrap doc is the exact prompt/process to use when starting a fresh session.
Current status notes such as "Slice 2 merge-candidate" or "Slice 3 plan still has open findings" should be kept in the handoff doc, not inferred from chat history.

## Conceptual overview

If you need one human-readable entrypoint for the product model, start with:

- [15-conceptual-overview.md](C:\Projects\devghost\docs\architecture\team-first-refactor\15-conceptual-overview.md)
- [16-onboarding-and-maturity-journey.md](C:\Projects\devghost\docs\architecture\team-first-refactor\16-onboarding-and-maturity-journey.md)

It summarizes:

- what the product is becoming;
- how the main entities relate;
- what each entity is for;
- what attributes matter;
- what the customer workflow looks like.

The onboarding/maturity journey doc adds:

- how a brand-new customer should enter the product;
- which screen should lead at each maturity stage;
- when `People`, `Repositories`, `Teams`, and `Reports` should become meaningful.

## Document roles

- `00-*`: product north star and scope of the refactor.
- `01-*`: frozen architectural decisions.
- `02-*`: terminology contract.
- `03-*`: domain entities and relationships.
- `04-*`: tricky rules and invariants.
- `05-*` to `09-*`: UX, screen, API, migration contracts.
- `10-*`: implementation slices for builder-AI.
- `11-*`: validation and acceptance scenarios.
- `12-*`: execution-ready packets for builder-AI.
- `13-*`: current program handoff and session continuity notes.
- `14-*`: new-session bootstrap instructions and reusable prompt text.
- `15-*`: conceptual overview for humans and future sessions.
- `16-*`: customer journey and maturity-stage orchestration.
- `templates/*`: reusable packet templates for delegated implementation.

## Relationship to existing docs

This package is derived from:

- [2026-03-29-repository-developer-first-ux-design.md](C:\Projects\devghost\docs\plans\2026-03-29-repository-developer-first-ux-design.md)
- research notes in [docs/consultations/ux refactoring](C:\Projects\devghost\docs\consultations\ux%20refactoring)

The plan doc remains the broader narrative. This directory is the operational architecture set.

## Rules

- When a major decision changes, update `01-decisions.md` first.
- When terminology changes, update `02-ubiquitous-language.md`.
- Builder-AI packets must cite the exact source docs they depend on.
- If a task cannot be executed without inventing behavior, add an ADR or contract update before implementation.
