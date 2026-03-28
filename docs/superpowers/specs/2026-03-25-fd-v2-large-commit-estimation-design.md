# FD v2: Large Commit Estimation Pipeline

**Date**: 2026-03-25
**Updated**: 2026-03-26 (model comparison results)
**Status**: Design approved. Surrogate model test completed (holistic single-call, not end-to-end v2 pipeline). Pending implementation + full pipeline validation.
**Problem**: Per-file FD with summation is fundamentally broken for large commits (50+ files). Shared context between files is invisible to per-file LLM estimation, causing systematic overaggregation. Hard cap is a band-aid.
**Success criteria**: MAPE < 50% on ground-truth sample from tech lead
**Ground truth**: Confirmed by tech lead (artisan-private). 3 commits with expert estimates.
**Model comparison**: Surrogate holistic single-call test on 3 GT commits. Claude Sonnet 4 — MAPE 60%, 2/3 in GT, ~$0.065/call. Does NOT validate the full v2 pipeline (filter + cluster + holistic + combine). See [Model Comparison Results](#model-comparison-results).
**Related docs**: [audit](../../audit-bulk-commit-639h.md), [v1 fix](../../fix-fd-overestimation-design.md), [expert review](../../expert-review-cluster-fd.md)

## Architecture Overview

Two switchable branches for large commit estimation, with shared adaptive filter and independent holistic sanity check.

Note: `run_fd_hybrid()` is only called when `len(diff) > FD_THRESHOLD` (~60K chars) — this is the caller's gate in `run_commit()`. The v2 path adds a second gate on file count.

```
run_fd_hybrid()
  |
  |-- Step 0: cheap signals (unchanged, 0 LLM)
  |-- Step 1: split diff, regex classify (unchanged)
  |-- Step 1b: compute new_file_ratio (unchanged)
  |-- Step 1c: scaffold detector (unchanged, 0 LLM)
  |     If fires → return scaffold estimate
  |
  |-- fc < FD_V2_MIN_FILES (default 50)?
  |     YES → existing v1 path (classify → mechanical/complex)
  |     NO  → v2 path:
  |
  |-- Step 2: ADAPTIVE FILTER
  |     Classify files into SKIP (0h) / HEURISTIC / LLM_REQUIRED
  |     Always AGGRESSIVE mode (v2 only activates at 50+ files)
  |     Output: heuristic_total + llm_files + llm_diff
  |     EDGE CASE: if no LLM files → return heuristic_total immediately
  |
  |-- Step 3: BRANCH ROUTING
  |     Branch A (single-call): if enabled AND filtered diff <= 30K tokens
  |       → 1 call to powerful LLM with full filtered diff
  |     Branch B (cluster-based): otherwise
  |       → directory+suffix clustering → 5-15 cluster LLM calls
  |
  |-- Step 3.5: BUILD CLUSTERS FOR HOLISTIC PROMPT
  |     Always performed (cheap, no LLM) — used in Step 4 regardless of branch
  |
  |-- Step 4: INDEPENDENT HOLISTIC ESTIMATE
  |     Separate LLM call on metadata + cluster structure (no branch estimate)
  |
  |-- Step 5: COMBINE
  |     final = average(branch_est, holistic) + heuristic_total
  |     If divergence > 2x → final = min(branch, holistic) + heuristic_total
  |
  |-- Post-FD: hard cap 80h (safety net). Correction rules and complexity
  |     guard designed for v1 — apply with caution, may need recalibration.
  |     v2 method names in output allow selective rule bypass if needed.
```

### Return value structure

v2 returns the same dict format as v1 for backward compatibility with `run_commit()`:

```python
{
    'estimated_hours': float,       # final combined estimate
    'raw_estimate': float,          # branch estimate before combining
    'method': str,                  # e.g. 'FD_v2_cluster_holistic'
    'routed_to': str,               # 'v2_cluster' | 'v2_single_call'
    'analysis': dict,               # holistic LLM output (change_type, scope, etc.)
    'rule_applied': str | None,
    'fd_details': {
        'branch': str,              # 'A' | 'B'
        'branch_estimate': float,
        'holistic_estimate': float,
        'heuristic_total': float,
        'filter_stats': {
            'skip': int, 'heuristic': int, 'llm': int
        },
        'clusters': [...],          # cluster names, sizes, per-cluster estimates
    },
}
```

## Step 2: Adaptive Filter

### Filter mode

v2 activates only at 50+ files, so the filter always runs in AGGRESSIVE mode. LIGHT and MODERATE modes are reserved for future use if `FD_V2_MIN_FILES` is lowered.

```
v2 path (fc >= 50) → always AGGRESSIVE (skip + all heuristic)
```

### File classification matrix

In all heuristic formulas, `lines` means `lines_added` (from the diff numstat).

| File type | Detection | AGGRESSIVE mode |
|-----------|-----------|-----------------|
| Generated | `_pb.ts`, `.snap`, lock files, `__snapshots__/` | SKIP 0h |
| Binary/SVG | `.png`, `.jpg`, `.svg`, binary diffs | SKIP 0h |
| Locale | `.json` in `messages/`, `locales/`, `i18n/` | SKIP 0h |
| Docs | `.md`, `.mdx`, `.rst` | HEUR `min(0.5, lines_added * 0.003)` |
| Config | `tsconfig`, `eslintrc`, `.env`, `project.json` | HEUR `lines_added * 0.01` |
| Tests | `.test.ts`, `.spec.ts`, `__tests__/` | HEUR `lines_added * 0.002` |
| DDL migration | `CREATE/ALTER/DROP` without data transforms | HEUR `0.1h per DDL operation` |
| Data migration | Migration with `SELECT/INSERT/UPDATE/DELETE` | LLM |
| Manual code | Everything else | LLM |

### Output structure

```python
FilterResult = {
    "skip_files": list,        # 0h, excluded from diff
    "heuristic_files": list,   # estimated without LLM
    "heuristic_total": float,  # sum of heuristic estimates
    "llm_files": list,         # sent to Branch A or B
    "llm_diff": str,           # assembled diff of LLM files only
    "llm_token_estimate": int, # approximate token count
}
```

### Implementation

Extends existing `classify_file_regex()`. Adds:
- DDL vs data migration split (presence of `SELECT/INSERT/UPDATE/DELETE` in body)
- Locale detection by directory path
- Filter mode selection by `len(file_info)`

Heuristic total is added AFTER combining branch + holistic estimates — it does not participate in averaging.

### Edge case: zero LLM files

If adaptive filter classifies ALL files as SKIP or HEURISTIC (e.g., commit of 100 generated protobuf files + configs), skip Steps 3-5:

```python
if not filter_result["llm_files"]:
    return {
        'estimated_hours': filter_result["heuristic_total"],
        'method': 'FD_v2_heuristic_only',
        ...
    }
```

## Step 3: Branch B — Cluster-based Estimation

For current model (Qwen3-coder-30b, 32K context). Default branch.

### Clustering algorithm (directory + suffix)

```python
def build_clusters(llm_files):
    # 1. Group by directory depth-1 within package
    #    src/components/Button.tsx     → "components"
    #    src/lib/services/auth.ts      → "lib/services"
    #    apps/web/pages/index.tsx      → "apps/web/pages"

    # 2. Within each dir-group: split by suffix role
    #    *.service.ts     → subcluster "services"
    #    *.repository.ts  → subcluster "repositories"
    #    *.controller.ts  → subcluster "controllers"
    #    Others remain in general subcluster

    # 3. Small clusters (<3 files) merge with nearest
    #    neighbor by directory path
    #    Stop merging when merge would exceed 30 files per cluster

    # 4. If > 15 clusters: force-merge smallest until count <= 15
    #    If < 5 clusters: proceed as-is (fewer LLM calls is fine)

    # Cluster name = f"{dir_key}" or f"{dir_key}/{suffix_key}"
    # Target: 5-15 clusters of 3-30 files each
    return clusters
```

Research basis: Anquetil & Lethbridge (1999) ~90% precision from file names alone. ClassLAR (2024): fully-qualified names sufficient for architecture recovery, 3.99x faster than dependency-based approaches. TypeScript/React monorepos have 90%+ alignment between directory structure and logical modules.

### Per-cluster LLM call

One call per cluster. Prompt includes:
- Commit message (full commit context)
- File list with stats (name, +lines, -lines)
- File diffs (if cluster diff < 20K tokens, i.e. ~40K chars at `_CHARS_PER_TOKEN=2.0`)
- If cluster diffs exceed 20K tokens: top-3 files by lines_added + metadata for rest

```
System: "Estimate development effort for this CODE CLUSTER
(part of a larger commit with {total_files} files).
Cluster: {cluster_name} ({n_files} files, {total_lines} lines).
Estimate hours for THIS CLUSTER ONLY."

Schema: { estimated_hours: number, reasoning: string }
```

### Branch B output

```python
branch_estimate = sum(cluster.estimated_hours for cluster in clusters)
# No discount applied — holistic check replaces it
```

LLM calls: 5-15 (vs 200+ per-file in v1). 15-40x reduction.

## Step 3: Branch A — Single-call Estimation

For powerful LLM with large context (Gemini 2.5 Pro, Claude Sonnet 4, etc.).

### Entry condition

```python
branch_a_enabled = os.environ.get("FD_V2_BRANCH") == "A"
# Use existing _CHARS_PER_TOKEN = 2.0 (code tokenizes denser than prose)
_PROMPT_OVERHEAD_TOKENS = 2000  # system prompt + user prompt metadata + schema
llm_token_estimate = len(filter_result["llm_diff"]) / 2.0 + _PROMPT_OVERHEAD_TOKENS
can_fit = llm_token_estimate <= 30_000  # optimal zone, no context rot

if branch_a_enabled and can_fit:
    → Branch A
else:
    → Branch B (fallback)
```

30K token threshold based on research: Chroma (July 2025) found accuracy degrades continuously with context length. Qwen2.5-7B showed catastrophic threshold at 40-50% of max context. Practical recommendation: keep prompts under 30K tokens for high-reliability tasks.

### Prompt

```
System: "You are a senior software engineer estimating development
effort for a commit. You see the FULL diff of all substantive files
(trivial files like configs, docs, generated code are pre-filtered
and estimated separately).

Estimate total hours for a mid-level developer WITHOUT AI assistance.
Include: writing code, manual testing, code review fixes.
Exclude: meetings, planning, waiting for review."

User:
"Commit: {message}
Repository: {repo_name}
Language: {language}
Total files in commit: {total_fc} (showing {llm_fc} substantive files)
Pre-filtered: {skip_count} auto-generated (0h), {heur_count} trivial ({heur_total:.1f}h)

--- FULL DIFF OF SUBSTANTIVE FILES ---
{llm_diff}
---

Estimate development effort for the substantive code above."

Schema: { estimated_hours: number, reasoning: string }
```

### Model configuration

```
FD_LARGE_LLM_PROVIDER=openrouter
FD_LARGE_LLM_MODEL=anthropic/claude-sonnet-4
```

Model selection based on surrogate holistic test — see [Model Comparison Results](#model-comparison-results). Claude Sonnet 4 is the recommended model for Branch A: best MAPE (60%), 2/3 commits in GT range, ~$0.065/call. Claude Opus 4 adds no accuracy benefit at 5x cost. Non-Claude models (Gemini, Qwen3) cannot distinguish commit types.

**Important**: Branch A is opt-in (`FD_V2_BRANCH=A`). Default execution path is Branch B, which uses the standard model (Qwen3-coder-30b via `OPENROUTER_MODEL`). Branch A with Sonnet requires both `FD_V2_BRANCH=A` and `FD_LARGE_LLM_MODEL` to be configured.

If `FD_LARGE_*` not set → Branch A unavailable, always falls back to B.

LLM calls: 1. Cheaper than Branch B (1 call at ~$0.065 vs 5-15 calls at $0.001-0.003 each on Qwen3).

## Step 4: Independent Holistic Estimate

Separate LLM call. Sees only metadata, does NOT see branch estimate. Prevents anchoring bias (research: LLMs shift toward anchor 88% of the time, anchoring index 0.39-0.46).

```
System: "Estimate total development effort for this commit
based on its structure and metadata. You do NOT see the full diff —
estimate from the commit profile only."

User:
"Commit: {message}
Language: {language}
Files changed: {total_fc}
Lines: +{la} / -{ld}
New files (add-only): {new_count} ({new_file_ratio:.0%})
Pre-filtered: {skip_count} auto-generated, {heur_count} trivial ({heur_total:.1f}h)

Substantive files by cluster:
  {cluster_name_1}: {n_files} files, {lines} lines — {top_3_filenames}
  {cluster_name_2}: {n_files} files, {lines} lines — {top_3_filenames}
  ...

Estimate hours for a mid-level developer without AI assistance."

Schema: { estimated_hours: number, reasoning: string }
```

**Model**: same as the branch that executed. Branch A (powerful) → holistic on powerful. Branch B (current) → holistic on current. Diversity of method (code vs metadata), not diversity of model.

**Clustering for holistic prompt**: always performed regardless of branch. Branch B already builds clusters; Branch A does not use clusters for estimation, but `build_clusters()` is always called (cheap, no LLM) to provide structured context for the holistic prompt. Top-3 filenames include `lines_added` counts for effort distribution insight.

## Step 5: Combine

```python
def combine_estimates(branch_est, holistic_est, heuristic_total):
    divergence = max(branch_est, holistic_est) / max(min(branch_est, holistic_est), 0.1)

    if divergence > 2.0:
        # Strong divergence — conservative
        combined = min(branch_est, holistic_est)
    else:
        # Normal divergence — average
        combined = (branch_est + holistic_est) / 2

    # Add heuristic files (filtered tests, configs, docs)
    final = combined + heuristic_total
    return final
```

Research basis: Armstrong (2001, Wharton) — combined forecasts reduce MAPE by 12-20%. Simple averaging outperforms optimized weights under uncertainty (Davis-Stober et al., 2014).

### Fallback on errors

- Holistic LLM fail → `final = branch_est + heuristic_total` (no averaging)
- Branch LLM fail → `final = estimate_fd_fallback() + heuristic_total` (existing heuristic + filtered file estimates)

### Future calibration

When GT data sufficient (10+ points), replace simple average with weighted:
```python
combined = branch_est * w_branch + holistic_est * w_holistic
# w_branch, w_holistic calibrated by MAPE on GT data
```

COCOMO calibration research: 10 points explain 88% of effort variance.

## Configuration

### New environment variables

```
FD_V2_BRANCH=B                    # A | B (default: B — uses standard model)
FD_LARGE_LLM_PROVIDER=openrouter  # Provider for Branch A (only used when BRANCH=A)
FD_LARGE_LLM_MODEL=anthropic/claude-sonnet-4  # Model for Branch A (recommended)
FD_V2_MIN_FILES=50                # Threshold for v2 activation (default: 50)
FD_V2_HOLISTIC=true               # Enable holistic check (default: true)
```

**Default path**: `FD_V2_BRANCH=B` → all LLM calls use the standard model (`OPENROUTER_MODEL`, typically Qwen3-coder-30b). No additional cost or configuration required. Branch A with Sonnet is opt-in for higher accuracy at ~$0.065/call.

### Backward compatibility

- Commits < `FD_V2_MIN_FILES` → existing v1 path, zero changes
- `FD_V2_MIN_FILES=999999` disables v2 entirely
- Hard cap 80h still applies as safety net
- Correction rules and complexity guard apply to v2 output, but may need recalibration — they were designed for v1's per-file aggregation pattern. Method names in output allow selective bypass if needed (e.g., skip `rule2_rename_heavy` for `FD_v2_*` methods).

### New method names in output

- `FD_v2_cluster_holistic` — Branch B + holistic combined (default)
- `FD_v2_cluster` — Branch B without holistic (`FD_V2_HOLISTIC=false`)
- `FD_v2_single_holistic` — Branch A + holistic combined
- `FD_v2_single_call` — Branch A without holistic
- `FD_v2_heuristic_only` — all files filtered, no LLM needed

### Modal integration

Modal worker imports same `file_decomposition.py`. New env vars must be added to `setup_llm_env()` in `worker.py` and included in `llmConfigSnapshot`:
- `FD_V2_BRANCH`, `FD_V2_MIN_FILES`, `FD_V2_HOLISTIC`
- `FD_LARGE_LLM_PROVIDER`, `FD_LARGE_LLM_MODEL`

Branch A uses OpenRouter routing for the powerful model (same API key, different model name). No additional Modal Secret required unless direct provider API access is needed.

## Model Comparison Results

Tested 2026-03-26. Holistic single-call estimation (file composition + top-15 code file diffs, one total estimate). Test script: `packages/server/scripts/pipeline/test_model_comparison.py`.

### Ground truth (confirmed by tech lead)

| SHA | Type | Files | GT (hours) |
|-----|------|------:|------------|
| `188c43e` | Scaffold (monorepo migration) | 870 | 15-30h |
| `1d02576` | Feature (dialer v1) | 272 | 40-60h |
| `16dc74e` | Tooling (pnpm/vitest migration) | 1,036 | 8-16h |

### Results by model

| Tier | Model | $/M in | $/M out | Scaffold | Feature | Tooling | MAPE | In GT | Total/3 calls | Avg/call |
|------|-------|-------:|--------:|---------:|--------:|--------:|-----:|------:|--------------:|---------:|
| baseline | qwen3-coder-30b | $0.07 | $0.27 | 160h | 160h | 160h | 688% | 0/3 | $0.005 | $0.002 |
| budget | gemini-2.5-flash | $0.30 | $2.50 | 120h | 120h | 120h | 491% | 0/3 | $0.022 | $0.007 |
| mid | gemini-2.5-pro | $1.25 | $10.00 | 60h | 320h | 60h | 369% | 0/3 | $0.122 | $0.041 |
| **premium** | **claude-sonnet-4** | **$3.00** | **$15.00** | **24h** | **120h** | **16h** | **60%** | **2/3** | **$0.196** | **$0.065** |
| ultra | claude-opus-4 | $15.00 | $75.00 | 40h | 120h | 16h | 84% | 1/3 | $0.973 |

### Key findings

1. **Claude Sonnet 4 is the clear winner** — MAPE 60%, the only model placing 2/3 commits within GT range
   - Scaffold 24h (GT 15-30h): correctly identifies monorepo copy, minimal-effort estimate
   - Tooling 16h (GT 8-16h): correctly identifies migration as mechanical work
   - Feature 120h (GT 40-60h): 2.4x overestimate — sees 252 code files, overestimates due to invisible shared context

2. **Claude Opus 4 adds no value over Sonnet** — same feature estimate (120h), worse scaffold (40h vs 24h), 5x more expensive

3. **Non-Claude models cannot distinguish commit types** — Qwen3-coder returns 160h for all 3 commits. Gemini Flash returns 120h for all 3. Gemini Pro is unstable (320h for feature). These models lack the reasoning depth for nuanced estimation.

4. **Feature overestimation is the remaining gap** — even the best holistic single-call estimate (120h) is 2.4x over GT. This is expected: the model sees file list + top diffs but cannot perceive shared architectural context between files. This is exactly the problem cluster-based estimation (Branch B) + holistic averaging is designed to solve.

### Implications for FD v2

- **Branch A model**: Claude Sonnet 4 (`anthropic/claude-sonnet-4`). Best accuracy, reasonable cost ($0.07/call for 16K prompt tokens).
- **Branch A alone is insufficient for feature commits**: holistic + branch averaging will bring 120h closer to GT. Cluster-based prompts (Branch B) may perform better on feature commits since per-cluster estimates account for shared context within each cluster.
- **Holistic sanity check model**: same as branch model (Claude Sonnet 4). The model already demonstrates strong commit-type awareness in reasoning text.
- **Qwen3-coder remains for current pipeline** (small commits <50 files) — performs well at that scale for $0.001/call.
- **No model achieves MAPE < 50% standalone**. The FD v2 dual-branch + holistic averaging architecture is necessary to reach the target.

## Validation Plan

### Phase 1: Unit tests (mock LLM)

- Adaptive filter classifies files correctly by tier
- Clustering produces 5-15 clusters on real file lists
- Combine logic: averaging, conservative min at >2x divergence
- Filter mode switches by commit size
- Scaffold detector still works (regression)

### Phase 2: Routing smoke test (mock LLM, real commits from artisan-private)

Extend `test_fd_regression.py`:
- 2 scaffold commits → scaffold detector fires (unchanged)
- 4 feature commits (50+ files) → enter v2, cluster correctly, LLM called per-cluster not per-file
- Branch B: verify LLM call count reduced from 200+ to 5-15 (clusters) + 1 (holistic)
- Branch A: verify LLM call count = 1 (single-call) + 1 (holistic) = 2
- Edge case: commit with all generated files → heuristic_only, 0 LLM calls

### Phase 3: Real LLM validation (OpenRouter, real commits)

Ground truth confirmed by tech lead. Validated on 3 commits (see [Model Comparison Results](#model-comparison-results)).

Remaining validation:
- Run Branch B (cluster-based) on same 3 commits + 7 more from GT set
- Run Branch A + holistic + combine pipeline end-to-end
- Compare combined estimates with GT
- Calculate MAPE for each branch and combined

### Success criteria

```
MAPE < 50% on GT sample (combined estimate, not single-branch)

MAPE = mean(|estimated - actual| / actual) * 100%
```

Current pipeline MAPE on top-11: ~300-500%. Holistic single-call MAPE: 60% (Sonnet). Target for combined: < 50%.

MAPE is computed only on v2-eligible commits (50+ files), not the full order. For small GT values (<5h), absolute error is a better metric than percentage.

If not achieved:
- MAPE 50-100%: add weighted average calibrated on GT
- MAPE > 100%: revisit cluster prompts, check adaptive filter thresholds

### LLM cache

Cluster-level and holistic LLM calls use the existing `_read_llm_cache`/`_write_llm_cache` mechanism in `run_v16_pipeline.py`. Cache key includes the full prompt text, so cluster prompts and holistic prompts are cached independently. This is important for cost control during iterative testing.

## Research References

- **Context rot**: Chroma (July 2025) — accuracy degrades continuously with context length across all 18 tested models
- **Clustering**: Anquetil & Lethbridge (1999) ~90% precision from file names; ClassLAR (2024) 3.99x faster than dependency-based
- **Aggregation**: Armstrong (2001) — combined forecasts reduce MAPE 12-20%; Davis-Stober (2014) — equal weights outperform optimized
- **Anchoring**: Emily Ma study — LLMs shift toward anchor 88% of the time
- **Decomposition**: Connolly & Dean (1997) — decomposition does not improve calibration; hybrid decompose+holistic is best
- **Estimation**: COCOMO calibration — 10 data points explain 88% variance
- **Effort estimation for code**: REARRANGE (Monash 2024) — cluster-level MAE 5.47h vs 453h file-level
- **AI code review**: CodeRabbit — per-file analysis with cross-file context; Datadog BewAIre — recursive chunk splitting
- **No tool does whole-PR holistic analysis** for large PRs — all decompose (industry consensus)
- **Model comparison (our data, 2026-03-26)**: 5 models, 3 GT commits. Claude Sonnet 4 MAPE 60% (~$0.065/call). Non-Claude models 370-690% MAPE. Test script: `test_model_comparison.py`
