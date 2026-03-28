# Small Commit Estimation — GT Rerun

**Date**: 2026-03-27 20:49
**Method**: reused saved model outputs, replaced the 20-commit GT with a manual diff-based reassessment.
**LLM calls**: 0 (metric recomputation only).

## Revised GT

| SHA | Original GT | Revised GT | Rationale |
|-----|------------:|-----------:|-----------|
| f4805502 | 0.5-1.5h | 2.5-4.5h | Billing change mirrored in API estimator and temporal worker, plus six test updates. This is a small but real cross-module behavior change, not a 30-60 minute fix. |
| cd320b77 | 0.3-1.0h | 1.5-3.0h | Timing-sensitive React state synchronization bug with cooldown logic, refs, and remount guard. Debugging and validating this kind of autosave race takes longer than the diff size suggests. |
| cba942fb | 0.3-0.8h | 0.75-1.5h | Still a genuinely small fix: dependency cleanup, ref-based equality guard, and one callback memoization. This is the only case in the set that still looks plausibly sub-2h. |
| f63a460b | 0.3-0.8h | 1.5-3.0h | Cross-cutting UI guard plus shared ts-api validation across multiple result tables. Mechanically small, but it touches several entry points and backend validation at once. |
| 082eaf12 | 0.5-1.5h | 3.0-5.0h | Database migration plus temporal activity contract change plus workflow quota logic. This is a small full-stack workflow fix, not a quick patch. |
| 026ac924 | 1.0-2.5h | 3.0-5.0h | New authenticated admin API route with validation and Metronome event emission, plus a new admin UI flow. Focused work, but clearly more than 1-2 hours. |
| 07809e14 | 0.5-1.5h | 2.0-4.0h | Adds a new LinkedIn blocker path in scheduler logic and nearly 100 lines of integration tests. The test coverage alone pushes this above the original GT. |
| d674fef7 | 0.5-1.5h | 1.5-3.0h | Introduces a new reusable inbox rendering component and wires it into multiple views. Compact feature, but still new UI/component work rather than a tweak. |
| 57251337 | 2.0-5.0h | 3.0-5.0h | New billing metrics module plus client/service instrumentation and service-factory wiring. Mostly straightforward instrumentation, but broader than a 2h task. |
| b6d87eae | 2.0-4.0h | 4.0-6.5h | Search relevance tuning across multiple libraries, inner_hits handling, and substantial test additions. This is algorithm and ranking work, not a small feature. |
| f82dd9d0 | 1.5-3.5h | 3.5-6.0h | Reply composer signature preview plus job-title editing spans API, service wiring, frontend modal state, invalidation logic, and tests. |
| 16b88e6a | 2.0-5.0h | 5.5-8.5h | Real feature: repository extension, scheduler DNC logic, new web components, and a large dedicated test block. The original GT materially understated the scope. |
| 4544aacc | 1.0-2.5h | 3.0-5.0h | New heartbeat webhook, script-generation changes, config/env plumbing, and verification-flow rewrite. Small in LOC, medium in moving parts. |
| 37ce974c | 4.0-8.0h | 8.0-14.0h | Large mailbox reconnect feature with API endpoints, popup flow, provider client updates, service refactor, and extensive integration tests. |
| 679ac18e | 2.0-5.0h | 3.5-6.0h | Primarily UI work, but spread across sidebar credits and campaign-builder surfaces with non-trivial component redesign. |
| 82e02c56 | 4.0-8.0h | 8.0-13.0h | Large frontend feature set for CRM property mapping with multiple new generic components, tables, hooks, constants, and type surfaces. |
| a84b7843 | 4.0-9.0h | 6.5-10.5h | Full-stack billing UX improvement with backend estimation changes, runway logic, new hooks/components, and heavy test additions. |
| ef323c98 | 3.0-7.0h | 4.0-7.0h | Perf-oriented architectural cleanup: async Inngest flows, model/config swaps, prompt tightening, and frontend polling updates. |
| 680dcb92 | 3.0-6.0h | 5.0-8.5h | Meaningful refactor with two migrations, repository rewrite from dedicated table to base tasks model, and related task-query updates. |
| a579d648 | 2.0-5.0h | 3.5-6.0h | Deletion-heavy, but not free: removal of mock inbox path, switching profile/header to real data, and cleanup across API, web, tests, and logging. |

## Experiment 1 — Metadata Enrichment

| Variant | MAPE | Median APE | MAE | In-range | Bias |
|---------|-----:|-----------:|----:|---------:|-----:|
| A (baseline) | 35.7% | 26.3% | 1.49 | 12/20 (60%) | +21.4% |
| B (enriched) | 35.1% | 21.5% | 1.47 | 12/20 (60%) | +20.8% |

Head-to-head: A wins 4, B wins 4, ties 12.

## Experiment 2 — Model Comparison

| # | Model | MAPE | Median APE | MAE | In-range | Bias |
|---|-------|-----:|-----------:|----:|---------:|-----:|
| 1 | Qwen3 Next | 27.1% | 16.2% | 1.14 | 15/20 (75%) | +22.4% |
| 2 | Qwen3 Flash | 27.8% | 14.3% | 1.17 | 15/20 (75%) | +21.0% |
| 3 | GPT-5.1 Codex Mini | 29.4% | 26.8% | 1.37 | 14/20 (70%) | +12.3% |
| 4 | Qwen3 Coder | 29.5% | 23.4% | 1.44 | 12/20 (60%) | +15.9% |
| 5 | Ollama (local) | 35.7% | 26.3% | 1.49 | 12/20 (60%) | +21.4% |
| 6 | Qwen3 Coder+ | 47.6% | 42.0% | 1.41 | 5/12 (42%) | +47.6% |

## Experiment 3 — Production Prompts

| # | Model | MAPE | Median APE | MAE | In-range | Bias |
|---|-------|-----:|-----------:|----:|---------:|-----:|
| 1 | Qwen3 Next | 30.7% | 24.9% | 1.29 | 14/20 (70%) | +21.9% |
| 2 | Ollama (local) | 35.7% | 26.3% | 1.49 | 12/20 (60%) | +21.4% |
| 3 | Qwen3 Coder+ | 43.4% | 33.3% | 2.01 | 9/19 (47%) | +42.9% |
| 4 | Qwen3 Coder | 52.5% | 51.2% | 2.44 | 6/20 (30%) | +49.7% |
| 5 | Qwen3 Flash | 121.2% | 109.1% | 6.62 | 0/20 (0%) | +121.2% |
| 6 | GPT-5.1 Codex Mini | 142.2% | 152.6% | 7.01 | 3/13 (23%) | +139.6% |

## Qwen Production vs Custom

| Prompt | MAPE | Median APE | MAE | In-range | Bias |
|--------|-----:|-----------:|----:|---------:|-----:|
| Production 2-pass | 52.5% | 51.2% | 2.44 | 6/20 (30%) | +49.7% |
| Custom single-call | 29.5% | 23.4% | 1.44 | 12/20 (60%) | +15.9% |

Per-commit head-to-head: custom wins 11, production wins 3, ties 6.

## Takeaways

- After re-estimating GT from the actual diffs, the dominant signal is no longer extreme model overestimation. Most single-call models land in the 27-36% MAPE range on the revised GT.
- The original claim that small commits are systematically overestimated by 2-4x was driven largely by a downward-biased GT set, not only by prompt calibration.
- Prompt calibration still matters: the custom single-call prompt remains clearly stronger than the production 2-pass Qwen path (29.5% vs 52.5% MAPE).
- Metadata enrichment remains effectively neutral. It nudges Ollama from 35.7% to 35.1% MAPE, which is too small to support a strong claim either way.
- Hard caps like `small_commit_cap` should not be added before GT is stabilized. With the revised GT, several originally 'overestimated' commits look reasonably estimated.

## Inputs Used

- GT file: `C:\Projects\devghost\docs\revised-small-commit-ground-truth.json`
- Enrichment results: `C:\Projects\devghost\packages\server\scripts\pipeline\experiment_v3_results\experiment_enrichment_2026-03-27_191131.json`
- Model comparison results: `C:\Projects\devghost\packages\server\scripts\pipeline\experiment_v3_results\model_comparison_small_2026-03-27_194358.json`
- Production prompt results: `C:\Projects\devghost\packages\server\scripts\pipeline\experiment_v3_results\production_prompts_2026-03-27_202348.json`
