# Research Request: Holistic Code Effort Estimation via Metadata + LLM

## Context

We build DevGhost — a platform that estimates developer effort (hours) per git commit using LLM analysis. Our pipeline analyzes diffs and produces effort estimates used to calculate productivity metrics (Ghost%).

**Current approach for large commits (50+ files):** We tried sending actual code diffs to LLM — either the full diff (Branch A) or per-cluster chunks (Branch B). Both approaches failed in validation:

- **Branch A (full filtered diff → single LLM call):** Even after filtering out generated/trivial files, large commits produce 130K-1M tokens of diff. No model can handle this.
- **Branch B (cluster diffs → per-cluster LLM calls):** Each cluster is estimated in isolation. The LLM treats each cluster as a standalone task, losing the context of the whole commit. Sum of cluster estimates is 3-10x the actual effort.

**What worked surprisingly well:** A "holistic" approach where we send only **metadata** (no code) — commit message, file structure, line counts, cluster layout — to a powerful LLM (Claude Sonnet). Results on 5 ground truth commits:

| Commit | Holistic Estimate | Ground Truth | Accuracy |
|--------|------------------|--------------|----------|
| Dialer v1 (272 files, real feature) | 85.0h | 40-60h | 1.4-2.1x |
| Vitest migration (1036 files, tooling) | 8.5h | 8-16h | **In range** |
| Web visitors (159 files, feature) | 45.2h | 25-40h | 1.1-1.8x |
| Temporal scheduler (123 files, feature) | 28.5h | 20-35h | **In range** |
| Chat with Ava (105 files, feature) | 28.5h | 15-25h | 1.1-1.9x |

2 out of 5 within expert range. All 5 within 2x. This was with a **minimal** metadata prompt — just commit message, file counts, line counts, and cluster names. No file-level detail, no code patterns, no domain signals.

**Hypothesis:** With a richer metadata feature set — heuristic-derived code signals, structural patterns, historical context — a powerful LLM can estimate effort from metadata alone, without reading the actual diff.

## What We Need Researched

### 1. Optimal Feature Set for Metadata-Only Estimation

What metadata signals are most predictive of development effort? We need a prioritized feature set. Our current pipeline already computes many signals (listed below) — the question is which combination maximizes estimation accuracy.

**Features we already have (zero additional cost to compute):**

Git-level:
- Commit message, author, date, merge commit flag
- Lines added/deleted, files changed count
- Complexity score (function defs x2 + control flow + deep nesting)

File-level classifications (regex-based, per file):
- Tags: `test`, `generated`, `config`, `docs`, `locale`, `test_data`
- Heuristic tags: `imported_data`, `likely_move`, `formatting_only`, `large_data_file`, `svg_icon_component`
- Per-file: filename, lines added, lines deleted, extension
- Aggregate: new_file_ratio (% add-only files), tag distribution

Pattern detection:
- Move/rename detection (SIMPLE_MOVE, MODULE_EXTRACT, ARCHITECTURAL_EXTRACT)
- Bulk refactoring detection (pattern repetition %, top edit patterns)
- Scaffold/boilerplate signals (keyword matching)

**Features we could compute cheaply:**

- AST-derived metrics: function count, class count, import count per file (tree-sitter, no LLM)
- Cyclomatic complexity per file (from AST)
- "Real code ratio" — lines of actual logic vs boilerplate/imports/type definitions
- Directory depth / module boundary crossings
- File similarity matrix (Jaccard on tokens) — detect copy-paste between files
- Historical: average effort for similar commits in the same repo (if we have prior analyses)

**Features that require LLM (expensive):**

- Classification: change_type, new_logic_percent, architectural_scope, cognitive_complexity
- Summary / intent extraction
- "What would a developer need to understand to implement this?"

### 2. Prompt Architecture for Holistic Estimation

How should the metadata be structured in the prompt for best results? Specific questions:

- **Flat vs hierarchical:** One big prompt with all features, or structured sections (git context → file breakdown → pattern analysis → estimate)?
- **Few-shot examples:** Does including 3-5 calibrated examples (commit metadata → known effort) improve accuracy? What's the optimal format?
- **Chain-of-thought:** Should the LLM reason through categories (new code, tests, config, refactoring) before producing a number?
- **Confidence calibration:** Can the LLM reliably express uncertainty? (e.g., "15-25h with high confidence" vs "30-80h with low confidence")
- **Anti-overestimation prompting:** LLMs consistently overestimate effort. What prompt techniques counteract this bias?

### 3. Ensemble / Cross-Validation Strategies

- Does running the same metadata through 2-3 different models and averaging improve accuracy?
- Is "estimate high / estimate low / reconcile" more effective than a single prompt?
- What's the value of a separate "sanity check" call that receives the estimate and metadata and flags implausible results?

### 4. Calibration and Adaptation

- How to calibrate the model per-repository? (Different codebases have different effort profiles)
- Can we use a feedback loop where completed estimates + actual effort (from time tracking) refine future estimates?
- Is there research on LLM self-calibration for numeric estimation tasks?

### 5. Baseline Comparisons

- How does metadata-only LLM estimation compare to:
  - Pure heuristic models (COCOMO-style, lines-of-code based)?
  - Diff-reading LLM estimation (our current v1)?
  - Human expert estimation (known to have 30-50% error rate)?
- What MAPE is realistic for this class of problem? Our target is <50%.

## Constraints

- **Cost:** Each commit estimate should cost <$0.05 in LLM calls (currently ~$0.02 for classification + estimation on small commits). Metadata-only approach is inherently cheap.
- **Latency:** <30s per commit. Metadata approach is fast — no large context, no streaming issues.
- **Models available:** Anthropic Claude (Sonnet 4, Opus 4), OpenAI GPT-4.1, Google Gemini 2.5 — via OpenRouter.
- **No training/fine-tuning:** We cannot fine-tune models. Prompt engineering only.
- **Scale:** Production pipeline processes 100-1000 commits per order. Must be parallelizable.

## What's Unique About Our Problem

1. **Squash-merged PRs, not atomic commits.** Each "commit" is really a PR with 5-1000+ files. This makes traditional LOC-based estimation unreliable — a 500-file commit might be a monorepo migration (8h) or a real feature (60h).

2. **"No AI" estimation.** We estimate how long a mid-level developer would take WITHOUT AI copilots. This is the baseline for our Ghost% metric.

3. **Wide effort range.** Commits span 0.1h (typo fix) to 80h (major feature). The same model must handle both.

4. **Generated code is common.** Lock files, protobuf output, migrations, snapshots — often 30-70% of a large commit's diff is machine-generated.

## Deliverable Expected

A research document covering:
1. Recommended feature set (prioritized, with justification)
2. Prompt template or architecture (with examples)
3. Evaluation methodology (how to measure improvement)
4. Risk analysis (where this approach will fail, mitigation strategies)
5. References to relevant research (LLM-as-judge, numeric estimation, software effort estimation literature)

## Ground Truth Data Available

We have 10 expert-estimated commits (shown in `docs/ground-truth-request.md`) spanning:
- Monorepo migrations, feature implementations, tooling migrations
- 105 to 1036 files per commit
- 8h to 60h effort range
- TypeScript/NestJS/React codebase

These can be used as the validation set for any proposed approach.
