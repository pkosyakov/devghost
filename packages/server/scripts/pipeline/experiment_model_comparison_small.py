"""
Model Comparison Experiment — Small Commits (3-30 files).

Compares 5 OpenRouter models + local Ollama baseline on the same 20 commits
to determine if the base model (qwen3-coder:30b) should be replaced.

Models:
  1. qwen/qwen3-coder            (baseline cloud equivalent)
  2. qwen/qwen3-coder-next       (next-gen)
  3. openai/gpt-5.1-codex-mini   (OpenAI small coder)
  4. qwen/qwen3-coder-flash      (fast variant)
  5. qwen/qwen3-coder-plus       (premium variant)
  6. ollama/qwen3-coder:30b       (local baseline, from previous experiment)

Design: 20 commits × 5 cloud models = 100 OpenRouter calls.
Ollama results are loaded from the enrichment experiment cache (variant A).

Usage:
    python experiment_model_comparison_small.py --repo C:\\Projects\\_tmp_devghost_audit\\artisan-private
    python experiment_model_comparison_small.py --repo ... --dry-run
    python experiment_model_comparison_small.py --repo ... --commit a80e13df
"""

import re
import os
import sys
import json
import math
import time
import random
import hashlib
import argparse
import statistics
import subprocess
from datetime import datetime
from collections import defaultdict

sys.stdout.reconfigure(encoding="utf-8")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from file_decomposition import (
    classify_file_regex,
    adaptive_filter,
    build_clusters,
    classify_move_commit,
    detect_bulk_refactoring,
    split_diff_by_file,
    parse_file_stat,
)

from experiment_v3 import (
    extract_commit_data,
    compute_v3_metadata,
    call_openrouter,
    _extract_json,
    read_cache,
    write_cache,
    CACHE_DIR,
)


# ===== CONFIG =====

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
if not OPENROUTER_API_KEY:
    # Try loading from .env
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
    {"id": "qwen/qwen3-coder-next", "label": "Qwen3 Coder Next"},
    {"id": "openai/gpt-5.1-codex-mini", "label": "GPT-5.1 Codex Mini"},
    {"id": "qwen/qwen3-coder-flash", "label": "Qwen3 Coder Flash"},
    {"id": "qwen/qwen3-coder-plus", "label": "Qwen3 Coder+"},
]

ESTIMATE_SCHEMA = {
    "type": "object",
    "properties": {
        "estimated_hours": {"type": "number"},
        "reasoning": {"type": "string"},
    },
    "required": ["estimated_hours", "reasoning"],
    "additionalProperties": False,
}

# Same 20 commits as the enrichment experiment
GT_CASES = [
    {"sha": "f4805502", "gt_low": 0.5, "gt_high": 1.5,
     "label": "fix: make phone enrichment conditional on dialer steps (3 files, +109/-88)"},
    {"sha": "cd320b77", "gt_low": 0.3, "gt_high": 1,
     "label": "fix: cooldown guard to prevent auto-save overwriting (3 files, +45/-17)"},
    {"sha": "cba942fb", "gt_low": 0.3, "gt_high": 0.8,
     "label": "fix: infinite re-render loop on prospector results (3 files, +20/-8)"},
    {"sha": "f63a460b", "gt_low": 0.3, "gt_high": 0.8,
     "label": "fix: add 200k contact limit for list actions (5 files, +26/-9)"},
    {"sha": "082eaf12", "gt_low": 0.5, "gt_high": 1.5,
     "label": "fix: pool seeding VARCHAR overflow + monthly lead quota (4 files, +84/-17)"},
    {"sha": "026ac924", "gt_low": 1, "gt_high": 2.5,
     "label": "feat: add credit deduction to admin test billing (5 files, +193/-15)"},
    {"sha": "07809e14", "gt_low": 0.5, "gt_high": 1.5,
     "label": "feat: skip LinkedIn steps when sender has no account (3 files, +127/-2)"},
    {"sha": "d674fef7", "gt_low": 0.5, "gt_high": 1.5,
     "label": "feat: inbox parsing optimisation (4 files, +117/-22)"},
    {"sha": "57251337", "gt_low": 2, "gt_high": 5,
     "label": "feat: Datadog observability metrics for billing (10 files, +271/-23)"},
    {"sha": "b6d87eae", "gt_low": 2, "gt_high": 4,
     "label": "feat: improve prospector contact relevance scoring (9 files, +372/-17)"},
    {"sha": "f82dd9d0", "gt_low": 1.5, "gt_high": 3.5,
     "label": "feat: wire inbox reply composer signature (10 files, +195/-24)"},
    {"sha": "16b88e6a", "gt_low": 2, "gt_high": 5,
     "label": "feat: campaign list DNC (10 files, +643/-155)"},
    {"sha": "4544aacc", "gt_low": 1, "gt_high": 2.5,
     "label": "fix: script URL derivation and domain verification (9 files, +99/-53)"},
    {"sha": "37ce974c", "gt_low": 4, "gt_high": 8,
     "label": "feat: primary mailbox reconnection flow (28 files, +1469/-152)"},
    {"sha": "679ac18e", "gt_low": 2, "gt_high": 5,
     "label": "feat: campaign ui + credit ui change in sidebar (25 files, +254/-162)"},
    {"sha": "82e02c56", "gt_low": 4, "gt_high": 8,
     "label": "feat: added property mapping for crm (25 files, +1955/-12)"},
    {"sha": "a84b7843", "gt_low": 4, "gt_high": 9,
     "label": "feat: credit UI indicators, cost breakdown, runway timeline (20 files, +1344/-66)"},
    {"sha": "ef323c98", "gt_low": 3, "gt_high": 7,
     "label": "perf: speed up magic campaign generation (20 files, +383/-324)"},
    {"sha": "680dcb92", "gt_low": 3, "gt_high": 6,
     "label": "refactor: call tasks (21 files, +610/-274)"},
    {"sha": "a579d648", "gt_low": 2, "gt_high": 5,
     "label": "refactor: remove mocking from inbox APIs (29 files, +234/-2190)"},
]


# ===== PROMPTS =====

SYSTEM_PROMPT = """Estimate total hours for this TypeScript commit as a middle dev (3-4yr experience, knows codebase).

EFFORT SCALE:
- Trivial fix (typo, config tweak, 1-3 files): 0.1-0.5h
- Small fix/feature (3-7 files, focused change): 0.5-3h
- Medium feature (8-15 files, multi-module): 2-8h
- Large feature (15-30 files, significant new functionality): 4-16h
- Refactoring (code moves, renames, restructuring): usually 20-50% of "from scratch" effort

IMPORTANT:
- Mechanical changes (renames, imports, formatting, moving code) take minimal effort
- Auto-generated files, lock files, snapshots = 0h
- Tests that mirror implementation = 30-50% of production code effort
- Config files = quick edits (0.1-0.3h each)
- Bulk find-replace across N files = 1 task (0.5-2h total), NOT N separate tasks

Includes: writing code, debugging, manual testing.
Not included: code review, meetings, CI/CD waiting."""


def build_prompt(commit_data, diff):
    """Build estimation prompt with diff + basic stats."""
    msg = commit_data["message"]
    fc = commit_data["total_files"]
    la = commit_data["total_la"]
    ld = commit_data["total_ld"]
    return f"Commit: {msg}\nFiles: {fc}, +{la}/-{ld}\n\n{diff}\n\nEstimate hours:"


# ===== METRICS =====

def gt_midpoint(case):
    return (case["gt_low"] + case["gt_high"]) / 2

def is_in_range(estimate, case):
    return case["gt_low"] <= estimate <= case["gt_high"]

def compute_ape(estimate, case):
    mid = gt_midpoint(case)
    return abs(estimate - mid) / mid if mid > 0 else 0

def compute_signed_error(estimate, case):
    mid = gt_midpoint(case)
    return (estimate - mid) / mid if mid > 0 else 0

def compute_aggregate(results, key):
    """Compute aggregate metrics for one model."""
    apes = []
    signed_errors = []
    in_range_count = 0
    total = 0

    for r in results:
        est = r.get(key)
        if est is None:
            continue
        total += 1
        apes.append(compute_ape(est, r))
        signed_errors.append(compute_signed_error(est, r))
        if is_in_range(est, r):
            in_range_count += 1

    if not apes:
        return {"count": 0}

    return {
        "count": total,
        "mape": statistics.mean(apes) * 100,
        "median_ape": statistics.median(apes) * 100,
        "in_range": in_range_count,
        "in_range_pct": in_range_count / total * 100,
        "mean_signed_error": statistics.mean(signed_errors) * 100,
        "mae": statistics.mean([abs(r[key] - gt_midpoint(r)) for r in results if r.get(key) is not None]),
    }


# ===== EXPERIMENT RUNNER =====

def run_experiment(repo, cases, no_cache=False, dry_run=False):
    """Run 5-model comparison on 20 small commits."""
    results = []
    total_cost = defaultdict(float)

    print(f"\n{'='*70}")
    print(f"MODEL COMPARISON — SMALL COMMITS")
    print(f"Models: {len(MODELS)}")
    print(f"Commits: {len(cases)}")
    print(f"Total OpenRouter calls: {len(cases) * len(MODELS)}")
    print(f"Cache: {'disabled' if no_cache else 'enabled'}")
    print(f"{'='*70}\n")

    for i, case in enumerate(cases, 1):
        sha = case["sha"]
        gt_mid = gt_midpoint(case)

        print(f"\n[{i}/{len(cases)}] {sha[:8]} — GT: {case['gt_low']}-{case['gt_high']}h (mid={gt_mid:.1f}h)")
        print(f"  {case['label']}")

        # Extract commit data
        try:
            commit_data = extract_commit_data(repo, sha)
        except Exception as e:
            print(f"  ERROR extracting commit: {e}")
            results.append({**case, "error": str(e)})
            continue

        # Get full diff
        parent = commit_data.get("parent")
        if parent:
            diff = subprocess.run(
                ["git", "diff", f"{parent}..{sha}"],
                cwd=repo, capture_output=True, encoding="utf-8", errors="replace",
            ).stdout
        else:
            diff = subprocess.run(
                ["git", "diff", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", sha],
                cwd=repo, capture_output=True, encoding="utf-8", errors="replace",
            ).stdout

        fc = commit_data["total_files"]
        la = commit_data["total_la"]
        ld = commit_data["total_ld"]

        prompt = build_prompt(commit_data, diff)
        row = {**case, "fc": fc, "la": la, "ld": ld, "diff_chars": len(diff)}

        if dry_run:
            results.append(row)
            continue

        # Run each model
        for model in MODELS:
            mid = model["id"]
            label = model["label"]
            key = f"est_{mid.replace('/', '_').replace('-', '_').replace('.', '_')}"

            print(f"  {label}...", end="", flush=True)

            try:
                parsed, meta = call_openrouter(
                    SYSTEM_PROMPT, prompt, mid, OPENROUTER_API_KEY,
                    schema=ESTIMATE_SCHEMA, no_cache=no_cache,
                )
            except Exception as e:
                print(f" ERROR: {e}")
                row[key] = None
                row[f"reasoning_{key}"] = str(e)
                continue

            est = parsed.get("estimated_hours") if parsed else None
            cache_hit = meta.get("cache_hit", False)
            elapsed = meta.get("elapsed_ms", 0)

            if est is not None:
                ape = compute_ape(est, case) * 100
                in_r = "OK" if is_in_range(est, case) else "MISS"
                print(f" {est:.1f}h (APE={ape:.0f}%, {in_r}) [{elapsed/1000:.1f}s{'$' if cache_hit else ''}]")
                row[key] = est
                row[f"reasoning_{key}"] = parsed.get("reasoning", "") if parsed else ""

                # Track cost
                pt = meta.get("prompt_tokens", 0)
                ct = meta.get("completion_tokens", 0)
                # Rough cost estimation (varies by model)
                cost = (pt * 0.5 + ct * 1.5) / 1_000_000  # conservative estimate
                total_cost[mid] += cost
            else:
                err = meta.get("error", "?")[:80]
                print(f" FAILED: {err}")
                row[key] = None
                row[f"reasoning_{key}"] = err

        results.append(row)

    return results, dict(total_cost)


# ===== REPORT GENERATION =====

def generate_report(results, costs, output_dir):
    """Generate markdown + JSON reports."""
    ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    os.makedirs(output_dir, exist_ok=True)

    model_keys = []
    for m in MODELS:
        key = f"est_{m['id'].replace('/', '_').replace('-', '_').replace('.', '_')}"
        model_keys.append((m["id"], m["label"], key))

    # Add Ollama baseline from enrichment experiment cache
    ollama_key = "est_ollama_baseline"
    # Load Ollama results from the enrichment experiment JSON
    enrichment_dir = os.path.join(os.path.dirname(__file__), "experiment_v3_results")
    ollama_results = {}
    for fname in sorted(os.listdir(enrichment_dir)):
        if fname.startswith("experiment_enrichment_") and fname.endswith(".json"):
            fpath = os.path.join(enrichment_dir, fname)
            with open(fpath, "r", encoding="utf-8") as f:
                edata = json.load(f)
            for r in edata.get("results", []):
                if r.get("est_a") is not None:
                    ollama_results[r["sha"]] = r["est_a"]

    # Inject Ollama baseline into results
    for r in results:
        r[ollama_key] = ollama_results.get(r["sha"])

    all_model_keys = [("ollama/qwen3-coder:30b", "Ollama (local)", ollama_key)] + model_keys

    # Compute aggregates
    aggregates = {}
    for mid, label, key in all_model_keys:
        valid = [r for r in results if r.get(key) is not None]
        if valid:
            aggregates[mid] = compute_aggregate(valid, key)
            aggregates[mid]["label"] = label
        else:
            aggregates[mid] = {"count": 0, "label": label}

    # Sort by MAPE
    ranked = sorted(
        [(mid, agg) for mid, agg in aggregates.items() if agg.get("count", 0) > 0],
        key=lambda x: x[1]["mape"],
    )

    # --- Markdown report ---
    lines = []
    lines.append("# Model Comparison — Small Commits (3-30 files)")
    lines.append(f"\n**Date**: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"**Commits**: {len(results)}")
    lines.append(f"**Design**: Same 20 commits, same prompt, 6 models (5 cloud + 1 local)")
    lines.append("")

    # Summary table
    lines.append("## Model Rankings")
    lines.append("")
    lines.append("| # | Model | MAPE | Median APE | MAE (h) | In-range | Bias |")
    lines.append("|---|-------|-----:|----------:|--------:|---------:|-----:|")

    for rank, (mid, agg) in enumerate(ranked, 1):
        label = agg["label"]
        mape = f"{agg['mape']:.1f}%"
        med = f"{agg['median_ape']:.1f}%"
        mae = f"{agg['mae']:.2f}"
        inr = f"{agg['in_range']}/{agg['count']} ({agg['in_range_pct']:.0f}%)"
        bias = f"{agg['mean_signed_error']:+.0f}%"
        lines.append(f"| {rank} | {label} | {mape} | {med} | {mae} | {inr} | {bias} |")
    lines.append("")

    # Breakdown by commit size
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
        lines.append("| Model | MAPE | In-range | MAE (h) |")
        lines.append("|-------|-----:|---------:|--------:|")

        bucket_ranks = []
        for mid, label, key in all_model_keys:
            valid = [r for r in bucket if r.get(key) is not None]
            if valid:
                agg = compute_aggregate(valid, key)
                bucket_ranks.append((label, agg))

        bucket_ranks.sort(key=lambda x: x[1].get("mape", 999))
        for label, agg in bucket_ranks:
            lines.append(f"| {label} | {agg['mape']:.1f}% | {agg['in_range']}/{agg['count']} | {agg['mae']:.2f} |")
        lines.append("")

    # Per-commit detail table
    lines.append("## Per-Commit Estimates")
    lines.append("")
    header = "| # | SHA | Files | GT |"
    sep = "|---|-----|------:|---:|"
    for _, label, _ in all_model_keys:
        short = label[:12]
        header += f" {short} |"
        sep += f"---:|"
    lines.append(header)
    lines.append(sep)

    for i, r in enumerate(results, 1):
        sha = r["sha"][:8]
        fc = r.get("fc", "?")
        gt = f"{r['gt_low']}-{r['gt_high']}"
        row_str = f"| {i} | {sha} | {fc} | {gt} |"
        for _, _, key in all_model_keys:
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

    # Cost summary
    if costs:
        lines.append("## Cost Estimate")
        lines.append("")
        lines.append("| Model | Est. Cost |")
        lines.append("|-------|-------:|")
        for mid, cost in sorted(costs.items(), key=lambda x: x[1]):
            lines.append(f"| {mid} | ${cost:.4f} |")
        lines.append("")

    md_path = os.path.join(output_dir, f"model_comparison_small_{ts}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\nMarkdown report: {md_path}")

    # --- JSON report ---
    json_data = {
        "timestamp": ts,
        "design": "5 cloud models + 1 local baseline on 20 small commits",
        "models": [m["id"] for m in MODELS] + ["ollama/qwen3-coder:30b"],
        "aggregates": {mid: agg for mid, agg in aggregates.items()},
        "costs": costs,
        "results": results,
    }
    json_path = os.path.join(output_dir, f"model_comparison_small_{ts}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(json_data, f, indent=2, ensure_ascii=False, default=str)
    print(f"JSON report: {json_path}")

    return md_path, json_path


# ===== MAIN =====

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Model comparison on small commits")
    parser.add_argument("--repo", required=True, help="Path to git repository")
    parser.add_argument("--dry-run", action="store_true", help="Extract data only, no LLM calls")
    parser.add_argument("--no-cache", action="store_true", help="Disable LLM cache")
    parser.add_argument("--commit", type=str, help="Run single commit only (for debugging)")
    args = parser.parse_args()

    if not OPENROUTER_API_KEY:
        print("ERROR: OPENROUTER_API_KEY not set")
        sys.exit(1)

    repo = os.path.abspath(args.repo)
    if not os.path.isdir(os.path.join(repo, ".git")):
        print(f"ERROR: {repo} is not a git repository")
        sys.exit(1)

    cases = GT_CASES
    if args.commit:
        cases = [c for c in GT_CASES if c["sha"].startswith(args.commit)]
        if not cases:
            print(f"ERROR: commit {args.commit} not found in GT_CASES")
            sys.exit(1)

    start_time = time.time()
    results, costs = run_experiment(repo, cases, no_cache=args.no_cache, dry_run=args.dry_run)
    elapsed = time.time() - start_time

    print(f"\n{'='*70}")
    print(f"EXPERIMENT COMPLETE — {elapsed/60:.1f} minutes")
    print(f"{'='*70}")

    if not args.dry_run:
        output_dir = os.path.join(os.path.dirname(__file__), "experiment_v3_results")
        generate_report(results, costs, output_dir)
