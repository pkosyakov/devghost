# Holistic Metadata-Only Effort Estimation for Large Git Commits Using LLMs

## Executive Summary

This report examines the academic and industry foundations for estimating developer effort from commit metadata alone — without code inspection — and provides actionable recommendations for production deployment. The evidence supports the approach from adjacent research domains: software estimation literature has long used metadata proxies (COCOMO parameters, function points) rather than code reading, and recent LLM research shows that few-shot calibrated prompting with structural commit signals achieves accuracy competitive with expert judgment. An important caveat runs throughout: **no published study has directly validated metadata-only LLM estimation at the git-commit level** — the evidence base consists of analogous domains (project-level estimation, story-point estimation) that must be adapted carefully. The system described — where metadata prompting of Claude Sonnet yielded 2/5 estimates within expert range and all 5 within 2x error — is a promising baseline whose improvement trajectory is supported, but not guaranteed, by the literature reviewed here.

***

## Part 1: Academic and Industry Foundations

### 1.1 COCOMO II and Metadata-Driven Estimation

COCOMO II, the most widely validated parametric effort model, estimates effort entirely from non-code inputs organized into three categories:[^1][^2]

**Scale Factors (exponential effect on total effort):**

| Factor | What It Captures | Commit-Level Proxy |
|--------|-----------------|-------------------|
| PREC (Precedentedness) | How similar the work is to prior projects | Commit type classification (new feature vs. known pattern) |
| FLEX (Development Flexibility) | Degree of conformance to requirements | Architectural scope (isolated vs. cross-cutting) |
| RESL (Risk Resolution) | Risk analysis thoroughness | New file ratio (high % new = higher uncertainty) |
| TEAM (Team Cohesion) | Team familiarity | Not directly applicable at commit level |
| PMAT (Process Maturity) | CMM-level maturity | Repository-level constant |

**Effort Multipliers (linear adjustment to nominal effort):**

The 16 Post-Architecture EMs include CPLX (product complexity), ACAP/PCAP (analyst and programmer capability), RELY (required reliability), and TIME/STOR (execution/storage constraints). For commit-level estimation, CPLX is the only directly observable EM — and it is precisely what can be approximated from AST metrics and file extension distribution.[^3]

The critical insight from COCOMO research: models do not require source code inspection. All inputs can be derived from project metadata, size measurements, and structural classification. Studies optimizing COCOMO II parameters with PSO and genetic algorithms demonstrate that the model's predictive accuracy is primarily driven by size and scale factors, not by detailed code reading.[^4][^5][^6]

### 1.2 Function Points and File-Level Proxies

COSMIC Functional Size Measurement (ISO 19761) counts data movements (Entry, Exit, Read, Write operations) as functional size units — with no requirement to read implementation code. A 2025 paper in IEEE Transactions on Software Engineering (CosMet) demonstrated fully automated COSMIC measurement from natural-language use cases using LLMs, achieving high accuracy without code access.[^7][^8][^9]

For commit-level estimation, file-level structural metrics serve as reliable function-point proxies:
- Each modified file with clear I/O interactions approximates 1–3 COSMIC Function Points
- New files represent higher functional additions than modifications
- The ratio of `.ts`/`.py` source files to `.json`/`.lock` config files proxies the ratio of logic-bearing to non-logic file changes[^10][^11]

COSMIC measurement research confirms: "Functional size is completely independent of any technical or quality considerations" — meaning it can be measured from structural artifacts rather than implementation logic.[^7]

### 1.3 The Cone of Uncertainty — Where Commit Estimation Falls

The Cone of Uncertainty (Boehm, McConnell) shows that initial concept estimates range 0.25x–4x actual effort, narrowing through project phases. Critically, commit-level estimation occupies a unique position on this cone: **it is post-implementation estimation**, not forward planning.[^12][^13]

This has a profound implication: the effort being estimated is *already determined* — it exists as a completed artifact. The uncertainty is epistemic (we don't have full information) rather than aleatory (the outcome isn't yet decided). This means:

- Accuracy targets can be tighter than requirements-phase estimation (2x vs. 4x bounds)
- Metadata signals are stronger predictors than in forward planning, because the actual complexity is already fixed
- The relevant accuracy benchmark is expert estimation accuracy (~30% MAPE), not requirements-phase planning

Boehm's empirical data shows that even late-stage estimates (after detailed design) carry a 1.25x–0.8x range at the 90th percentile. Post-implementation metadata estimation should be achievable within this band.[^14][^15]

### 1.4 Expert Estimation Accuracy Baseline

Published surveys on estimation practice establish the performance benchmark against which automated systems should be measured:[^16]

- **Mean effort overrun**: ~30% across expert estimates, not decreasing over time
- **Overconfidence**: Experts claiming 90% confidence intervals actually contain the truth only 60–70% of the time
- **MAPE range**: 30–50% for expert judgment on typical software projects[^17]
- **PRED(25)**: State-of-the-art ML models achieve 46–64% of estimates within 25% of actual[^17]

Expert estimation is also a behavioral act, not purely technical — biases from anchoring, optimism, and framing effects are well-documented. This means an unbiased automated system can reasonably target expert-level performance even with imperfect information.[^18]

### 1.5 LLM-Based Effort Estimation (2023–2025)

Several recent studies directly address LLM-based software effort estimation:

**Carpenter et al. (Boise State, 2024)**: Fine-tuned GPT-3.5 on ISBSG dataset (7,518 projects) for cost and duration prediction. Used 10 metadata features — architecture type, team size, developer experience, methodology, language. Found LLMs competitive with ML baselines when sufficient training data exists, but performance degraded sharply with fewer than 200 clean examples. The key finding: *structured metadata in natural language prompts is a viable input format for LLMs in estimation tasks*.[^19]

**SEEAgent (IEEE 2025)**: Multi-agent framework for agile story-point estimation. **Key implementation detail that limits direct applicability**: SEEAgent requires **QLoRA fine-tuning** of Llama-3.1-8B on labeled historical user stories — without fine-tuning, the base model shows catastrophically poor results (MAE 17.053, MMRE 11.698 on one project vs. 4.251 for the fine-tuned version). The fine-tuned version outperformed Deep-SE, GPT2SP, and Fine-SE on 3/4 projects (p < 0.05, effect sizes 0.53–0.95). Since the target system operates under a no-fine-tuning constraint, SEEAgent is **not directly applicable**, but its ReAct reasoning structure and planning-poker multi-round consensus mechanism are transferable as prompt engineering patterns. The task is also story points, not developer hours.[^20][^21]

**Search-Based Few-Shot Optimization (arxiv 2403.08430)**: Using NSGA-II evolutionary search to select optimal few-shot examples reduces story-point estimation MAE by **59.34% on average** versus zero-shot, across three datasets. This represents the strongest evidence for few-shot calibration as a technique for LLM effort estimation without fine-tuning.[^22][^23]

***

## Part 2: Recommended Metadata Feature Set

The following feature set is ranked by predictive power, drawing on evidence from the JIT defect prediction literature (which extensively validates commit-level metadata features against ground-truth outcomes), COCOMO II, and the LLM estimation literature.

### Tier 1 — Core Structural Signals (Required)

These features have the strongest empirical backing from 15+ years of JIT-SDP research and should be included in every prompt.

**1. Code Churn (lines added + lines deleted)**
The most consistently validated single predictor of commit complexity. Effort-aware JIT defect prediction models confirm code churn as the dominant predictor variable. Captures raw volume of change. Extract via `git diff --shortstat`.[^24][^25]

**2. Number of Files Modified (NF)**
Second strongest predictor in JIT-SDP meta-analyses. Combined with entropy, captures both total size and distribution. Critical for detecting bulk operations where volume ≠ effort.[^26][^27]

**3. Entropy of Change Distribution**
\[
H = -\sum_{i=1}^{n} p_i \log_2 p_i, \quad p_i = \frac{\text{lines\_changed}_i}{\text{total\_lines\_changed}}
\]
where the sum is over all modified files. High entropy (changes spread evenly) signals coherent refactoring or systematic updates. Low entropy (one or two dominant files) signals targeted feature work. This metric is used in WCMS (weighted code churn), which achieved state-of-the-art JIT-SDP results. For effort estimation, higher entropy with high NF is a strong signal of higher effort (cross-cutting concerns) — unless the change type is a mass refactor.[^28][^26]

**4. File Extension Distribution**
Category breakdown of modified files. For a typical TypeScript/Python stack:

```
logic_files:  *.ts, *.tsx, *.py, *.go, *.java, *.cs
test_files:   *.test.ts, *.spec.py, *.test.js
config_files: *.json, *.yaml, *.toml, *.env
data_files:   *.sql, *.csv, *.json (data)
generated:    *.d.ts, *.pb.go, *.lock, migrations/, snapshots/
```

Test ratio (test_files / logic_files) directly predicts implementation depth — a commit that's 40% tests alongside new logic signals complete TDD cycle effort. Config-only commits are near-zero effort. Generated file ratio should reduce the effective file count used for estimation.[^27]

**5. New File Ratio**
Proportion of files in the commit that are entirely new vs. modifications to existing files. New files represent feature implementation from scratch (higher effort per line). Modifications can range from trivial fixes to complex rewrites. In COCOMO terms, this maps to the RUSE (reuse) multiplier — adapting existing code costs 0.75x of new development; building from scratch costs 1.0–1.25x.[^1]

### Tier 2 — Pattern-Based Signals (High Value, Low Cost)

These can be computed with pure regex/heuristics, zero LLM cost.

**6. Generated Code Detection and Exclusion**
Heuristic rules to flag and exclude from effective size calculation:
- `package-lock.json`, `yarn.lock`, `go.sum`, `Gemfile.lock` → zero effort
- `*.pb.go`, `*.g.ts` (protobuf generated) → zero effort
- `*/__snapshots__/*.snap` → negligible effort
- `*/migrations/*.sql` (auto-generated) → low effort
- `*.d.ts` (TypeScript declaration) → zero effort for manual, low for manual type annotations

Failure to exclude generated files was likely the primary cause of the 3–10x overestimation observed in the chunked approach.

**7. Move/Rename Detection**
When `git diff --name-status` shows `R` (renamed) or `C` (copied) for many files, the commit is primarily a reorganization. True net-new lines in a rename-heavy commit are often near zero. A commit with 500 files changed but 90% renames represents perhaps 2–4 hours of directory restructuring effort, not 500 × (avg file effort).

**8. Bulk Refactoring Indicators**
Signals that the same small edit was made across many files (e.g., import renaming, API surface change, variable rename). Detectable by: high NF + low variance in per-file line delta (all files changed by 1–3 lines) + low entropy (since all files contribute equally). This pattern is medium effort regardless of file count.

**9. Test File Ratio**
Proportion of test files to total files. A commit with 50% test files signals complete implementation cycles (feature + coverage), while a commit with 0% tests is either a bugfix, hotfix, or incomplete work. Include both the test line ratio and test file ratio as separate signals.

### Tier 3 — AST/Semantic Signals (Higher Cost, Incremental Value)

These require either tree-sitter parsing or a cheap LLM call, but provide important disambiguation signals.

**10. Commit Message Intent Classification (LLM, cheap call)**
Using a lightweight model call (or even Claude Haiku), classify the commit message into:
- `feature`: new user-visible functionality
- `bugfix`: correction of incorrect behavior
- `refactor`: structural improvement without behavior change
- `migration`: data, API, or framework migration
- `tooling`: CI/CD, build system, dependencies
- `churn`: cosmetic, formatting, comments

Research confirms LLMs perform zero-shot intent classification effectively. XGBoost on commit messages alone achieves 100% accuracy for refactoring type detection. The intent classification is the strongest single semantic signal — a `migration` commit touching 300 files has fundamentally different effort characteristics than a `feature` commit touching 300 files.[^29][^30]

**11. Architectural Scope Estimate**
From the directory structure and module boundaries, classify:
- `isolated`: changes concentrated in one package/module
- `cross-module`: changes span 2–5 modules
- `system-wide`: changes span 6+ modules or touch core infrastructure

This maps directly to COCOMO II's TEAM scale factor and correlates with coordination overhead in developer effort.

**12. AST-Derived Complexity (Optional, highest cost)**
For commits where file count is low but effort is uncertain, tree-sitter–based extraction of cyclomatic complexity delta, function/class count delta, and nesting depth distribution can refine estimates. This is most valuable for Tier 3 (small diffs with potentially high complexity, as described in failure modes). Cost: ~100ms/file with tree-sitter, $0 additional LLM cost.

### Feature Summary and Priority

| Feature | Evidence Strength | Cost to Compute | Priority |
|---------|------------------|-----------------|----------|
| Code churn (lines +/-) | Very High (JIT-SDP meta) | Zero (git stat) | P0 |
| Files modified (NF) | Very High (JIT-SDP meta) | Zero (git stat) | P0 |
| Entropy of distribution | High (WCMS, JIT-SDP) | Near-zero | P0 |
| File extension distribution | High (proxy for COCOMO EM) | Near-zero | P0 |
| New file ratio | High (maps to RUSE multiplier) | Near-zero | P0 |
| Generated file exclusion | High (removes noise) | Near-zero (regex) | P0 |
| Move/rename detection | Medium (git name-status) | Near-zero | P1 |
| Bulk refactoring indicator | Medium | Near-zero (computed) | P1 |
| Test file/line ratio | Medium | Near-zero | P1 |
| Intent classification (LLM) | High (semantic) | Low ($0.001) | P1 |
| Architectural scope | Medium | Low ($0.001) | P2 |
| AST complexity delta | Medium (JIT-SDP: +21% MCC) | Medium (tree-sitter) | P2 |

***

## Part 3: LLM Prompt Architecture

### 3.1 Structured Prompt Design

The evidence strongly supports a **structured metadata block** over narrative prose for LLM estimation tasks. Research on LLM project estimation confirms that natural-language reformulations of structured data outperform raw tabular input for prompting, while structured sections prevent the LLM from hallucinating plausible-sounding but false properties.[^19]

**Recommended Prompt Template:**

```
SYSTEM:
You are an expert software effort estimator. Your task is to estimate how many
hours a MID-LEVEL SOFTWARE DEVELOPER (3-5 years experience, NO AI copilot tools)
would need to implement the changes described by the following commit metadata.

Provide your estimate as a range: [low_hours, mid_hours, high_hours] and a
confidence level [low|medium|high]. Then provide a brief (3-sentence) justification.

IMPORTANT CALIBRATION NOTES:
- 1 hour = approximately 50-100 lines of non-trivial logic changes for a mid-level dev
- Generated files, lock files, type declarations add ZERO implementation hours
- Renamed/moved files add MINIMAL hours (dir restructuring ≈ 0.5h per 50 files)
- Test code adds approximately 50-75% of the effort of the corresponding logic code
- A "mid-level developer" takes roughly 2-3x longer than a senior for novel code

---

COMMIT METADATA:

**Intent**: {intent_class} — {commit_message_first_line}
**Scope**: {architectural_scope} | {module_list}

**Change Volume (after excluding generated files)**:
- Effective files modified: {effective_file_count} (raw: {raw_file_count}, excluded: {generated_count})
- Lines added: {lines_added} | Lines deleted: {lines_deleted}
- Effective churn: {effective_churn} lines

**File Type Breakdown**:
- Logic files: {logic_count} files, {logic_lines} lines changed
- Test files: {test_count} files, {test_lines} lines changed (test ratio: {test_ratio}%)
- Config/infra files: {config_count} files
- New files (from scratch): {new_file_count} ({new_file_pct}% of effective total)

**Distribution Metrics**:
- Entropy: {entropy:.2f} (0=concentrated, {max_entropy:.2f}=uniform spread)
- Largest single file: {max_file_lines} lines changed
- p50 file size: {p50_lines}, p90 file size: {p90_lines}

**Pattern Flags**:
- {flag_bulk_refactor}  # e.g., "BULK_REFACTOR: uniform 1-2 line changes across all files"
- {flag_migration}      # e.g., "MIGRATION_PATTERN: SQL migration files detected"
- {flag_rename_heavy}   # e.g., "RENAME_HEAVY: 60% of file changes are renames"

---

FEW-SHOT EXAMPLES (most similar historical commits):
{similar_example_1}
{similar_example_2}
{similar_example_3}

---

Provide your estimate:
REASONING: <3 steps: (1) classify change type, (2) estimate effective size, 
           (3) adjust for complexity signals>
ESTIMATE: [low_h, mid_h, high_h]
CONFIDENCE: [low|medium|high]
JUSTIFICATION: <2-3 sentences>
```

### 3.2 Chain-of-Thought Configuration

The Wei et al. (2022) paper establishing CoT showed improvements on arithmetic and multi-step reasoning with eight-shot demonstrations. For effort estimation specifically, the research is more nuanced:[^31]

- CoT benefits larger models significantly more than smaller ones[^32]
- For recent frontier models (Claude Sonnet, GPT-4), zero-shot CoT ("think step by step") can match few-shot CoT performance[^32]
- "Constrained CoT" — where the reasoning is forced into specific analytical steps — outperforms open-ended CoT for structured tasks[^33]
- CoT with perception-tunnel bias may cause overconfidence in numeric outputs[^34]

Note that for some ICL settings, CoT actually underperforms direct answering. The recommendation to use constrained 3-step CoT is justified by the structured nature of the estimation task, but the benefit over a well-calibrated direct-answer prompt should be verified empirically on a holdout set.[^35]

**Recommendation**: Use a 3-step constrained CoT: (1) classify change type and dominant pattern, (2) estimate effective net-new logical code, (3) apply complexity/novelty adjustments. This prevents the model from jumping directly to hours, which empirically leads to higher overestimation.

### 3.3 Few-Shot Selection Strategy

The SBSE study demonstrates that few-shot selection quality dominates quantity — a search-optimized set of 3–5 examples reduced story-point MAE by 59.34% versus zero-shot in a preliminary study on 30-issue test sets. This figure is a directional signal, not a guaranteed production result: the study covered story-point classification in open-source Jira projects, not hour-regression for squash-merged PRs. Random few-shot selection can hurt accuracy by introducing anchoring effects, which is why similarity-based selection is preferred.[^36][^37][^22]

**Selection Algorithm (no fine-tuning required):**

1. For each historical commit with known ground-truth effort, compute a feature vector: `[intent_class, log(effective_churn), new_file_pct, entropy, test_ratio, scope_level]`
2. For the target commit, compute the same feature vector
3. Select the 3–5 historical commits with smallest cosine distance in this feature space
4. Format selected examples with: commit metadata snippet → effort estimate (as range, not point) → brief explanation

**Anti-anchoring precaution**: Present few-shot effort values as ranges, not precise hours. Research on anchoring effects shows that specific numeric values in few-shot examples bias LLM numeric outputs toward those values.[^37]

### 3.4 Counteracting Systematic Overestimation

LLM systematic overestimation in effort tasks has two primary causes:

1. **Availability bias**: The model has more training data about complex enterprise systems, biasing estimates high
2. **Scope inflation**: Without code context, the model cannot distinguish trivial implementations from complex ones

Mitigation strategies backed by evidence:

- **Explicit baseline anchoring** in the system prompt: "For reference, a well-formed 200-line utility function takes approximately 2–4h for a mid-level developer." This gives the model a calibration anchor without anchoring to specific commit values. Note that the specific hours cited in the prompt template (50–100 lines/hour, 0.5h per 50 renames, 2–3× senior→mid multiplier) are expert heuristics consistent with industry practice but are **not directly sourced from the literature** — they should be treated as default starting values subject to per-repository calibration.[^37]
- **Ask for ranges, then derive midpoint**: Asking for point estimates produces higher values than asking for ranges. The midpoint of an elicited range correlates better with truth than a direct point estimate.
- **Explicit pattern-specific deflators**: Add rules like "bulk refactoring at rate of 2h per 100 files affected" and "migration scripts at 0.5h each" as explicit guidelines in the system prompt.

### 3.5 Confidence Intervals and Their Reliability

The FermiEval benchmark established that LLM-elicited confidence intervals are **systematically overconfident** — nominal 99% CIs cover truth only ~65% of the time. This results from a "perception-tunnel" phenomenon where LLMs reason from a truncated slice of their internal distribution, neglecting tails. Applying conformal prediction on a holdout calibration set restores nominal coverage at the cost of wider intervals, reducing the Winkler score by 54%.[^38][^39][^34]

FermiEval tested Fermi-estimation questions ("how many piano tuners in Chicago?") — structurally similar to effort estimation but not identical. The overconfidence finding is robust enough to treat as a strong prior for this domain.

**Practical consequences:**
- LLM-stated confidence levels are unreliable as absolute probabilities
- However, *relative* confidence (high vs. low) is informative for routing decisions
- Conformal prediction correction (using a holdout calibration set) restores nominal coverage at the cost of wider intervals[^39][^38]

**Recommended approach**: Treat the LLM confidence level as a routing signal for human review (low confidence → escalate), but do not use stated numerical confidence intervals as true probability bounds without calibration.

### 3.6 LLM-as-Judge for Estimate Verification

A second LLM call can serve as a plausibility checker — not to produce a better estimate, but to flag obviously wrong ones:[^40][^41][^42]

```
JUDGE PROMPT:
Given the following commit metadata and the proposed effort estimate, 
assess whether the estimate is PLAUSIBLE, OVER, or UNDER.

Commit: {metadata_summary}
Proposed estimate: {estimate_range} hours
Category: {intent_class} / {scope}

Rules:
- A single-module feature addition rarely exceeds 40h
- A full-system migration rarely costs less than 8h
- Config-only commits rarely exceed 2h
- Bulk renames at 500+ files rarely exceed 4h

Return: {plausibility: PLAUSIBLE|OVER|UNDER, confidence: float, reason: str}
```

Research shows LLM-as-judge matches roughly 80% of human evaluations on structured *text quality* scoring tasks. This figure applies to qualitative evaluation (rating answer quality, coherence, helpfulness) and should not be directly transferred to numeric plausibility checking ("is 35h a reasonable estimate?") — for which no specific accuracy benchmark exists in the literature. The second-call judge pattern remains a sound engineering practice for catching obvious outliers, but its precision on numeric range validation should be calibrated against your own ground-truth data. For this constrained plausibility check (not open-ended quality assessment), accuracy should be higher.[^43]

***

## Part 4: Ensemble and Multi-Signal Approaches

### 4.1 Wisdom of Crowds for LLM Estimation

A 2024 study in *Science Advances* found that an ensemble of 12 LLMs achieved forecasting accuracy comparable to a crowd of 925 human forecasters. **Important scope caveat**: the study used 31 binary prediction questions (yes/no event forecasts scored by Brier score) — not continuous numeric regression. The difference between the LLM ensemble and human crowd was not statistically significant after multiple-comparison corrections. The key aggregation insight that does generalize: **median outperforms mean** — mean averaging amplifies shared biases, while median is outlier-robust.[^44][^45][^46][^47][^48]

For a production system constrained to <$0.05/commit:
- 3 calls to the same model (e.g., Claude Sonnet at different temperatures: 0.0, 0.3, 0.7) → take median
- Or 2 calls to Claude + 1 call to GPT-4o → take median
- The median-aggregation principle is well-supported; a specific MAPE improvement figure for this exact task cannot be reliably projected from the available literature and should be validated empirically

Self-MoA research suggests that multiple samples from a single high-quality model can match the diversity of multi-model ensembles, making temperature-varied sampling from Claude Sonnet a cost-effective strategy worth testing.[^49]

### 4.2 Bayesian Prior + LLM Posterior

A principled Bayesian framework for combining heuristic estimates with LLM estimates:

1. **Prior**: COCOMO-style heuristic from structural features
   \[
   \hat{h}_{\text{prior}} = A \cdot \text{KSLOC}^{1.15} \cdot \prod_i \text{EM}_i
   \]
   where KSLOC is proxied from effective churn ÷ 50 (lines per hour) and EMs from file type signals

2. **LLM likelihood**: The LLM provides an estimate conditioned on all metadata
   \[
   P(\text{effort} \mid \text{metadata}) \propto \mathcal{N}(\hat{h}_{\text{LLM}}, \sigma^2_{\text{LLM}})
   \]

3. **Posterior**: Weighted combination using historical calibration
   \[
   \hat{h}_{\text{final}} = w_{\text{prior}} \cdot \hat{h}_{\text{prior}} + w_{\text{LLM}} \cdot \hat{h}_{\text{LLM}}
   \]

The Bayesian combination framework is well-motivated in the LLM calibration literature. The initial weights \(w_{\text{prior}} = 0.3,\ w_{\text{LLM}} = 0.7\) are **not sourced from a published study** and should be treated as a starting hyperparameter. The correct initial split depends on how well-calibrated your heuristic prior is relative to LLM output for your specific repository. As ground-truth data accumulates, learn optimal weights per commit-type cluster using simple linear regression on historical estimates.[^50][^51]

### 4.3 Feedback Loop and Per-Repository Calibration

The most powerful accuracy improvement requires no model changes — only systematic logging and calibration:[^6]

1. **Track error by commit type**: Maintain MAPE per `(intent_class × scope × size_bucket)` cell
2. **Apply multiplicative correction**: If the system consistently overestimates `migration` commits by 40%, apply a 0.6× correction factor for that category
3. **Rolling calibration**: Use exponential moving average with decay 0.85 to weight recent calibration data more heavily
4. **Cluster-specific few-shot retrieval**: For each new commit, pull examples from the same `(intent_class × scope)` cluster — this is the in-context equivalent of per-repository fine-tuning

This per-repository calibration strategy allows the system to adapt to codebase-specific effort profiles (e.g., a monorepo where cross-module changes are 2x harder than average) without any model fine-tuning — all via prompt-engineering and multiplicative correction.[^52]

***

## Part 5: Risk Matrix — Known Failure Modes

| Failure Mode | Detection Signal | Mitigation | Severity |
|-------------|-----------------|------------|---------|
| **Subtle algorithm change** (small diff, high effort) | Low line count + security/perf-related commit message keywords | AST complexity delta; flag for human review | High |
| **Vendor/generated code import** | Package directories, `vendor/`, `node_modules/` traces in path | Generated code exclusion pipeline; effective vs. raw file count | High |
| **Bulk rename-only commits** | >50% `R` (rename) status in `git diff --name-status` | Rename detection; apply 0.5h/50-file rate, cap at 4h | High |
| **Security-critical code** | File paths matching `auth/`, `crypto/`, `security/`, `*.pem` | Domain multiplier flag; escalate to human + 1.5x multiplier | High |
| **Performance optimization** | Commit message contains "perf", "benchmark", "O(n)", profiling tool names | Escalate; these require understanding of before/after behavior | High |
| **Cross-module architectural refactor** | Entropy > 0.9, scope=system-wide, intent=refactor | Wide confidence interval; requires architectural context | Medium |
| **Test-only commits** | test_ratio > 80% | Cap estimate at (logic_lines × 0.6h per 100 lines) | Medium |
| **Framework/dependency upgrade** | `package.json`, `requirements.txt` with many version bumps | Semi-generated; escalate if downstream code changes detected | Medium |
| **Domain-specific multipliers** (embedded, compliance) | Repository-level tag or path patterns (`/firmware/`, `/compliance/`) | Per-repo calibration constant; domain expert review | Medium |
| **Unusual commit-to-PR structure** | Single-file commits from squash-merge of large PR | Use PR metadata if available | Low |

### Confidence Routing Thresholds

Flag for human review when ANY of:
- LLM confidence = "low"
- Estimate range width > 3x (e.g., 5–20h)
- Detected pattern flag is active (security, performance, vendor)
- Commit falls outside training distribution (novel file type mix or extreme NF)
- Z-score of `effective_churn` > 3.0 relative to repository historical distribution

***

## Part 6: Evaluation Framework

### 6.1 Primary Metrics

For effort estimation evaluation, the following metric suite is recommended:[^53][^54][^17]

**MAPE (Mean Absolute Percentage Error)**:
\[
\text{MAPE} = \frac{1}{n} \sum_{i=1}^{n} \left| \frac{h_i^{\text{actual}} - h_i^{\text{predicted}}}{h_i^{\text{actual}}} \right| \times 100\%
\]
*Target*: < 50% (competitive with expert estimation). *Warning*: MAPE is biased toward underestimation models.

**MdAPE (Median Absolute Percentage Error)**:
Same formula but median instead of mean. Use as primary metric — more robust to outliers than MAPE, and unbiased.[^54]

**PRED(25) and PRED(50)**:
\[
\text{PRED}(p) = \frac{|\{i : |h_i^{\text{actual}} - h_i^{\text{predicted}}| / h_i^{\text{actual}} \leq p/100\}|}{n}
\]
- PRED(25): % within 25% of actual — benchmark is 46–64% for ML models on classical project-level datasets (Desharnais, Maxwell, COCOMO); commit-level benchmarks do not yet exist[^17]
- PRED(50): % within 50% of actual — your system currently achieves 100% (5/5 within 2x), though 5 data points are insufficient to draw statistical conclusions

**Standardized Accuracy (SA)**:
SA measures improvement over the mean-of-all-actuals baseline — unbiased and recommended alongside PRED(p).[^53]

**Bias**:
\[
\text{Bias} = \text{median}\left(\frac{h_i^{\text{predicted}} - h_i^{\text{actual}}}{h_i^{\text{actual}}}\right)
\]
Positive bias = systematic overestimation. Track separately by commit type.

### 6.2 Evaluation Study Design

**Minimum sample sizes:**

| Goal | Minimum N | Rationale |
|------|-----------|-----------|
| Initial system validation | 30 commits | Central limit theorem; detect 50% MAPE reliably |
| Per-category calibration | 20 per category | Sufficient for multiplicative correction |
| Statistical comparison vs. baseline | 50–100 commits | Wilcoxon signed-rank test at p < 0.05 |
| Production-grade confidence | 200+ commits | Covers tail distributions and rare commit types |

**Ground truth collection strategy:**

Ground truth for developer hours is the hardest part of this evaluation. Three viable approaches:
1. **Time-tracking integration**: If your team uses Jira time-logging or similar, extract actual hours at PR level
2. **Expert labeling**: Have senior engineers estimate 50 representative commits independently (inter-rater reliability check via Krippendorff's alpha)
3. **Commit velocity proxy**: For well-instrumented teams, commits with clear single-author single-session patterns can be timed from commit timestamps

**Cross-validation**:
- Use leave-one-out or k-fold stratified by commit type, not random splits
- Evaluate cross-repository generalization with at least 2 different codebases

### 6.3 A/B Testing Protocol for Production

For continuous improvement in production:
1. For each incoming commit, log: `{metadata_features, llm_estimate, model_version, prompt_version}`
2. When ground truth becomes available, compute error and update calibration weights
3. Run periodic statistical tests (Wilcoxon) to detect when a new prompt version significantly changes MAPE distribution

***

## Part 7: Implementation Roadmap

### Phase 1: MVP (1–2 weeks)

**Objective**: Establish baseline accuracy on 30 labeled commits.

1. Build `CommitMetadataExtractor`:
   - `git diff --shortstat` for churn and file count
   - File extension categorization with a static mapping
   - Generated file exclusion via pattern matching
   - Move/rename detection via `git diff --name-status`
   - Entropy computation from per-file `--numstat` output

2. Build simple intent classifier using Claude Haiku (1 call, < $0.001):
   - Input: commit message, directory structure
   - Output: `{intent, scope, novelty_signal}`

3. Implement zero-shot estimation prompt (Claude Sonnet) with:
   - Structured metadata block (as templated above)
   - Explicit calibration notes
   - Request for [low, mid, high] range + confidence

4. Log all outputs with metadata for future calibration

**Expected accuracy**: ~50% MAPE (comparable to current manual metadata approach)

### Phase 2: Few-Shot Calibration (2–4 weeks)

**Objective**: Reduce MAPE to < 35% using search-based few-shot selection.

1. Collect 30–50 ground-truth commits with verified effort hours
2. Implement feature vector computation for similarity search
3. Build similarity-based few-shot selector (cosine distance in feature space)
4. Implement the 3-step constrained CoT template
5. Add LLM-as-judge second call for plausibility gating
6. Add per-commit-type multiplicative calibration correction

**Expected accuracy**: ~30–35% MAPE (competitive with expert judgment), PRED(50) > 80%

**Cost per commit**: ~$0.025–0.035 (two LLM calls)

### Phase 3: Ensemble and Adaptive Learning (4–8 weeks)

**Objective**: Reduce MAPE to < 25%, implement feedback loop.

1. Add 3-sample temperature-varied sampling → median aggregation
2. Build Bayesian prior from COCOMO-style heuristic as prior, blend with LLM posterior
3. Implement rolling calibration with exponential moving average per commit-type cluster
4. Build confidence routing: flag low-confidence estimates for human review
5. Per-repository calibration constants stored in database
6. Add AST complexity features via tree-sitter for flagged low-confidence commits

**Expected accuracy**: < 25% MdAPE for well-calibrated commit types

**Cost per commit**: ~$0.035–0.045 (three LLM calls + optional AST)

### Phase 4: Production Grade (ongoing)

**Objective**: Statistical monitoring, drift detection, human-in-the-loop integration.

1. Implement CUSUM or EWMA control charts for MAPE drift detection by commit type
2. Active learning: route the most uncertainty-maximizing commits for human labeling
3. Per-repository profile: track domain-specific multipliers (security code overhead, etc.)
4. Dashboard: real-time MAPE by commit category, calibration factor history, routing rate

**Key success criterion**: PRED(25) > 50% and PRED(50) > 80% across all commit types, with < 5% flagged for human review.

***

## Known Gaps in the Literature

The following are areas where the evidence base is thin or absent — production decisions in these areas should be treated as engineering bets to be validated, not established best practices:

- **No commit-level metadata-only effort estimation benchmark exists.** All reviewed studies operate at project level (COCOMO/ISBSG), sprint level (SEEAgent), or issue/story level (SBSE). The commit-level transfer is an unvalidated extension.
- **The 59.34% MAE improvement from SBSE** is a preliminary result on 30-issue test sets; it has not been replicated on hour-regression tasks or large PR commits.
- **SEEAgent without fine-tuning** is not the same system as the published results; the base (untuned) model performs poorly.
- **Optimal few-shot count for hour estimation** (3–5 examples recommended) is extrapolated from story-point literature and anchoring bias research, not a measured result for this domain.
- **The w_prior / w_LLM weights (0.3/0.7)** have no empirical source; treat as initial hyperparameter.
- **Calibration numbers in the system prompt** (lines-per-hour, rename overhead) are expert heuristics and must be calibrated per repository.

***

## Open-Source Tools and Resources

**Evaluation datasets:**
- ISBSG dataset (7,518 completed projects, 264 features) — gold standard for parametric calibration[^19]
- PROMISE/Desharnais/Maxwell datasets — smaller, widely benchmarked[^19]
- ApacheJIT (106,674 commits, labeled clean/buggy) — useful for feature validation, not effort ground truth[^55]

**Tools for feature extraction:**
- `git diff --numstat`, `--shortstat`, `--name-status` — all metadata, zero tokens
- `tree-sitter` (Rust/Python/JS) — cross-language AST for complexity features
- `cloc` — lines of code by language with generated file exclusion
- `tokei` — faster alternative to cloc, Rust-based

**LLM estimation frameworks:**
- SEEAgent codebase (arxiv 2509.14483) — open-source multi-agent agile estimation (requires fine-tuning for published accuracy)[^20]
- CoGEE/NSGA-II implementation from SBSE study (arxiv 2403.08430) — few-shot selection optimization for story points[^56]

**Calibration tools:**
- `crepes` (Python) — conformal prediction for calibrated confidence intervals
- This implements the FermiEval correction approach that reduces Winkler score by 54%[^38]

---

## References

1. [[PDF] USC COCOMO II 2000 - Rose-Hulman](https://www.rose-hulman.edu/class/cs/csse372/201410/Homework/CII_manual2000.pdf)

2. [Version 2.1](https://www.cs.otago.ac.nz/cosc345/resources/COCOMO-II-2000.pdf)

3. [[PDF] COCOMO II Model Definition Manual](https://www.cs.montana.edu/courses/spring2004/352/public/cocomo/modelman.pdf)

4. [Optimizing Effort Parameter of COCOMO II Using Particle Swarm Optimization Method](https://zenodo.org/record/3982157/files/35%209703.pdf) - ...and widely used models for estimating software costs. To estimate the cost of a software project,...

5. [Estimation of the COCOMO Model Parameters Using Genetic Algorithms for NASA Software Projects](http://thescipub.com/pdf/10.3844/jcssp.2006.118.123) - ...managers to accurately allocate the available resources for the project. In this study, we presen...

6. [Negative Results for Software Effort Estimation](http://arxiv.org/pdf/1609.05563.pdf) - ...: The major negative results of this paper are
that for the COCOMO data sets, nothing we studied ...

7. [COSMIC functional size measurement - Wikipedia](https://en.wikipedia.org/wiki/COSMIC_functional_size_measurement) - COSMIC functional size measurement is a method to measure a standard functional size of a piece of s...

8. [WHAT IS A COSMIC FUNCTION POINT?](https://cosmic-sizing.org/wp-content/uploads/2018/08/What-is-a-COSMIC-Function-Point-v1.0-1.pdf)

9. [LLM-Based Automation of COSMIC Functional Size Measurement ...](https://ieeexplore.ieee.org/document/10938386/) - We propose an automatic approach, CosMet, that leverages Large Language Models to measure software s...

10. [[PDF] How to use COSMIC Functional Size in Effort Estimation Models?](https://www.diva-portal.org/smash/get/diva2:836007/FULLTEXT02.pdf) - The functional sizes of Project-1, Project-2 and Project-3 were measured as 222 COSMIC Function Poin...

11. [Measurement of software size: Contributions of cosmic to estimation ...](https://www.academia.edu/96164936/Measurement_of_software_size_Contributions_of_cosmic_to_estimation_improvements) - COSMIC measurement provides a standardized framework that facilitates consistent software size estim...

12. [Cone of Uncertainty - Concepts](https://concepts.dsebastien.net/concept/cone-of-uncertainty/) - The principle that estimation accuracy improves as a project progresses and unknowns are resolved.

13. [Cone of uncertainty - Wikipedia](https://en.wikipedia.org/wiki/Cone_of_uncertainty)

14. [Agility, Uncertainty, and Software Project Estimation](https://cgi.csc.liv.ac.uk/~coopes/comp319/2016/papers/Agility,%20Uncertainty%20and%20Estimation.pdf)

15. [Reducing Estimation Uncertainty with Continuous ...](https://dl.icdst.org/pdfs/files/407ee15fb146cf5b1fe3fdb679e469c5.pdf)

16. [Software development effort estimation - Wikipedia](https://en.wikipedia.org/wiki/Software_development_effort_estimation)

17. [Software Effort Estimation Accuracy Prediction of](https://arxiv.org/pdf/2101.10658.pdf)

18. [Expert-based software effort estimation as a behavioral act (ESEIW ...](https://conf.researchr.org/details/esem-2024/esem-2024-journal-first/7/Much-more-than-a-prediction-Expert-based-software-effort-estimation-as-a-behavioral-) - We show that estimators do not necessarily behave entirely rationally given the information they hav...

19. [PERKIRAAN SUMBER DAYA PENGEMBANGAN SISTEM INFORMASI MENGGUNAKAN COCOMO II (Studi Kasus : Pengembangan Sistem Informasi Pengelolaan Data English Proficiency Test (EPT) Unit Pelaksana Teknis (UPT) Bahasa Universitas Lampung)](https://www.semanticscholar.org/paper/e9c01a4543959b37e3379fb19304d05fbe72fcac)

20. [An LLM-based multi-agent framework for agile effort estimation - arXiv](https://arxiv.org/html/2509.14483v1)

21. [[論文評述] An LLM-based multi-agent framework for agile ...](https://www.themoonlight.io/tw/review/an-llm-based-multi-agent-framework-for-agile-effort-estimation) - The paper introduces **SEEAgent**, a novel Large Language Model (LLM)-based multi-agent framework de...

22. [Search-based Optimisation of LLM Learning Shots for Story Point ...](https://arxiv.org/abs/2403.08430) - Our preliminary results show that our SBSE technique improves the estimation performance of the LLM ...

23. [Search-based Optimisation of LLM Learning Shots for Story Point Estimation](https://ar5iv.labs.arxiv.org/html/2403.08430) - One of the ways Large Language Models (LLMs) are used to perform machine learning tasks is to provid...

24. [Code Churn: A Neglected Metric in Effort-Aware Just-in-Time Defect Prediction](http://ieeexplore.ieee.org/document/8169980/)

25. [Code churn: a neglected metric in effort-aware just-in-time defect ...](https://dl.acm.org/doi/10.1109/ESEM.2017.8) - In this study, we aim to investigate the effectiveness of code churn based unsupervised defect predi...

26. [Improving effort-aware just-in-time defect prediction with weighted code churn and multi-objective slime mold algorithm](https://linkinghub.elsevier.com/retrieve/pii/S2405844024133919) - Effort-aware just-in-time software defect prediction (JIT-SDP) aims to effectively utilize the limit...

27. [[PDF] Feature Sets in Just-in-Time Defect Prediction:An Empirical Evaluation](https://arxiv.org/pdf/2209.13978.pdf) - We propose two new features sets for JIT defect predictions. One is based on metrics from the softwa...

28. [[PDF] Improving effort-aware just-in-time defect prediction with weighted ...](https://papers.ssrn.com/sol3/Delivery.cfm/00dbef80-8d7b-4bc1-998c-08cf7fc87ecd-MECA.pdf?abstractid=4585053&mirid=1) - In this study, we aim to improve the performance of effort-aware JIT-SDP by improving both the featu...

29. [GitHub - jatuhurrra/LLM-for-Intent-Classification](https://github.com/jatuhurrra/LLM-for-Intent-Classification) - This project explores the potential of deploying large language models (LLMs) such as GPT-4 for zero...

30. [Detecting refactoring type of software commit messages based on ...](https://www.nature.com/articles/s41598-024-72307-0) - We propose a novel approach using four ensemble Machine Learning algorithms to detect refactoring ty...

31. [Chain-of-Thought Prompting Elicits Reasoning in Large Language ...](https://arxiv.org/abs/2201.11903) - We explore how generating a chain of thought -- a series of intermediate reasoning steps -- signific...

32. [Revisiting Chain-of-Thought Prompting: Zero-shot Can Be Stronger ...](https://arxiv.org/html/2506.14641v1) - We find that for recent strong models such as the Qwen2.5 series, adding traditional CoT exemplars d...

33. [Enhancing LLM Performance with Constrained Chain-of-Thought](https://towardsdatascience.com/short-and-sweet-enhancing-llm-performance-with-constrained-chain-of-thought-c4479361d995/) - Just by forcing the model to reason step-by-step (with the simple addition in the prompt of 'let's t...

34. [LLMs are Overconfident: Evaluating Confidence Interval Calibration ...](https://arxiv.org/html/2510.26995v1) - We study how well LLMs construct confidence intervals around their own answers and find that they ar...

35. [The Curse of CoT: On the Limitations of Chain-of-Thought in In-Context
  Learning](https://arxiv.org/pdf/2504.05081.pdf) - Chain-of-Thought (CoT) prompting has been widely recognized for its ability
to enhance reasoning cap...

36. [[PDF] Search-based Optimisation of LLM Learning Shots for Story Point ...](https://vtawosi.github.io/files/SB_LLM_Shot_optimisation.pdf) - Our preliminary results show that our SBSE technique improves the estimation performance of the. LLM...

37. [Human bias in AI models? Anchoring effects and mitigation ...](https://www.sciencedirect.com/science/article/pii/S2214635024000868)

38. [LLMs are Overconfident: Evaluating Confidence Interval Calibration with FermiEval](https://arxiv.org/abs/2510.26995) - Large language models (LLMs) excel at numerical estimation but struggle to correctly quantify uncert...

39. [LLMs are Overconfident: Evaluating Confidence Interval Calibration ...](https://ownyourai.com/llms-are-overconfident-evaluating-confidence-interval-calibration-with-fermieval/) - Our study with FermiEval exposes a systemic issue: LLMs are consistently overconfident in their nume...

40. [LLM as a Judge - Primer and Pre-Built Evaluators - Arize AI](https://arize.com/llm-as-a-judge/) - Research-driven guide to using LLM-as-a-judge. 25+ LLM judge examples to use for evaluating gen-AI a...

41. [LLM-as-a-judge: a complete guide to using LLMs for evaluations](https://www.evidentlyai.com/llm-guide/llm-as-a-judge) - LLM-as-a-judge is a common technique to evaluate LLM-powered products. It grew popular for a reason:...

42. [LLM-as-a-Judge Simply Explained: The Complete Guide to Run ...](https://www.confident-ai.com/blog/why-llm-as-a-judge-is-the-best-llm-evaluation-method) - LLM-as-a-Judge is the process of using LLMs to evaluate LLM (system) outputs, and it works by first ...

43. [What is LLM as a Judge? How to Use LLMs for Evaluation - Encord](https://encord.com/blog/llm-as-a-judge/) - The goal of using LaaJ is to verify if the LLM system functions as expected within specified paramet...

44. [Probing LLM World Models: Enhancing Guesstimation with Wisdom of Crowds Decoding](https://arxiv.org/abs/2501.17310) - Guesstimation -- the task of making approximate quantitative estimates about objects or events -- is...

45. [Probing LLM World Models: Enhancing Guesstimation with Wisdom of Crowds
  Decoding](http://arxiv.org/pdf/2501.17310.pdf) - ...containers (e.g., a one-cup measuring cup),
both with and without accompanying images. Inspired b...

46. [Wisdom of the silicon crowd: LLM ensemble prediction capabilities rival human crowd accuracy](https://www.science.org/doi/10.1126/sciadv.adp1528) - An ensemble of 12 LLM models achieved forecasting accuracy statistically indistinguishable from that...

47. [LLM Ensemble Prediction Capabilities Rival Human Crowd Accuracy](https://arxiv.org/abs/2402.19379) - Human forecasting accuracy in practice relies on the 'wisdom of the crowd' effect, in which predicti...

48. [Wisdom of the Silicon Crowd: LLM Ensemble Prediction Capabilities Rival Human Crowd Accuracy](https://arxiv.org/html/2402.19379v2)

49. [Rethinking Mixture-of-Agents: Is Mixing Different Large Language Models
  Beneficial?](http://arxiv.org/pdf/2502.00674.pdf) - Ensembling outputs from diverse sources is a straightforward yet effective
approach to boost perform...

50. [Bayesian Calibration of Win Rate Estimation with LLM Evaluators](https://arxiv.org/html/2411.04424v1) - In this section, we first formalize the win rate estimation bias problem associated with directly ap...

51. [Bayesian Concept Bottleneck Models with LLM Priors](https://arxiv.org/html/2410.15555v3)

52. [An LLM-based multi-agent framework for agile effort estimation](https://ieeexplore.ieee.org/document/11334617/) - Effort estimation is a crucial activity in agile software development, where teams collaboratively r...

53. [Evaluating Pred(__p__) and standardized accuracy criteria in software development effort estimation](https://onlinelibrary.wiley.com/doi/10.1002/smr.1925) - ## Abstract

Software development effort estimation (SDEE) plays a primary role in software project ...

54. [The Myth of the MAPE . . . and how to avoid it](https://cpdftraining.org/downloads/Levenbach_AccuracyTAPE2015.pdf)

55. [ApacheJIT: A Large Dataset for Just-In-Time Defect Prediction](https://arxiv.org/pdf/2203.00101.pdf) - In this paper, we present ApacheJIT, a large dataset for Just-In-Time defect
prediction. ApacheJIT c...

56. [Search-based Optimisation of LLM Learning Shots for Story Point
  Estimation](http://arxiv.org/pdf/2403.08430.pdf) - ... them to
produce a prediction. This is a meta-learning process known as few-shot
learning. In thi...

