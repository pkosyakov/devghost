# Perplexity Deep Research Prompt

---

You are a senior software engineering researcher specializing in automated software effort estimation, LLM-based code analysis, and developer productivity metrics. You have deep expertise in COCOMO/COCOMO II, function point analysis, story point calibration, and modern ML-based estimation approaches.

## Research Task

I need a comprehensive research report on **holistic (metadata-only) approaches to estimating developer effort for large code commits using LLMs** — without sending the actual source code diff to the model.

## Background

We have a production system that estimates how many hours a mid-level developer (without AI assistance) would need to implement each git commit. For small commits (<50 files), we send the full diff to an LLM and get accurate estimates. For large commits (50-1000+ files), the diff doesn't fit in context.

We tried two diff-based approaches for large commits and both failed:
- **Chunking the diff into clusters** and estimating each cluster separately — the LLM overestimates each chunk by 3-10x because it lacks whole-commit context
- **Sending the full filtered diff** in a single call — even after removing generated files, the diff exceeds 100K+ tokens

However, we discovered that sending **only metadata** (commit message, file counts, directory structure, line statistics) to Claude Sonnet produced surprisingly accurate estimates — 2 out of 5 ground truth commits were estimated within expert range, all 5 within 2x error.

## What I Need You to Research

### 1. Academic and Industry Foundations

- What does the software estimation literature say about metadata-only vs code-inspection approaches? Specifically:
  - COCOMO II and its calibration parameters — which input factors are most predictive?
  - Function Point Analysis — can file-level structural metrics serve as proxy function points?
  - The Cone of Uncertainty — where does "commit analysis" fall on this cone vs requirements-stage estimation?
  - Studies comparing expert estimation accuracy (known ~30-50% MAPE) with automated approaches
  - Any research on using LLMs specifically for software effort estimation (post-2023)

### 2. Optimal Metadata Feature Set

What non-code signals are most predictive of development effort? Research the predictive power of:

**Structural metrics (no code reading required):**
- Lines added/deleted, files changed
- New file ratio (% of files that are purely new vs modifications)
- File extension distribution (how many .ts, .py, .test.ts, .json, etc.)
- Directory depth and module boundary crossings
- File size distribution (median, p90, max lines per file)

**Pattern-based signals (regex/heuristic, no LLM):**
- Generated code detection (lock files, .d.ts, protobuf, snapshots, migrations)
- Move/rename detection (high add/delete ratio with similar content)
- Bulk refactoring patterns (same edit repeated across many files)
- Test file ratio and test line ratio
- Configuration vs logic file ratio

**Derived complexity metrics (AST-based, no LLM):**
- Function/class/method count per file
- Import graph complexity (fan-in, fan-out)
- Cyclomatic complexity (from tree-sitter AST)
- Nesting depth distribution

**Semantic signals (requires cheap LLM call):**
- Commit message intent classification (feature, bugfix, refactor, migration, tooling)
- Architectural scope (single module, cross-module, system-wide)
- Novelty estimate (new logic vs boilerplate vs copied code)

### 3. LLM Prompt Engineering for Numeric Estimation

- What research exists on LLMs producing **calibrated numeric estimates** (not classification)?
- Is chain-of-thought prompting beneficial for numeric estimation tasks? Studies or benchmarks?
- How to counteract systematic overestimation bias in LLMs for effort tasks?
- Does providing few-shot examples with known effort values improve calibration? How many examples, what format?
- Are there techniques for eliciting **confidence intervals** from LLMs (e.g., "15-25h, medium confidence") and are they reliable?
- "LLM-as-judge" literature — can a second LLM call verify/adjust the estimate?

### 4. Ensemble and Multi-Signal Approaches

- Research on combining heuristic estimates with LLM estimates (weighted averaging, meta-learning)
- Does querying multiple models and aggregating improve MAPE? (Wisdom of crowds for LLMs)
- Bayesian approaches: using code metrics as priors and LLM as likelihood update
- Feedback loop architectures: using historical estimation accuracy to improve future estimates

### 5. Known Failure Modes and Mitigations

Where will metadata-only estimation fail?
- Commits where complexity is hidden in small diffs (subtle algorithm changes)
- Commits where volume doesn't correlate with effort (vendor imports, auto-generated code)
- Domain-specific effort multipliers (security-critical code, performance optimization)
- How to detect and flag "low confidence" estimates for human review?

### 6. Practical Implementation Patterns

- Any open-source tools or papers implementing LLM-based effort estimation?
- Recommended evaluation methodology for effort estimation systems (MAPE, MdAPE, percentage within range, Pred(25) metric)
- Per-repository calibration strategies (how to adapt to different codebases without fine-tuning)

## Constraints

- We use LLMs via API (Claude, GPT-4, Gemini) — no fine-tuning, prompt engineering only
- Cost target: <$0.05 per commit estimate
- Latency target: <30 seconds per commit
- Our commits are squash-merged PRs (1 commit = 1 entire PR, often 50-500 files)
- We estimate effort for a "mid-level developer without AI copilots" — this is our specific baseline

## Deliverable

A structured report with:
1. **Literature review** — most relevant papers and industry references with key findings
2. **Recommended feature set** — prioritized list of metadata features ranked by predictive power, with justification from literature
3. **Prompt architecture recommendation** — how to structure the LLM prompt for best calibration
4. **Evaluation framework** — how to measure if the approach works (metrics, sample sizes, statistical significance)
5. **Risk matrix** — known failure modes with detection strategies and mitigations
6. **Implementation roadmap** — phased approach from MVP to production-grade

Focus on **actionable recommendations backed by evidence**, not general overviews. Cite specific papers, tools, or benchmarks where possible.
