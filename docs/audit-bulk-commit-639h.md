# Audit: FD Pipeline Overestimation (Top-11 Commits, Order cmn4gw9wx)

**Date**: 2026-03-25
**Commit**: `188c43e933883194f0bddb29f9fa3d1f67d0c2ba`
**Repository**: Artisan-AI/artisan (artisan-private)
**Order**: `cmn4gw9wx0001js04xsn1n4za`
**Job**: `cmn4p4a770001l5045gudqa8e` (Modal, COMPLETED)
**Model**: `qwen/qwen3-coder-30b-a3b-instruct` (OpenRouter)

## Ground Truth

Source: tech lead (author of the PR).

> "Copying one large repo into another for monorepo, plus some fixes. 8-16h with AI help, 20-30h without."

Pipeline estimate: **639.8h** — overestimated **x21.3**.

## Commit Profile

| Metric | Value |
|--------|-------|
| Type | Squash merge of PR #597 "Refactor/monorepo" |
| Parents | 1 (squash) |
| Authors | 3 (Samantha Stallings, Vivek Mittal, Vedant Singh) |
| Files changed | 870 |
| Lines | +101,573 / -2,030 |
| New files (0 deletions) | 827 (95.1%) |
| Modified files | 24 |
| Binary files | 19 |

### File composition (new files by type)

| Type | Count | Lines |
|------|-------|-------|
| TSX components | 530 | bulk of diff |
| TS modules | 188 | |
| JSON/lock | 53 | 2,488 |
| SVG assets | 23 | binary |
| Markdown docs | 10 | 4,402 |
| Test files (.spec/.test) | 55 | 15,740 |
| Config (project.json, tsconfig, eslintrc) | 42 | |
| Icons.tsx + UnusedIcons.tsx (SVG components) | 2 | 6,033 |
| countries.json (data) | 1 | 1,630 |
| index.css (theme) | 1 | 1,143 |
| bun.lock (auto-generated) | 1 | 7,644 add / 1,900 del |

Nature: **cross-repo code copy** into Nx monorepo structure + import path renames (`@artisan-ai` -> `@artizen`, 672 lines) + workspace config.

## DB Record

```json
{
  "commitHash": "188c43e933883194f0bddb29f9fa3d1f67d0c2ba",
  "effortHours": "639.8",
  "method": "FD",
  "category": null,
  "complexity": null,
  "confidence": "0.6",
  "llmModel": null,
  "additions": 101573,
  "deletions": 2030,
  "filesCount": 870,
  "repository": "Artisan-AI/artisan",
  "analyzedAt": "2026-03-24T15:05:12.969Z"
}
```

`method: "FD"` = full per-file File Decomposition. `llmModel: null` = not set by FD path.

## Root Cause Chain

```
1. diff = 24.6MB >> FD_THRESHOLD (60K)
   -> enters run_fd_hybrid()

2. _check_cheap_signals(): NO MATCH
   - net_ratio = 0.96 (threshold: < 0.05) -- massively asymmetric add/del
   - no lockfile/locale/format keywords in message

3. classify_move_commit(): is_move = FALSE
   - commit_ratio = 0.02 (threshold: 0.6) -- 101K adds vs 2K dels
   - MOVE_KEYWORDS regex doesn't match "Refactor/monorepo"
     (pattern: move|rename|extract|split|reorganize|relocate|migrate|refactor.*module)
     "Refactor/monorepo" fails because "refactor.*module" requires "module" after "refactor"

4. detect_bulk_refactoring(): PARTIAL
   - is_bulk = True, but only 142/870 patterned files (16%)
   - Most files are pure adds (no del/add pairs for pattern extraction)

5. force_complex = TRUE  <-- THE PROXIMATE CAUSE
   - File "apps/web/docs/MIGRATION_PLAN.md" contains 'migrat' in filename
   - This bypasses LLM metadata classify entirely
   - Forces run_file_decomposition() (full per-file FD)

6. run_file_decomposition() processes 870 files:
   - Regex classify tags only 87 files (test:57, config:22, generated:6, etc.)
   - 783 files remain UNTAGGED -> each gets individual LLM estimation call
   - Per-file LLM estimates: 0.5-2h per component file
   - Sum: ~640h

7. Aggregation LLM sees "Per-file hour estimates: total=640h"
   - System prompt says "use them as primary input"
   - Returns ~640h (trusts "expert" per-file reviewers)
   - Final: 639.8h
```

## Key Insight: LLM Classify Would Have Been Correct

When tested in isolation (same model, same prompt), metadata-only LLM classify returns:

```json
{
  "change_type": "refactor",
  "new_logic_percent": 5,
  "moved_or_copied_percent": 30,
  "boilerplate_percent": 40,
  "architectural_scope": "multi_package",
  "cognitive_complexity": "high"
}
```

`new_logic=5%` < threshold 20% -> would route to **mechanical path**.
Mechanical path estimate: **25h** (accurate, within ground truth range).

**But LLM classify was never called** because `force_complex` fired first.

## Why force_complex Is Wrong Here

The `force_complex` heuristic (check for 'migrat' in filenames) was designed for deliberate breaking changes where a MIGRATION_PLAN.md signals high invisible architectural work. But in this case, the file is just documentation copied along with the rest of the codebase. The heuristic doesn't distinguish between:

- A migration guide written for a breaking API change (high effort)
- A migration doc that happens to exist in copied code (zero additional effort)

## Proposed Fixes

See [fix-fd-overestimation-design.md](fix-fd-overestimation-design.md) for the full design document (revision 2, post expert review).

Summary of approach:
1. **Scaffold detector** (early exit): requires file composition (>80% new, >10K, 50+) AND scaffold keyword in message OR >95% new. Does NOT fire on feature commits with high new-file ratio.
2. **Enriched LLM prompt**: for bulk-new commits without scaffold signal, metadata prompt is enriched with new-file stats so LLM classify can make informed routing decision.
3. **force_complex guard**: `migrat` filename check skipped when >50% files are new.
4. **Expanded patterns**: protobuf, snapshots, gRPC, docs, SVG.
5. **Hard cap**: 80h on FD path.

### Test results

**Regression tests** (`test_fd_regression.py`, 6/6 pass) — calls production `run_fd_hybrid()` against 6 known commits from artisan-private.

Scaffold commits (mock LLM, 0 real LLM calls):
| SHA | Label | Method | Estimate | GT |
|-----|-------|--------|----------|----|
| 188c43e | monorepo migration | FD_bulk_scaffold | 30.5h | 8-30h |
| c8269d0 | UI library setup | FD_bulk_scaffold | 8.8h | 4-8h |

Feature commits (mock LLM, abort after classify to verify routing):
| SHA | Label | New% | Routing result | GT |
|-----|-------|------|----------------|----|
| 1d02576 | Feat/dialer v1 | 90% | classify called, routed to FD | 40-60h |
| 9c2a0ed | Web visitors rehaul | 91% | classify called, routed to FD | 25-40h |
| 18156d0 | Temporal scheduler | 85% | classify called, routed to FD | 20-35h |
| 7d4a37e | Chat with Ava | 83% | classify called, routed to FD | 15-25h |

**Real LLM validation** (OpenRouter, `qwen/qwen3-coder-30b-a3b-instruct`) — all 4 feature commits correctly classified as high new_logic (75-85%) by enriched metadata prompt. Enriched prompt informs without biasing LLM. Feature commits route to complex path → full FD → 80h hard cap.

**Key finding**: the 80h hard cap is the effective estimator for large feature commits going through full FD. Per-file FD inherently overaggregates, producing estimates of 127-280h for commits with GT 15-60h. The cap brings this to 80h — a 60-72% reduction from pre-fix values, but still 1.3-5.3x over ground truth.

`test_bulk_commit_audit.py` — exploratory audit script (uses a different formula, NOT production code; useful for understanding the problem, not for validating the fix).

## Method Distribution (Full Order)

The order has 1256 commits total. Method distribution:

| Method | Count | Avg Hours | Max Hours |
|--------|-------|-----------|-----------|
| cascading_none | 373 | 1.5h | 8h |
| cascading_module | 498 | 10.0h | 32h |
| FD (full per-file) | 283 | 28.3h | 639.8h |
| FD_hybrid_mechanical_module | 52 | 9.0h | 18h |
| cascading_package | 16 | 9.7h | 15h |
| FD_cheap | 12 | 1.4h | 2h |
| FD_hybrid_mechanical_none | 10 | 4.2h | 8h |
| cascading_multi_package | 4 | 3.3h | 5h |
| FD_hybrid_mechanical_package | 4 | 9.8h | 15h |
| FD_hybrid_mechanical_multi_package | 2 | 15.0h | 25h |
| FD_hybrid_mechanical_system | 1 | 12.0h | 12h |
| root_commit_skip | 1 | 0.5h | 0.5h |

283 commits went through full FD with average 28.3h — worth auditing for similar bulk-copy patterns.

## Top-11 Commit Audit

All top-11 commits by effort went through full per-file FD. All had migration files triggering `force_complex`.
Total: **2238.7h** (16% of order total).

### Summary Table

| # | SHA | Message | Files | New% | Old Est. | Post-fix | Realistic | Fix effect |
|---|-----|---------|-------|------|----------|----------|-----------|------------|
| 1 | 188c43e | Refactor/monorepo | 870 | 95% | 639.8h | **30.5h** (scaffold) | 8-30h | -95% |
| 2 | 1d02576 | Feat/dialer v1 | 272 | 90% | 280.4h | **<=80h** (cap) | 40-60h | -71% |
| 3 | 0237e3a | WorkOS auth integration | 388 | 47% | 266.1h | **TBD** | 30-50h | ? |
| 4 | 47252d6 | Magic campaigns backend | 384 | 76% | 256.8h | **TBD** | 40-60h | ? |
| 5 | 4ccdf71 | Revamp leads lists | 265 | 59% | 175.6h | **TBD** | 30-50h | ? |
| 6 | 16dc74e | pnpm vitest migration | 1035 | 7% | 162.0h | **TBD** | 8-16h | ? |
| 7 | 9c2a0ed | Web visitors rehaul | 159 | 91% | 127.5h | **<=80h** (cap) | 25-40h | -37% |
| 8 | b4bb3f0 | leadsdb core rework | 145 | 30% | 87.3h | **TBD** | 20-35h | ? |
| 9 | 18156d0 | Temporal scheduler | 123 | 85% | 86.4h | **<=80h** (cap) | 20-35h | -7% |
| 10 | c8269d0 | wip ui library setup | 107 | 100% | 80.0h | **8.8h** (scaffold) | 4-8h | -89% |
| 11 | 7d4a37e | Chat with Ava | 105 | 83% | 76.8h | **<=80h** (cap) | 15-25h | 0% |

**Validated** (regression tests + real LLM): rows 1, 2, 7, 9, 10, 11. **TBD**: rows 3-6, 8 — require full order re-run (different new_file_ratio, may route differently).

### Per-Commit Analysis

**#2. Feat/dialer v1 — 280.4h (realistic: 40-60h)**

Full telephony feature: Twilio integration, compliance service, call-task service, dialer UI.
272 files, 90% new. 12 migration files -> `force_complex`.
- twilio-requirements.json (1091 lines) — data file counted as code
- Real business logic: DialerSettingsModal (2601), call-task.service (1075), compliance (994)
- Tests: only 460 lines (unusually low for feature size)
- bun.lock: 1710 lines

**#3. WorkOS auth integration — 266.1h (realistic: 30-50h)**

Auth + RBAC + billing integration with WorkOS. 388 files, 47% new.
36 migration files (!) -> `force_complex`. Many migrations are from initial schema setup (pre-existing, included in squash).
- Core auth logic: auth.ts (1277), auth.service (731), workos webhook (482)
- RBAC: organization-role.repository (393), team.service (331)
- Tests: 1696 lines, bun.lock: 789 lines

**#4. Magic campaigns backend — 256.8h (realistic: 40-60h)**

AI-powered campaign generation: prompts, generator, sequence editor, messaging UI.
384 files, 76% new. 2 migration files -> `force_complex`.
- Real complex feature: generator (620), prompts (445), TargetingStep (386), SequenceEditorCore (370)
- Very little test code (201 lines) — mostly production code
- This is the most "legitimately large" commit, but still ~4-6x over

**#5. Revamp leads lists — 175.6h (realistic: 30-50h)**

Unified list API with import sources, FlexTable UI, enrichment.
265 files, 59% new. 14 migration files -> `force_complex`.
- Tests: 3476 lines (20% of diff), good coverage
- Adapters, services, repositories — real architecture work
- list-to-flex-table.ts (601), list.ts API (558), default-fields (555)

**#6. pnpm vitest migration — 162h (realistic: 8-16h)**

**Worst overestimation after #1.** Tooling migration: jest -> vitest, npm -> pnpm.
1035 files, but only 7% new. Main work: config file changes.
- **pnpm-lock.yaml: 26,955 lines** (70% of all additions!) — auto-generated
- 4 migration-related files -> `force_complex`
- Real code changes: config modifications across 960+ existing files
- Most file changes are <20 lines (import path updates, config renames)
- This is a textbook mechanical/tooling commit

**#7. Web visitors rehaul — 127.5h (realistic: 25-40h)**

New website visitor tracking: backend services, repository, integration tests.
159 files, 91% new. 9 migration files -> `force_complex`.
- Tests: 3690 lines (17% of diff) — 4 integration test suites
- Core services: website-visitor.service (1120), company.service (728), repository (649)
- ts-api client: 794 lines

**#8. leadsdb core rework — 87.3h (realistic: 20-35h)**

Protobuf migration + service rework + documentation.
145 files, 30% new. Multiple migration docs -> `force_complex`.
- **Generated protobuf: 6760 lines** (2x leadsdb_pb.ts files) — NOT caught by regex
- **Documentation: 5219 lines** (AGENTS.md, MIGRATION_GUIDE, design docs) — not code
- Real code: leadsdb.service (1271), flex-table-resolution (497)
- add/del ratio 0.84 — genuine rework, but inflated by generated+docs

**#9. Temporal scheduler — 86.4h (realistic: 20-35h)**

Scheduler foundation: activities, workflows, DNC rules, campaign leads.
123 files, 85% new.
- **Documentation: 5867 lines** (temporal-scheduler-workflows.md 3595, scheduler-tests.md 1662)
- **pnpm-lock: 1190 lines** — auto-generated
- Tests: 6531 lines (28% of diff) — extensive test coverage
- Real code: scheduler.activities (1419), lead-enrollment.repository (591)
- ~9.5K lines actual code, but docs+lock inflate the diff

**#10. wip ui library setup — 80h (realistic: 4-8h)**

**Second worst overestimation.** UI component library scaffold.
107 files, 100% new, 0 deletions.
- **Icons.tsx: 4699 lines** — SVG icon components, NOT handwritten code
- **Snapshots: 3724 lines** (.snap files) — auto-generated test output
- Real components: MultiSelect (319), SideNav (264), Button (190), Select (179)
- This is classic scaffold + copy-paste of common UI components
- 80h = 2 full work weeks for a WIP library setup is absurd

**#11. Feature/chat with Ava — 76.8h (realistic: 15-25h)**

AI chat feature: tool use, context builder, knowledge base scraping.
105 files, 83% new. 2 migration files.
- Tests: 3054 lines (33% of diff) — good coverage
- Core: chat-with-ava.service (417), page-context-builder.test (880), get-lead-details (390)
- ts-api client: 354 lines
- Real, substantive feature work — but still overestimated

### Overestimation Causes by Commit

| Commit | force_complex | Bulk new files | Lock/generated | Docs as code | Tests inflate |
|--------|:---:|:---:|:---:|:---:|:---:|
| #1 monorepo | MIGRATION_PLAN.md | 95% new (cross-repo copy) | bun.lock, Icons.tsx | - | - |
| #2 dialer | 12 migrations | 90% new | bun.lock, twilio-req.json | - | - |
| #3 WorkOS | 36 migrations | 47% new | bun.lock | - | - |
| #4 campaigns | 2 migrations | 76% new | - | - | - |
| #5 leads | 14 migrations | 59% new | - | - | tests 20% |
| #6 pnpm/vitest | 4 migration files | 7% new | **pnpm-lock 70%!** | docs 3% | tests 8% |
| #7 visitors | 9 migrations | 91% new | - | - | tests 17% |
| #8 leadsdb | migration docs | 30% new | **protobuf 37%** | **docs 29%** | tests 6% |
| #9 scheduler | migration.ts | 85% new | pnpm-lock 5% | **docs 25%** | tests 28% |
| #10 ui setup | - | 100% new | **Icons.tsx 38%, .snap 30%** | - | - |
| #11 chat | 2 migrations | 83% new | - | - | tests 33% |

### Systematic Issues Found

**Issue 1: `force_complex` triggers on ANY migration file (all 10 commits)**

Every commit with DB migrations or migration documentation gets force-routed to full per-file FD, bypassing the metadata-only classify that would correctly route most of them to the mechanical path.

Impact: All top-11 commits. This is the single biggest cause.

Fix: Don't trigger `force_complex` when `new_file_ratio > 0.5` — migration files in a predominantly-new-file commit are part of the feature, not a signal of hidden complexity.

**Issue 2: `pnpm-lock.yaml` not in GENERATED_PATTERNS**

The current GENERATED_PATTERNS list includes `pnpm-lock\.yaml$` — but #6 (pnpm vitest migration) has 26,955 lines of pnpm-lock counted in the diff. This file is generated but may be entering FD through a different path, or the pattern isn't matching because the file is modified (not new).

Impact: #6 (27K lines), #9 (1.2K lines). Directly inflates FD per-file estimates.

Fix: Verify pnpm-lock.yaml is tagged `generated` by `classify_file_regex`. If it's being estimated by LLM, the tag isn't applying.

**Issue 3: Generated protobuf files not recognized**

Files ending in `_pb.ts` or `_pb2.py` are protobuf-generated code but aren't in GENERATED_PATTERNS.

Impact: #8 (6760 lines — 37% of diff).

Fix: Add `_pb\.ts$`, `_pb2\.py$`, `_pb\.go$`, `\.pb\.go$` to GENERATED_PATTERNS.

**Issue 4: SVG icon component files not recognized**

Large TSX files containing only SVG icon definitions (e.g., Icons.tsx at 4699 lines) are treated as manual code.

Impact: #10 (4699 lines — 38% of diff), #1 (6033 lines).

Fix: Heuristic in `classify_file_regex`: if a TSX file has >500 lines and >80% SVG path data (`<svg`, `<path`, `viewBox`), tag as `generated`.

**Issue 5: Snapshot files counted as code**

`.snap` files (Jest/Vitest snapshots) are auto-generated test output but not in GENERATED_PATTERNS.

Impact: #10 (3724 lines — 30% of diff).

Fix: Add `\.snap$`, `__snapshots__/` to GENERATED_PATTERNS (partially exists in DATA_PATTERNS but doesn't trigger `generated` tag).

**Issue 6: Documentation markdown inflates estimates**

Large `.md` files (design docs, migration guides, AGENTS.md) are treated as manual code in FD pipeline.

Impact: #8 (5219 lines), #9 (5867 lines).

Fix: Tag `.md` files as `docs` in `classify_file_regex` and assign fixed low estimate (e.g., 0.1h for <500 lines, 0.3h for larger).

## Estimated Total Impact (hypothesis, not validated)

The top-11 commits are confirmed overestimated (2238.7h total, realistic ~350-550h based on per-commit analysis). This is 16% of the order total (14,317.9h).

**Post-fix projection for top-11** (based on test results and LLM validation):
- Commits #1, #10: scaffold detector fires → 30.5h + 8.8h = **39.3h** (was 719.8h)
- Commits #2, #3, #4, #5, #7, #8, #9, #11: route to full FD → hit 80h cap → **640h** (was 1518.9h)
- Projected top-11 total: **~679h** (was 2238.7h) — **70% reduction**

Note: this projection assumes all 8 non-scaffold commits hit the 80h cap. In practice, some may route to mechanical path or produce FD estimates below 80h, depending on LLM classify results. Commit #6 (pnpm/vitest, 7% new) will NOT hit scaffold detector and may route differently.

Extrapolation to all 283 FD commits is speculative — the audit only examined the top 11. A full order re-run is required to measure actual impact and detect potential false negatives on other commit types.

## Solution

See [fix-fd-overestimation-design.md](fix-fd-overestimation-design.md) for the design document with implementation details, architecture decisions, open questions, and full verification results.
