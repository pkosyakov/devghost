# Design: Fix FD Pipeline Overestimation

**Date**: 2026-03-25
**Status**: Implemented, revision 2. Validated (routing + real LLM). Pending: full order re-run.
**Audit**: [audit-bulk-commit-639h.md](audit-bulk-commit-639h.md)
**Expert review (FD v2)**: [expert-review-cluster-fd.md](expert-review-cluster-fd.md)
**Ground truth request**: [ground-truth-request.md](ground-truth-request.md)
**Files changed**: `file_decomposition.py`, `run_v16_pipeline.py`
**Regression tests**: `test_fd_regression.py` (6/6 pass)

## Problem Statement

The File Decomposition (FD) pipeline systematically overestimates effort for large commits that are predominantly new files. The worst case: commit `188c43e` estimated at **639.8h**, ground truth **8-30h** (x21 over).

Root cause: a heuristic (`force_complex`) intended for breaking-change commits fires on any commit containing a file with "migrat" in the name. This bypasses the LLM metadata classifier (which would correctly route to the low-effort mechanical path) and sends the commit to full per-file FD, where 783 untagged files each receive 0.5-2h LLM estimates that sum to ~640h.

The problem affects all top-11 commits in the audited order (2238.7h total, 16% of order total 14,317.9h).

## Pipeline Architecture (Before Fix)

```
run_commit()
  |
  |-- diff < FD_THRESHOLD (60K) --> cascading v15 pipeline
  |
  |-- diff >= FD_THRESHOLD --> run_fd_hybrid()
        |
        |-- Step 0: cheap signals (no LLM) --> immediate estimate
        |-- Step 1: split diff, regex classify, detect move/bulk
        |-- Step 2: LLM metadata classify (1 call) --> new_logic%
        |-- Step 2b: force_complex check  <-- BUG
        |     if 'migrat' in any filename --> skip Step 2, goto full FD
        |-- Step 3: route by new_logic%
        |     < 20% --> mechanical (1 LLM call)
        |     >= 20% --> full per-file FD (N LLM calls)
```

## Solution: Layered Defense (Revision 2)

### Key change vs revision 1

Revision 1 used a broad early exit for any commit with >80% new files. Expert review found this creates **false negatives on feature commits**: "Feat/dialer v1" (90% new, GT 40-60h) was capped to ~21h, "Web visitors rehaul" (91% new, GT 25-40h) to ~19h.

Revision 2 narrows the early exit to require **explicit scaffold/copy signal** in the commit message. Feature commits with high new-file ratio are no longer intercepted — they are routed to LLM metadata classify instead.

Real LLM validation (OpenRouter, `qwen/qwen3-coder-30b-a3b-instruct`) confirmed routing is correct: all 4 feature commits classified as high new_logic (75-85%) and route to complex/full FD. The enriched prompt does NOT bias LLM toward underestimation. However, full FD then produces estimates that hit the 80h hard cap — the cap is the only protection against full-FD overaggregation on large feature commits.

### Architecture (After Fix)

```
run_fd_hybrid()
  |
  |-- Step 0: cheap signals (unchanged)
  |-- Step 1: split, classify, detect
  |-- Step 1b: compute new_file_ratio
  |-- Step 1c: SCAFFOLD DETECTOR (new)               <-- Layer 1
  |     REQUIRES: file composition (>80% new, >10K, 50+)
  |       AND: scaffold keyword OR >95% new
  |     If fires: capped estimate, 0 LLM calls
  |     If NOT: bulk-new context added to metadata prompt for Step 2
  |-- Step 2: LLM metadata classify (enriched prompt)
  |-- Step 2b: force_complex (GUARDED)                <-- Layer 2
  |     'migrat' check SKIPPED when new_file_ratio > 0.5
  |-- Step 3: route by new_logic% (unchanged)
  |
run_commit()
  |-- correction_rules, complexity_guard (unchanged)
  |-- HARD CAP 80h (new)                              <-- Layer 3
```

## Layer 1: Scaffold Detector (Step 1c)

### Trigger: two conditions required

**Condition 1 — File composition** (all three):
```python
new_file_ratio > 0.8    # >80% files purely new (added>0, deleted==0)
la > 10000              # >10K total lines added
fc >= 50                # 50+ files changed
```

**Condition 2 — Scaffold signal** (any one):
```python
# Keyword in commit message:
_SCAFFOLD_KEYWORDS = r'\b(monorepo|scaffold|boilerplate|template|seed|
    vendor|copy\s+(from|into|over)|bootstrap|initial\s+(commit|import|setup))\b'
_SCAFFOLD_SETUP = r'\b(wip|init)\b.*\b(setup|library|scaffold|skeleton)\b'

# OR: extremely high new_file_ratio (>95%) — scaffold even without keyword
new_file_ratio > 0.95
```

### Why two conditions

File composition alone is insufficient. The top-11 audit data demonstrates this clearly:

| SHA | Message | New% | Type | Correct route |
|-----|---------|------|------|---------------|
| 188c43e | Refactor/**monorepo** | 95% | scaffold | early exit |
| c8269d0 | **wip** ui library **setup** | 100% | scaffold | early exit |
| 1d02576 | **Feat**/dialer v1 | 90% | feature | LLM classify |
| 9c2a0ed | Web visitors rehaul | 91% | feature | LLM classify |
| 18156d0 | Temporal scheduler | 85% | feature | LLM classify |
| 7d4a37e | Chat with Ava | 83% | feature | LLM classify |

Commits #1 and #10 have scaffold keywords ("monorepo", "wip...setup"). Commits #2, #7, #9, #11 are real feature work — high new-file ratio, but substantive business logic that requires LLM evaluation.

The >95% threshold catches edge cases where keyword is absent but file composition is so extreme that the commit is almost certainly bulk copy (e.g., initial repo import).

### Enriched LLM prompt for non-scaffold bulk-new

When a commit passes the file composition check but NOT the scaffold signal, the metadata prompt is enriched with bulk-new context:

```
Note: 244/272 files (90%) are brand-new (add-only, zero deletions).
32 of those are generated/config/test. This is a high-volume commit.
Consider whether the new files represent original feature work or copied/scaffolded code.
```

This helps LLM classify make a more informed decision about `new_logic_percent` without bypassing it.

### Estimation formula (scaffold early exit)

```python
substantive_new = len(new_files) - low_effort_new
bulk_est = min(40.0, 16.0 + substantive_new * 0.02)
if low_effort_pct > 0.5:
    bulk_est = min(bulk_est, 8.0 + substantive_new * 0.02)
```

The 0.02h coefficient is intentionally flat — in scaffold/copy, individual files contribute near-zero marginal effort. Cap raised to 40h (from 32h in rev 1).

## Layer 2: Precision Fixes

### 2a. force_complex guard

```python
# 'migrat' filename check skipped when >50% files are new
if not force_complex and new_file_ratio <= 0.5:
    for f in file_info:
        if 'migrat' in f['filename'].lower():
            force_complex = True; break
```

Safe for restructuring: moved files have `deleted > 0`, so they don't count as "new" and `new_file_ratio` stays low.

Version release (`^v\d`) and breaking-change keyword triggers are unaffected.

### 2b. Expanded GENERATED_PATTERNS

Added: `_pb.ts`, `_pb.js`, `_pb2.py`, `.pb.go` (protobuf), `_grpc_pb.ts`, `_grpc.pb.go` (gRPC), `.snap`, `__snapshots__/` (test snapshots). Removed `__snapshots__/` from `DATA_PATTERNS` to avoid duplicate tagging.

### 2c. Expanded MOVE_KEYWORDS

Added: `monorepo`, `workspace`. Now matches "Refactor/monorepo (#597)".

### 2d. Docs and SVG heuristics

- `.md/.mdx/.rst` files tagged `docs`, capped at 1h/file (`0.003h * lines_added`)
- `.svg` files auto-tagged `generated` (0.05h)
- Large TSX/JSX with >30% SVG paths tagged `svg_icon_component` (0.05h)

## Layer 3: Hard Cap

```python
MAX_FD_HOURS = 80.0  # 2 work-weeks, applied only to FD path
```

The cascading v15 pipeline (smaller diffs) has its own correction rules and complexity guard; extreme overestimates are structurally unlikely there because the LLM sees the full diff.

## Verification

### Regression test suite (6/6 pass)

`test_fd_regression.py` calls the production `run_fd_hybrid()` against 6 known commits from artisan-private. Uses a mock LLM with controlled `_ClassifyDone(BaseException)` abort to verify routing without running full per-file FD.

**Scaffold tests** (2 commits): verify early exit fires, estimate is in range, 0 LLM calls.

| SHA | Label | Method | Estimate | GT | LLM calls |
|-----|-------|--------|----------|----|-----------|
| 188c43e | monorepo migration | FD_bulk_scaffold | 30.5h | 8-30h | 0 |
| c8269d0 | UI library setup | FD_bulk_scaffold | 8.8h | 4-8h | 0 |

**Feature tests** (4 commits): verify scaffold early exit does NOT fire and LLM classify IS called. The mock aborts cleanly after classify — no estimate is produced. This is a routing smoke test, not an estimate validation.

| SHA | Label | New% | Result | GT |
|-----|-------|------|--------|----|
| 1d02576 | Feat/dialer v1 | 90% | classify called, routed to FD | 40-60h |
| 9c2a0ed | Web visitors rehaul | 91% | classify called, routed to FD | 25-40h |
| 18156d0 | Temporal scheduler | 85% | classify called, routed to FD | 20-35h |
| 7d4a37e | Chat with Ava | 83% | classify called, routed to FD | 15-25h |

### Real LLM validation (OpenRouter)

Tested enriched metadata prompt on all 4 feature commits with `qwen/qwen3-coder-30b-a3b-instruct` via OpenRouter. Purpose: verify the enriched prompt doesn't bias LLM toward lower new_logic% (which would mis-route features to mechanical path).

**Results**: All 4 commits correctly classified as high new_logic (75-85%) by LLM, routed to complex path (full FD). The enriched prompt works as intended — informs without biasing.

**Implication**: Feature commits with high new-file ratio go through full per-file FD, which produces estimates that hit the 80h hard cap. The cap is the effective estimator for these commits. This is significantly better than the pre-fix 127-280h range, but the gap to ground truth (15-60h) remains.

### What is validated

- Scaffold commits (`monorepo`, `wip...setup`) correctly intercepted with 0 LLM calls
- Scaffold estimates within 2x of ground truth upper bound (30.5h vs GT 8-30h, 8.8h vs GT 4-8h)
- Feature commits with high new-file ratio (83-91%) are NOT intercepted by scaffold detector
- Feature commits reach LLM classify and are correctly classified (real LLM confirmed)
- Enriched metadata prompt does NOT bias LLM toward underestimation
- force_complex guard correctly skips `migrat` check for high-new-file-ratio commits
- Expanded patterns compile and don't break existing classification
- Hard cap 80h applies correctly to FD path

### What is NOT validated

- **Estimate accuracy for feature commits through full FD**: all 4 feature commits hit the 80h hard cap. Whether full FD would produce accurate estimates without the cap is unknown — it didn't before (127-280h range), and the fix doesn't address per-file FD overaggregation.
- **Full order re-run**: actual impact on all 1256 commits is unknown. The audit's top-11 analysis is descriptive; impact estimates on the full order are hypothetical.
- **Regression on non-audited commits**: commits outside this order may have different characteristics.
- **Scaffold keyword coverage breadth**: only 2 scaffold commits tested. The keyword list may miss non-English or domain-specific scaffold patterns.

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Scaffold keyword list too narrow (misses a scaffold type) | Medium | Scaffold routed to full FD, overestimated | >95% threshold catches extreme cases. Hard cap limits damage. List can be extended. |
| Scaffold keyword matches a feature (e.g., "bootstrap" in "bootstrap the payments feature") | Low | Feature underestimated by scaffold formula | "bootstrap" as a standalone verb is uncommon in feature commit messages. Monitor after deploy. |
| force_complex guard misses a real breaking change at new_file_ratio 0.55 | Low | Routes to LLM classify instead of full FD | LLM classify can still route to complex path if new_logic% is high. Version release and breaking keyword triggers unaffected. |
| Enriched LLM prompt biases classify toward lower new_logic% | Low | Feature underestimated | Prompt says "consider whether" — doesn't assert it's scaffold. LLM has full file list context. |
| Hard cap (80h) clips a genuinely massive commit | Low | Underestimates by the difference | 80h = 2 work-weeks. Commits exceeding this are extremely rare in practice. |

### What this does NOT fix

1. **Per-file FD overestimation on non-bulk commits**: full FD inherently over-aggregates because per-file estimates don't account for shared context.
2. **Test code overvaluation**: `rule6_test_heavy` only fires at >60% test files.
3. **Correction rules calibrated for cascading pipeline, not FD**: structural mismatch not addressed.

## Open Questions

1. **Scaffold keyword coverage**: current list may miss non-English keywords or domain-specific terms. Should this be configurable via `SystemSettings`? (Only 2 scaffold commits tested so far.)

2. **0.02h per substantive file coefficient**: the scaffold estimate is almost entirely base-driven (16h). Is this the right model, or should it scale more with file count? (Current results: 30.5h for 870-file monorepo vs GT 8-30h — within 2x of upper bound but 3.8x of lower bound.)

3. **Hard cap value**: 80h is where all 4 feature commits land after full FD. Options:
   - **Lower to 40-60h** — closer to GT (15-60h), but risks clipping genuinely large work
   - **Add bulk-new discount** — if >80% new, multiply FD result by 0.5-0.7 before cap
   - **Leave at 80h** — significantly better than pre-fix 127-280h range, accept remaining gap

   LLM validation showed the cap IS the effective estimator for large feature commits through full FD. This is a known limitation of per-file FD aggregation, not a routing problem.

4. **force_complex threshold**: 0.5 vs 0.7? At 0.5, commit #5 (59% new, 14 migrations, GT 30-50h) skips `migrat` check. At 0.7, it would still trigger. Which is correct depends on whether LLM classify handles these better than full FD.

5. **Full order re-run required before merge**: run all 1256 commits and compare old vs new distribution, specifically checking for false negatives on feature commits. This is the primary remaining validation step.
