# FD v3: Metadata-Only Holistic Estimation — Design Document

**Author**: Enigma (Hands) + Pavel
**Date**: 2026-03-27
**Status**: Validated — Phase 1 experiment complete (2026-03-27)
**Context**: [LLM Commit Effort Estimation — Metadata-Only Approach](consultations/LLM%20Commit%20Effort%20Estimation%20%E2%80%94%20Metadata-Only%20Approach.md)

---

## 1. Problem Statement

The current FD v2 pipeline for large commits (50+ files) systematically overestimates effort by 2-10x. Validation on 6 ground truth commits showed MAPE 80.4%, target is <50%.

**Root cause analysis** from validation run (claude-sonnet-4, 6 GT commits):

| Problem | Evidence | Impact |
|---------|----------|--------|
| Branch B (per-cluster LLM) overestimates 3-10x | Each cluster estimated in isolation, loses whole-commit context | Sum of 15 clusters = 128-457h vs GT 15-60h |
| Branch A (full diff in single call) doesn't fit | Even filtered diffs are 130K-1M tokens | Falls back to Branch B, never actually used |
| heuristic_total added on top of LLM estimate | combine_estimates() adds trivial file hours after LLM estimate | Inflates 16dc74e from 8.5h (perfect holistic) to 30.2h |
| Holistic estimate is surprisingly accurate | 2/5 within GT range, 5/5 within 2x — with minimal metadata | The good signal gets buried under the broken signals |

**Validation data (v2, Branch B + Holistic + combine):**

| Commit | Branch B | Holistic | Final (v2) | GT Range | Holistic accuracy |
|--------|---------|----------|-----------|----------|-------------------|
| 1d02576 dialer (272 files) | 456.7h | 85.0h | 88.7h | 40-60h | 1.4-2.1x |
| 16dc74e vitest (1036 files) | 43.5h | 8.5h | 30.2h | 8-16h | **in range** |
| 9c2a0ed visitors (159 files) | 231.2h | 45.2h | 53.6h | 25-40h | 1.1-1.8x |
| 18156d0 temporal (123 files) | 156.4h | 28.5h | 49.2h | 20-35h | **in range** |
| 7d4a37e chat (105 files) | 128.2h | 28.5h | 34.8h | 15-25h | 1.1-1.9x |

**Key insight**: The holistic estimator — seeing only metadata, no code — was the most accurate component. The academic literature (COCOMO II, COSMIC, JIT-SDP) confirms that code reading is not required for effort estimation. The signal is in the structure, not the content.

---

## 2. Proposed Approach: Single Holistic Call with Rich Metadata

### 2.1 Core Idea

Replace the dual-branch architecture (Branch A + Branch B + holistic + combine) with a **single LLM call** that receives a **rich structured metadata block** and produces one estimate. No code diff is sent. No heuristic_total is added separately — the LLM sees the complete picture and produces one number.

### 2.2 Why This Works

1. **No context overflow** — metadata block is ~2-4K tokens regardless of commit size
2. **Whole-commit context preserved** — LLM sees entire structure, not isolated chunks
3. **No double-counting** — one estimate covers everything, no heuristic + LLM summing
4. **COCOMO II validated** — the most successful parametric model uses zero code inspection
5. **Empirically demonstrated** — our holistic component already scored 2/5 in-range with minimal metadata

### 2.3 What Changes vs v2

| Component | v2 (current) | v3 (proposed) |
|-----------|-------------|---------------|
| File classification | SKIP / HEURISTIC / LLM_REQUIRED | Same classification, but role changes — **feeds metadata to prompt** |
| Heuristic_total | Added to LLM estimate | **Reported as metadata to LLM**, not added separately |
| Branch B (cluster LLM) | 15 LLM calls on cluster diffs | **Removed** |
| Branch A (full diff LLM) | 1 LLM call on filtered diff | **Removed** |
| Holistic (metadata LLM) | 1 LLM call, minimal metadata | **Enhanced**: 1 call, rich metadata block |
| Combine | min/avg of branch + holistic + heuristic | **Not needed** — single estimate |
| LLM calls per commit | 16-31 calls | **1 call** (+ optional judge call) |
| Cost per commit | ~$0.30-0.80 (sonnet, 15 clusters) | **~$0.01-0.03** |

---

## 3. Rich Metadata Block — Feature Set

Based on the research paper's prioritized feature set, mapped to what our pipeline already computes.

### 3.1 Features We Already Have (zero cost)

These are computed in `_tag_file()`, `classify_file_regex()`, `adaptive_filter()`, and `run_fd_hybrid()`:

**P0 — Core Structural:**
- `fc`, `la`, `ld` — files changed, lines added, lines deleted
- `new_file_ratio` — % of add-only files (proxy for COCOMO RUSE multiplier)
- File extension distribution — already computed in `_build_metadata_prompt()`
- Tag distribution — `test`, `generated`, `config`, `docs`, `locale`, `test_data`, etc.
- Per-file stats — filename, lines added/deleted, tags (first 50 files)

**P1 — Pattern-Based:**
- Move/rename detection — `classify_move_commit()` -> `is_move`, `move_type`, `pairs`
- Bulk refactoring — `detect_bulk_refactoring()` -> `is_bulk`, `bulk_ratio`, `pattern_description`
- Scaffold signals — `has_scaffold_signal`, `is_bulk_new`, `is_near_total_add`
- Generated file exclusion — `classify_file_tier()` SKIP tier

### 3.2 Features to Add (near-zero cost)

**P0 — Missing from current pipeline:**

1. **Entropy of change distribution**
   ```
   H = -sum(p_i * log2(p_i))  where p_i = lines_changed_i / total_lines_changed
   ```
   High entropy = changes spread evenly (systematic refactor). Low entropy = concentrated (targeted feature work). Research: strongest predictor after churn in JIT-SDP meta-analyses. Cost: 5 lines of code.

2. **Effective churn** (after generated file exclusion)
   We compute `heuristic_total` from filtered files but don't report `effective_la` / `effective_ld` — lines in substantive files only. This is the "real" size the LLM should reason about.

3. **File size distribution** — p50, p90, max lines per file
   Distinguishes "100 files of 10 lines each" from "5 files of 2000 lines each". Cost: one sort + index.

4. **Module boundary count**
   Number of unique top-level directories touched = architectural breadth. Cost: set comprehension on paths.

### 3.3 Features to Add via Cheap LLM Pre-call (Phase 2)

5. **Intent classification** — feature / bugfix / refactor / migration / tooling / churn
   Claude Haiku, 1 call, <$0.001. Research says this is the strongest single semantic signal. Note: the 100% XGBoost accuracy cited in research is for binary refactoring detection, not general multi-class intent. Expect lower accuracy for the full 6-class taxonomy.

6. **Architectural scope** — isolated / cross-module / system-wide
   Can be approximated from directory structure without LLM, or enhanced with LLM.

### 3.4 Features Deferred (Phase 3+)

7. AST complexity delta via tree-sitter
8. Bayesian prior (COCOMO-style heuristic) blended with LLM posterior with learned weights

---

## 4. Prompt Architecture

### 4.1 System Prompt

```
You are an expert software effort estimator. Estimate how many hours a
MID-LEVEL developer (3-5 years experience, NO AI copilot) would need to
implement the described changes.

CALIBRATION (starting heuristics — will be revised after first 10-20 GT commits):
- 1 hour = approximately 50-100 lines of non-trivial logic for a mid-level dev
- Generated files (lock, .d.ts, protobuf, snapshots) = 0 hours
- Renamed/moved files = 0.5h per 50 files of restructuring
- Test code = approximately 50-75% effort of corresponding logic code
- Config files (tsconfig, eslint, docker) = 0.1-0.5h each
- Documentation = 0.3h per 100 lines
- Bulk same-edit refactors (import rename across 200 files) = 2-4h total

ANTI-OVERESTIMATION:
- Large file counts DO NOT mean large effort. Most big commits are
  dominated by generated code, migrations, config, or bulk renames.
- A 500-file commit is often 8-20h, not 100h+
- New files that are boilerplate/scaffold are cheap (0.1h each)
- Only genuinely novel algorithm/business logic code is expensive

RESPONSE FORMAT (JSON):
{"low": N, "mid": N, "high": N, "confidence": "low|medium|high", "reasoning": "..."}

Where:
- low/mid/high = estimated hours range
- confidence = your certainty level
- reasoning = 2-3 sentences: (1) change type classification, (2) effective code size, (3) complexity adjustment
```

### 4.2 User Prompt — Structured Metadata Block

```
COMMIT: {message}
LANGUAGE: {language}

CHANGE VOLUME:
- Raw: {fc} files, +{la}/-{ld} lines
- After filtering generated/trivial: {effective_fc} substantive files, +{effective_la}/-{effective_ld}
- Generated/auto (0h): {skip_count} files
- Trivial (config/test/docs): {heuristic_count} files (~{heuristic_total:.1f}h by formula)

FILE TYPE BREAKDOWN:
- Logic: {logic_count} files, +{logic_lines} lines
- Tests: {test_count} files, +{test_lines} lines (test ratio: {test_ratio}%)
- Config/infra: {config_count} files
- Documentation: {docs_count} files
- New files (from scratch): {new_count} ({new_pct}% of total)

DISTRIBUTION:
- Entropy: {entropy:.2f} (max={max_entropy:.2f}; {interpretation})
- Largest file: {max_file} (+{max_lines} lines)
- File sizes: p50={p50} lines, p90={p90} lines
- Modules touched: {module_count} ({module_list})

PATTERN FLAGS:
{flags_or_none}

STRUCTURE (substantive files grouped by directory):
{cluster_summary}

Estimate total hours for implementing this entire commit.
```

### 4.3 Key Design Decisions

**heuristic_total is SHOWN as metadata, NOT added separately.**

The prompt shows: `Trivial (config/test/docs): 370 files (~21.7h by formula)`. The LLM decides the actual weight. For vitest migration (370 jest->vitest config renames), the LLM should recognize these are trivial and discount to ~2h. For a real feature with 30 comprehensive test files, it might estimate 15h. The LLM has the semantic context to judge — a blind formula doesn't.

This directly fixes the biggest accuracy killer in v2: the 16dc74e commit where holistic nailed 8.5h but got inflated to 30.2h by adding 21.7h of heuristic.

**Cluster structure is metadata-only, not per-cluster estimation.**

We still run `build_clusters()` to organize files into logical groups. But instead of sending each cluster's diff to the LLM, we show the cluster names, file counts, and line counts as metadata. This gives architectural context: "3 clusters in `api/services/`, 2 in `web/components/`, 1 in `migrations/`" — enough to understand the shape of work without reading any code.

**3-step constrained CoT via `reasoning` field.**

Research shows constrained CoT (forced analytical steps) outperforms both open-ended CoT and direct answering for structured estimation tasks. The three steps: (1) classify change type, (2) estimate effective code volume, (3) adjust for complexity/novelty.

**Ranges (`low`, `mid`, `high`), not point estimates.**

Research: asking for ranges produces better-calibrated midpoints than asking for a single number. Also enables confidence routing in Phase 2 (wide range = flag for review).

**Calibration anchors are starting values, not ground truth.**

The numeric anchors in the system prompt (50-100 lines/hour, 0.5h per 50 renames, etc.) are expert heuristics consistent with industry practice but not sourced from published studies. They MUST be treated as initial parameters subject to revision after the first 10-20 GT validation runs. Implementation should read these from a `calibration_config` (env or file), not hardcode in the prompt template.

---

## 5. LLM-as-Judge Sanity Check (Phase 1.5)

A second call to verify plausibility. Cheap (Haiku-class), catches obvious outliers:

```
COMMIT SUMMARY: {message}, {fc} files, +{la}/-{ld}
ESTIMATE: {low}-{mid}-{high}h, confidence={confidence}

PLAUSIBILITY RULES:
- Single-module feature: rarely >40h
- Config/tooling migration: rarely >16h
- Bulk rename/move: rarely >4h
- Full-system new feature with tests: can reach 60-80h

Verdict: PLAUSIBLE, OVER, or UNDER?
Return: {"verdict": "...", "suggested_mid": N, "reason": "..."}
```

When verdict is OVER or UNDER: take judge's `suggested_mid` directly (or blend with 0.7 weight toward judge). The judge explicitly applies plausibility rules — if it says "tooling commit, shouldn't exceed 16h", that constraint-based correction is more reliable than a naive average of the two estimates.

---

## 6. Implementation Plan

### Phase 1: MVP Holistic Estimator (this sprint)

**Goal**: Replace v2 Branch B + combine with single holistic call. Target MAPE <50%.

**New code:**
1. `compute_entropy(file_info)` — Shannon entropy of change distribution
2. `compute_metadata_block(file_info, message, language, ...)` — assembles all P0/P1 features into structured text
3. `estimate_holistic_v3(metadata_block, call_ollama_fn)` — single LLM call with rich metadata

**Updated code:**
4. `_run_fd_v2()` — replace Branch B/A/holistic/combine flow with `estimate_holistic_v3()` call
5. Remove `heuristic_total` addition — LLM sees it as metadata, decides the weight

**Preserved (reused as metadata sources):**
- `adaptive_filter()` — classifies files into SKIP/HEURISTIC/SUBSTANTIVE
- `build_clusters()` — groups files for structural context in prompt
- `classify_file_tier()` — per-file classification
- Scaffold detector, cheap signal checks — early exits before v3 gate

**Removed:**
- `estimate_branch_b()` — per-cluster LLM estimation
- `estimate_branch_a()` — single-call full-diff estimation
- `combine_estimates()` — dual-signal combining
- `call_openrouter_large()` — separate large-model API call

**Validation:**
- Run on all 10 GT commits from `docs/ground-truth-request.md`
- **Zero-shot only** — do NOT use GT commits as few-shot examples (data leakage)
- Compute baseline: `heuristic_total`-only estimator MAPE for comparison
- Ship criterion: v3 MAPE < 50% AND v3 MAPE < baseline MAPE (must beat naive formula)

### Phase 2: Calibration + Judge (next sprint, requires 20+ GT commits)

1. LLM-as-Judge plausibility check (Haiku, $0.001)
2. Intent classification pre-call (Haiku, $0.001)
3. Per-commit-type multiplicative correction from GT data
4. Temperature-varied ensemble (3 calls at T=0.0/0.3/0.7, take median) for low-confidence
5. Revise calibration anchors in system prompt based on Phase 1 GT error analysis

### Phase 3: Few-Shot + Adaptive (future, requires 30+ GT commits)

1. Feature vector store from accumulated GT data
2. Similarity-based few-shot example retrieval (3-5 examples per commit, with strict train/test split)
3. Per-repository calibration coefficients (stored in DB)
4. Bayesian prior (heuristic estimate) + LLM posterior blending with learned weights

---

## 7. Experiment Results (Phase 1)

Experiment run: 2026-03-27. Script: `packages/server/scripts/pipeline/experiment_v3.py`. 5 models x 10 GT commits, zero-shot, metadata-only prompt (~1500 input tokens per call).

### 7.1 Model Comparison

| Model | MAPE | MdAPE | In-Range | Within 2x | Bias (avg) | Over/Under | $/commit |
|-------|------|-------|----------|-----------|-----------|------------|----------|
| **Opus 4.6** | **26.0%** | **20.0%** | **6/10** | **10/10** | +7.0h | 7O/2U | $0.036 |
| **Qwen3 Coder+** | **32.1%** | **25.2%** | **6/10** | **10/10** | -1.9h | 4O/5U | $0.001 |
| Sonnet 4.6 | 80.2% | 46.2% | 4/10 | 8/10 | +30.1h | 8O/1U | $0.007 |
| Haiku 4.5 | 131.7% | 103.9% | 2/10 | 7/10 | +40.4h | 10O/0U | $0.002 |
| GPT-5.3 Codex | 170.0% | 170.0% | 0/5* | 2/5* | +57.8h | 5O/0U | $0.009 |

*GPT-5.3 Codex: 5/10 calls failed (JSON parse errors / NoneType). Metrics on successful calls only.

### 7.2 Key Findings

1. **Phase 1 target exceeded**: Opus MAPE 26% and Qwen MAPE 32% — both well under the <50% target. v2 baseline was 80.4%.
2. **Metadata-only works**: Without a single line of code in the prompt, top models achieve accuracy comparable to expert estimation (30-50% MAPE in literature).
3. **Cost is negligible**: V3 holistic prompt is ~1500 tokens input. At $0.001/commit (Qwen), even 100 large commits per order = $0.12.
4. **Qwen3 Coder+ is the value champion**: 30x cheaper than Opus, only 6pp worse MAPE, best-calibrated bias (-1.9h, nearly zero).
5. **Systematic overestimation in weaker models**: Haiku (10/10 over), Sonnet (8/1 over), GPT (5/0 over). Only Qwen has balanced bias.
6. **GPT-5.3 unreliable for structured output**: 50% failure rate on JSON responses.

### 7.3 Decision: Production Model

- **Pilot phase**: Qwen3 Coder+ (`qwen/qwen3-coder-plus`) — best value, balanced bias, 10/10 within 2x.
- **Enterprise tier** (future): Opus 4.6 — best accuracy, but 30x cost. Reserved for premium plans.

### 7.4 Accuracy Targets (updated with actuals)

| Metric | v2 (was) | v3 Phase 1 (actual) | v3 Phase 2 (target) | v3 Phase 3 (target) |
|--------|----------|---------------------|---------------------|---------------------|
| MAPE | 80.4% | **32.1%** (Qwen) | <25% | <20% |
| In GT range | 0/6 | **6/10** | 7/10 | 8/10 |
| Within 2x | 5/6 | **10/10** | 10/10 | 10/10 |
| LLM calls | 16-31 | **1** | 2-4 | 4-6 |
| Cost/commit | $0.30-0.80 | **$0.001** | $0.003-0.005 | $0.004-0.006 |
| Latency | 80-110s | **~4s** | <15s | <20s |

---

## 8. Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LLM underestimates complex features it can't see in diff | Medium | High | Judge call catches outliers; low-confidence flag for review |
| Overfitting to GT set (only 10 commits) | High | Medium | Leave-one-out cross-validation; collect more GT data |
| LLM ignores heuristic_total metadata, underestimates trivial work | Medium | Medium | Validate on config-heavy commits; add floor if needed |
| Model API changes affect calibration | Low | Medium | Pin model version; recalibrate on GT after model changes |
| Entropy/distribution features don't improve MAPE | Medium | Low | System works without them; revert if no improvement measured |
| LLM returns invalid JSON | Medium | Low | Schema enforcement via response_format; regex fallback |

---

## 9. Open Questions and Review Decisions

### Resolved after expert review:

1. **Heuristic_total floor** — **No floor in Phase 1.** Let the LLM see the formula numbers and decide. Introduce a floor only if GT validation reveals systematic underestimation for config-heavy commits.

3. **Entropy normalization** — **Raw value + max for context.** `Entropy: 3.42 (max=7.09; moderately spread)`. Normalization to [0,1] loses interpretability for the LLM.

4. **Few-shot in Phase 1** — **No. Zero-shot only.** Using 10 GT commits as both few-shot examples and evaluation set = data leakage. Few-shot enters in Phase 2 when we have 20+ GT commits and can split train/test.

5. **v2/v3 coexistence** — **Parallel run via `FD_V3_ENABLED=true`.** Only way to get honest comparison on the same commits.

### Resolved after Phase 1 experiment (2026-03-27):

2. **Model selection** — **Qwen3 Coder+ for pilot, Opus 4.6 for enterprise.** Experiment showed Qwen achieves MAPE 32% at $0.001/commit (30x cheaper than Opus at 26% MAPE). Sonnet/Haiku/GPT systematically overestimate. Qwen has best-calibrated bias (-1.9h). Judge model (Phase 2): Haiku at $0.002/call — its overestimation bias is acceptable for plausibility checking (catching outliers, not precision).

6. **Effective churn definition** — **Substantive (LLM-tier) files only.** Experiment prompt uses `effective_la`/`effective_ld` from `adaptive_filter()` LLM files. Heuristic-tier hours are reported separately as `heur_total` metadata. This avoids double-counting and gives the LLM a clear signal of what requires human judgment vs formula.
