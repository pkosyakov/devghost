"""
Production Prompts Experiment — 5 models with exact production 2-pass pipeline.

Replicates the production estimation flow from run_v16_pipeline.py:
  Pass 1: PROMPT_PASS1 (classify) → ANALYSIS_SCHEMA
  Pass 2: PROMPT_2PASS_V2 or PROMPT_HYBRID_C (estimate) → ESTIMATE_SCHEMA

Compares to previous experiment which used a custom single-call prompt.

20 commits × 5 models × 2 passes = 200 OpenRouter calls.

Usage:
    python experiment_production_prompts.py --repo C:\\Projects\\_tmp_devghost_audit\\artisan-private
    python experiment_production_prompts.py --repo ... --commit cd320b77
"""

import re
import os
import sys
import json
import time
import argparse
import statistics
import subprocess
from datetime import datetime
from collections import defaultdict

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from experiment_v3 import (
    extract_commit_data,
    call_openrouter,
    _extract_json,
    CACHE_DIR,
)


# ===== CONFIG =====

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
if not OPENROUTER_API_KEY:
    env_path = os.path.join(os.path.dirname(__file__), "..", "..", ".env")
    if os.path.exists(env_path):
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip()
                if line.startswith("OPENROUTER_API_KEY="):
                    OPENROUTER_API_KEY = line.split("=", 1)[1].strip().strip('"')
                    break

MODELS = [
    {"id": "qwen/qwen3-coder", "label": "Qwen3 Coder"},
    {"id": "qwen/qwen3-coder-next", "label": "Qwen3 Next"},
    {"id": "openai/gpt-5.1-codex-mini", "label": "GPT-5.1 Mini"},
    {"id": "qwen/qwen3-coder-flash", "label": "Qwen3 Flash"},
    {"id": "qwen/qwen3-coder-plus", "label": "Qwen3 Coder+"},
]


# ===== PRODUCTION PROMPTS (exact copy from run_v16_pipeline.py) =====

PROMPT_PASS1 = """Classify this TypeScript commit objectively. Be precise with percentages.

CODE CLASSIFICATION:
- Mechanical changes (renames, imports, formatting, moving code) are NOT new logic
- Tests that mirror implementation are boilerplate, not new logic
- Only genuinely new algorithms, business logic, or type-level code counts as new logic

ARCHITECTURAL SCOPE:
- none: Single file or simple changes within existing structure
- module: Extracting/creating modules within a package
- package: Creating new packages/crates/libraries with configuration
- multi_package: Workspace/monorepo restructuring
- system: Cross-repository architectural changes

COGNITIVE COMPLEXITY should consider BOTH code complexity AND architectural scope."""

PROMPT_2PASS_V2 = """Estimate total hours for this TypeScript commit as a middle dev (3-4yr experience, knows codebase)."""

PROMPT_HYBRID_C = """Estimate total hours for this TypeScript commit as a middle dev (3-4yr experience, knows codebase).

IMPORTANT: For commits with architectural_scope "package", "multi_package", or "system",
the effort is dominated by architectural overhead, NOT by the percentage of moved code.

REFERENCE POINTS:
- Simple refactor (scope: none, 90%+ moved code) -> 0.1-1h
- Module extraction (scope: module, 80%+ moved code) -> 3-6h
- Package creation (scope: package, 90%+ moved code) -> 10-20h
- Workspace restructure (scope: multi_package) -> 15-30h"""

ANALYSIS_SCHEMA = {
    "type": "object",
    "properties": {
        "change_type": {"type": "string"},
        "new_logic_percent": {"type": "number"},
        "moved_or_copied_percent": {"type": "number"},
        "boilerplate_percent": {"type": "number"},
        "architectural_scope": {"type": "string"},
        "cognitive_complexity": {"type": "string"},
        "summary": {"type": "string"},
    },
    "required": ["change_type", "new_logic_percent", "moved_or_copied_percent",
                  "boilerplate_percent", "architectural_scope", "cognitive_complexity", "summary"],
    "additionalProperties": False,
}

ESTIMATE_SCHEMA = {
    "type": "object",
    "properties": {
        "estimated_hours": {"type": "number"},
        "reasoning": {"type": "string"},
    },
    "required": ["estimated_hours", "reasoning"],
    "additionalProperties": False,
}

# Same 20 commits
GT_CASES = [
    {"sha": "f4805502", "gt_low": 0.5, "gt_high": 1.5,
     "label": "fix: make phone enrichment conditional (3f, +109/-88)"},
    {"sha": "cd320b77", "gt_low": 0.3, "gt_high": 1,
     "label": "fix: cooldown guard auto-save (3f, +45/-17)"},
    {"sha": "cba942fb", "gt_low": 0.3, "gt_high": 0.8,
     "label": "fix: infinite re-render loop (3f, +20/-8)"},
    {"sha": "f63a460b", "gt_low": 0.3, "gt_high": 0.8,
     "label": "fix: 200k contact limit (5f, +26/-9)"},
    {"sha": "082eaf12", "gt_low": 0.5, "gt_high": 1.5,
     "label": "fix: VARCHAR overflow + quota (4f, +84/-17)"},
    {"sha": "026ac924", "gt_low": 1, "gt_high": 2.5,
     "label": "feat: credit deduction admin (5f, +193/-15)"},
    {"sha": "07809e14", "gt_low": 0.5, "gt_high": 1.5,
     "label": "feat: skip LinkedIn steps (3f, +127/-2)"},
    {"sha": "d674fef7", "gt_low": 0.5, "gt_high": 1.5,
     "label": "feat: inbox parsing opt (4f, +117/-22)"},
    {"sha": "57251337", "gt_low": 2, "gt_high": 5,
     "label": "feat: Datadog billing metrics (10f, +271/-23)"},
    {"sha": "b6d87eae", "gt_low": 2, "gt_high": 4,
     "label": "feat: prospector scoring (9f, +372/-17)"},
    {"sha": "f82dd9d0", "gt_low": 1.5, "gt_high": 3.5,
     "label": "feat: inbox reply signature (10f, +195/-24)"},
    {"sha": "16b88e6a", "gt_low": 2, "gt_high": 5,
     "label": "feat: campaign list DNC (10f, +643/-155)"},
    {"sha": "4544aacc", "gt_low": 1, "gt_high": 2.5,
     "label": "fix: script URL derivation (9f, +99/-53)"},
    {"sha": "37ce974c", "gt_low": 4, "gt_high": 8,
     "label": "feat: mailbox reconnection (28f, +1469/-152)"},
    {"sha": "679ac18e", "gt_low": 2, "gt_high": 5,
     "label": "feat: campaign+credit ui (25f, +254/-162)"},
    {"sha": "82e02c56", "gt_low": 4, "gt_high": 8,
     "label": "feat: CRM property mapping (25f, +1955/-12)"},
    {"sha": "a84b7843", "gt_low": 4, "gt_high": 9,
     "label": "feat: credit UI indicators (20f, +1344/-66)"},
    {"sha": "ef323c98", "gt_low": 3, "gt_high": 7,
     "label": "perf: magic campaign speed (20f, +383/-324)"},
    {"sha": "680dcb92", "gt_low": 3, "gt_high": 6,
     "label": "refactor: call tasks (21f, +610/-274)"},
    {"sha": "a579d648", "gt_low": 2, "gt_high": 5,
     "label": "refactor: remove mocking (29f, +234/-2190)"},
]


# ===== METRICS =====

def gt_midpoint(c): return (c["gt_low"] + c["gt_high"]) / 2
def is_in_range(est, c): return c["gt_low"] <= est <= c["gt_high"]
def compute_ape(est, c):
    mid = gt_midpoint(c)
    return abs(est - mid) / mid if mid > 0 else 0

def compute_aggregate(results, key):
    valid = [(r, r[key]) for r in results if r.get(key) is not None]
    if not valid:
        return {"count": 0}
    apes = [compute_ape(est, r) for r, est in valid]
    return {
        "count": len(valid),
        "mape": statistics.mean(apes) * 100,
        "median_ape": statistics.median(apes) * 100,
        "in_range": sum(1 for r, est in valid if is_in_range(est, r)),
        "in_range_pct": sum(1 for r, est in valid if is_in_range(est, r)) / len(valid) * 100,
        "mean_signed_error": statistics.mean([(est - gt_midpoint(r)) / gt_midpoint(r) for r, est in valid]) * 100,
        "mae": statistics.mean([abs(est - gt_midpoint(r)) for r, est in valid]),
    }


# ===== EXPERIMENT =====

def run_experiment(repo, cases, no_cache=False, dry_run=False):
    results = []
    retry_queue = []  # Track failures for retry

    print(f"\n{'='*70}")
    print(f"PRODUCTION PROMPTS EXPERIMENT (2-pass)")
    print(f"Models: {len(MODELS)}")
    print(f"Commits: {len(cases)}")
    print(f"Total calls: ~{len(cases) * len(MODELS) * 2} (classify + estimate)")
    print(f"{'='*70}\n")

    for i, case in enumerate(cases, 1):
        sha = case["sha"]
        gt_mid = gt_midpoint(case)

        print(f"\n[{i}/{len(cases)}] {sha[:8]} — GT: {case['gt_low']}-{case['gt_high']}h")
        print(f"  {case['label']}")

        try:
            cd = extract_commit_data(repo, sha)
        except Exception as e:
            print(f"  ERROR: {e}")
            results.append({**case, "error": str(e)})
            continue

        parent = cd.get("parent")
        diff_args = ["git", "diff", f"{parent}..{sha}"] if parent else \
                    ["git", "diff", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha]
        diff = subprocess.run(diff_args, cwd=repo, capture_output=True,
                              encoding="utf-8", errors="replace").stdout

        fc, la, ld = cd["total_files"], cd["total_la"], cd["total_ld"]
        user_base = f"Commit: {cd['message']}\nFiles: {fc}, +{la}/-{ld}\n\n{diff}"

        row = {**case, "fc": fc, "la": la, "ld": ld, "diff_chars": len(diff)}

        if dry_run:
            results.append(row)
            continue

        for m in MODELS:
            mid = m["id"]
            label = m["label"]
            mkey = mid.replace("/", "_").replace("-", "_").replace(".", "_")
            est_key = f"est_{mkey}"

            print(f"  {label}: ", end="", flush=True)

            # --- Pass 1: Classify ---
            classify_prompt = f"{user_base}\n\nClassify this commit:"
            p1, m1 = call_openrouter(PROMPT_PASS1, classify_prompt, mid,
                                      OPENROUTER_API_KEY, schema=ANALYSIS_SCHEMA,
                                      no_cache=no_cache)

            if not p1 or not isinstance(p1, dict):
                err = m1.get("error", "classify failed")[:60]
                print(f"classify FAIL ({err})")
                row[est_key] = None
                row[f"analysis_{mkey}"] = None
                retry_queue.append((i - 1, m, sha, user_base))
                continue

            scope = p1.get("architectural_scope", "none")
            new_logic = p1.get("new_logic_percent", "?")
            print(f"[{scope}/{new_logic}%] ", end="", flush=True)

            row[f"analysis_{mkey}"] = p1

            # --- Pass 2: Estimate ---
            analysis_text = (
                f"Change type: {p1.get('change_type', '?')}\n"
                f"New logic: {p1.get('new_logic_percent', '?')}%, "
                f"Moved: {p1.get('moved_or_copied_percent', '?')}%\n"
                f"Scope: {scope}, Complexity: {p1.get('cognitive_complexity', '?')}"
            )
            estimate_input = f"{user_base}\n\nAnalysis:\n{analysis_text}\n\nEstimate:"

            if scope in ("none", "module"):
                sys_prompt = PROMPT_2PASS_V2
            else:
                sys_prompt = PROMPT_HYBRID_C

            p2, m2 = call_openrouter(sys_prompt, estimate_input, mid,
                                      OPENROUTER_API_KEY, schema=ESTIMATE_SCHEMA,
                                      no_cache=no_cache)

            est = p2.get("estimated_hours") if p2 else None

            if est is not None:
                ape = compute_ape(est, case) * 100
                tag = "OK" if is_in_range(est, case) else "MISS"
                elapsed = m1.get("elapsed_ms", 0) + m2.get("elapsed_ms", 0)
                c1 = "$" if m1.get("cache_hit") else ""
                c2 = "$" if m2.get("cache_hit") else ""
                print(f"{est:.1f}h (APE={ape:.0f}%, {tag}) [{elapsed/1000:.1f}s{c1}{c2}]")
                row[est_key] = est
                row[f"reasoning_{mkey}"] = p2.get("reasoning", "")
            else:
                err = m2.get("error", "estimate failed")[:60]
                print(f"estimate FAIL ({err})")
                row[est_key] = None
                retry_queue.append((i - 1, m, sha, user_base))

        results.append(row)

    # --- Retry failed calls (rate-limit recovery) ---
    if retry_queue:
        print(f"\n--- Retrying {len(retry_queue)} failed calls (after 10s cooldown) ---")
        time.sleep(10)

        for idx, m, sha, user_base in retry_queue:
            mid = m["id"]
            label = m["label"]
            mkey = mid.replace("/", "_").replace("-", "_").replace(".", "_")
            est_key = f"est_{mkey}"

            # Skip if already has a result (from earlier retry)
            if results[idx].get(est_key) is not None:
                continue

            print(f"  Retry {sha[:8]} / {label}: ", end="", flush=True)

            # Pass 1
            case = results[idx]
            classify_prompt = f"{user_base}\n\nClassify this commit:"
            p1, m1 = call_openrouter(PROMPT_PASS1, classify_prompt, mid,
                                      OPENROUTER_API_KEY, schema=ANALYSIS_SCHEMA,
                                      no_cache=True)  # no_cache for retry

            if not p1 or not isinstance(p1, dict):
                print(f"classify FAIL again")
                continue

            scope = p1.get("architectural_scope", "none")
            print(f"[{scope}] ", end="", flush=True)

            results[idx][f"analysis_{mkey}"] = p1

            # Pass 2
            analysis_text = (
                f"Change type: {p1.get('change_type', '?')}\n"
                f"New logic: {p1.get('new_logic_percent', '?')}%, "
                f"Moved: {p1.get('moved_or_copied_percent', '?')}%\n"
                f"Scope: {scope}, Complexity: {p1.get('cognitive_complexity', '?')}"
            )
            estimate_input = f"{user_base}\n\nAnalysis:\n{analysis_text}\n\nEstimate:"
            sys_prompt = PROMPT_2PASS_V2 if scope in ("none", "module") else PROMPT_HYBRID_C

            p2, m2 = call_openrouter(sys_prompt, estimate_input, mid,
                                      OPENROUTER_API_KEY, schema=ESTIMATE_SCHEMA,
                                      no_cache=True)

            est = p2.get("estimated_hours") if p2 else None
            if est is not None:
                ape = compute_ape(est, case) * 100
                tag = "OK" if is_in_range(est, case) else "MISS"
                print(f"{est:.1f}h (APE={ape:.0f}%, {tag})")
                results[idx][est_key] = est
                results[idx][f"reasoning_{mkey}"] = p2.get("reasoning", "")
            else:
                print(f"estimate FAIL again")

    return results


# ===== REPORT =====

def generate_report(results, output_dir):
    ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    os.makedirs(output_dir, exist_ok=True)

    model_keys = []
    for m in MODELS:
        mkey = m["id"].replace("/", "_").replace("-", "_").replace(".", "_")
        model_keys.append((m["id"], m["label"], f"est_{mkey}"))

    # Load Ollama baseline
    ollama_key = "est_ollama"
    enrichment_dir = output_dir
    ollama_results = {}
    for fname in sorted(os.listdir(enrichment_dir)):
        if fname.startswith("experiment_enrichment_") and fname.endswith(".json"):
            with open(os.path.join(enrichment_dir, fname), "r", encoding="utf-8") as f:
                edata = json.load(f)
            for r in edata.get("results", []):
                if r.get("est_a") is not None:
                    ollama_results[r["sha"]] = r["est_a"]

    for r in results:
        r[ollama_key] = ollama_results.get(r["sha"])

    # Also load previous experiment (custom prompt) results
    prev_key = "est_prev_custom"
    for fname in sorted(os.listdir(enrichment_dir)):
        if fname.startswith("model_comparison_small_") and fname.endswith(".json"):
            with open(os.path.join(enrichment_dir, fname), "r", encoding="utf-8") as f:
                pdata = json.load(f)
            for pr in pdata.get("results", []):
                sha = pr["sha"]
                # Get qwen/qwen3-coder result from previous experiment as "custom prompt" baseline
                prev_est = pr.get("est_qwen_qwen3_coder")
                for r in results:
                    if r["sha"] == sha and prev_est is not None:
                        r[prev_key] = prev_est

    all_keys = [("Ollama (local)", ollama_key)] + [(label, key) for _, label, key in model_keys]

    # Aggregates
    aggs = {}
    for label, key in all_keys:
        valid = [r for r in results if r.get(key) is not None]
        if valid:
            aggs[label] = compute_aggregate(valid, key)
        else:
            aggs[label] = {"count": 0}

    ranked = sorted(
        [(label, agg) for label, agg in aggs.items() if agg.get("count", 0) > 0],
        key=lambda x: x[1]["mape"],
    )

    # --- Markdown ---
    lines = []
    lines.append("# Production Prompts Experiment — 2-Pass Pipeline")
    lines.append(f"\n**Date**: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"**Commits**: {len(results)}")
    lines.append("**Design**: Production 2-pass (PROMPT_PASS1 classify + PROMPT_2PASS_V2/HYBRID_C estimate)")
    lines.append("")

    lines.append("## Model Rankings (production prompts)")
    lines.append("")
    lines.append("| # | Model | MAPE | Median APE | MAE (h) | In-range | Bias |")
    lines.append("|---|-------|-----:|----------:|--------:|---------:|-----:|")
    for rank, (label, agg) in enumerate(ranked, 1):
        lines.append(f"| {rank} | {label} | {agg['mape']:.1f}% | {agg['median_ape']:.1f}% | "
                      f"{agg['mae']:.2f} | {agg['in_range']}/{agg['count']} ({agg['in_range_pct']:.0f}%) | "
                      f"{agg['mean_signed_error']:+.0f}% |")
    lines.append("")

    # Compare production vs custom prompt (for models that have both)
    if any(r.get(prev_key) is not None for r in results):
        lines.append("## Production vs Custom Prompt (Qwen3 Coder)")
        lines.append("")
        prod_qwen_key = f"est_qwen_qwen3_coder"
        prod_valid = [r for r in results if r.get(prod_qwen_key) is not None]
        prev_valid = [r for r in results if r.get(prev_key) is not None]
        if prod_valid and prev_valid:
            agg_prod = compute_aggregate(prod_valid, prod_qwen_key)
            agg_prev = compute_aggregate(prev_valid, prev_key)
            lines.append("| Prompt | MAPE | In-range | MAE |")
            lines.append("|--------|-----:|---------:|----:|")
            lines.append(f"| Production 2-pass | {agg_prod['mape']:.1f}% | {agg_prod['in_range']}/{agg_prod['count']} | {agg_prod['mae']:.2f} |")
            lines.append(f"| Custom single-call | {agg_prev['mape']:.1f}% | {agg_prev['in_range']}/{agg_prev['count']} | {agg_prev['mae']:.2f} |")
            lines.append("")

    # Size breakdown
    lines.append("## Breakdown by Commit Size")
    lines.append("")
    size_buckets = {
        "Small (3-7 files)": [r for r in results if r.get("fc", 0) <= 7],
        "Medium (8-15 files)": [r for r in results if 8 <= r.get("fc", 0) <= 15],
        "Large (16-30 files)": [r for r in results if r.get("fc", 0) >= 16],
    }
    for bname, bucket in size_buckets.items():
        if not bucket:
            continue
        lines.append(f"### {bname} ({len(bucket)} commits)")
        lines.append("")
        lines.append("| Model | MAPE | In-range | MAE |")
        lines.append("|-------|-----:|---------:|----:|")
        brank = []
        for label, key in all_keys:
            valid = [r for r in bucket if r.get(key) is not None]
            if valid:
                agg = compute_aggregate(valid, key)
                brank.append((label, agg))
        brank.sort(key=lambda x: x[1].get("mape", 999))
        for label, agg in brank:
            lines.append(f"| {label} | {agg['mape']:.1f}% | {agg['in_range']}/{agg['count']} | {agg['mae']:.2f} |")
        lines.append("")

    # Per-commit table
    lines.append("## Per-Commit Estimates")
    lines.append("")
    header = "| # | SHA | FC | GT |"
    sep = "|---|-----|---:|---:|"
    for label, _ in all_keys:
        short = label[:10]
        header += f" {short} |"
        sep += "---:|"
    lines.append(header)
    lines.append(sep)

    for i, r in enumerate(results, 1):
        row_str = f"| {i} | {r['sha'][:8]} | {r.get('fc','?')} | {r['gt_low']}-{r['gt_high']} |"
        for _, key in all_keys:
            est = r.get(key)
            if est is not None:
                bold = "**" if is_in_range(est, r) else ""
                row_str += f" {bold}{est:.1f}{bold} |"
            else:
                row_str += " - |"
        lines.append(row_str)
    lines.append("")
    lines.append("*Bold* = within GT range.")
    lines.append("")

    # Classification analysis — show what pass1 thinks
    lines.append("## Pass 1 Classification Samples")
    lines.append("")
    # Show classification from best model for first 5 commits
    for r in results[:5]:
        sha = r["sha"][:8]
        for m in MODELS[:1]:  # Just first model
            mkey = m["id"].replace("/", "_").replace("-", "_").replace(".", "_")
            analysis = r.get(f"analysis_{mkey}")
            if analysis:
                lines.append(f"**{sha}** ({m['label']}): "
                             f"type={analysis.get('change_type','?')}, "
                             f"new_logic={analysis.get('new_logic_percent','?')}%, "
                             f"scope={analysis.get('architectural_scope','?')}, "
                             f"complexity={analysis.get('cognitive_complexity','?')}")
        lines.append("")

    md_path = os.path.join(output_dir, f"production_prompts_{ts}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\nMarkdown: {md_path}")

    json_data = {
        "timestamp": ts,
        "design": "Production 2-pass prompts, 5 cloud models + Ollama baseline",
        "aggregates": {label: agg for label, agg in aggs.items()},
        "results": results,
    }
    json_path = os.path.join(output_dir, f"production_prompts_{ts}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(json_data, f, indent=2, ensure_ascii=False, default=str)
    print(f"JSON: {json_path}")

    return md_path


# ===== MAIN =====

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("--commit", type=str)
    args = parser.parse_args()

    if not OPENROUTER_API_KEY:
        print("ERROR: OPENROUTER_API_KEY not set")
        sys.exit(1)

    repo = os.path.abspath(args.repo)
    cases = GT_CASES
    if args.commit:
        cases = [c for c in GT_CASES if c["sha"].startswith(args.commit)]
        if not cases:
            print(f"ERROR: commit {args.commit} not in GT_CASES")
            sys.exit(1)

    start = time.time()
    results = run_experiment(repo, cases, no_cache=args.no_cache, dry_run=args.dry_run)
    elapsed = time.time() - start

    print(f"\n{'='*70}")
    print(f"DONE — {elapsed/60:.1f} min")
    print(f"{'='*70}")

    if not args.dry_run:
        output_dir = os.path.join(os.path.dirname(__file__), "experiment_v3_results")
        md_path = generate_report(results, output_dir)

        # Quick summary
        for m in MODELS:
            mkey = m["id"].replace("/", "_").replace("-", "_").replace(".", "_")
            key = f"est_{mkey}"
            valid = [r for r in results if r.get(key) is not None]
            if valid:
                agg = compute_aggregate(valid, key)
                print(f"  {m['label']:20s}  MAPE={agg['mape']:.1f}%  in-range={agg['in_range']}/{agg['count']}")
