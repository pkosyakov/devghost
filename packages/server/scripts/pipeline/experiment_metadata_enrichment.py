"""
Metadata Enrichment Experiment — Does v3 metadata improve base model accuracy?

Tests whether adding holistic metadata (entropy, patterns, file categories) to
the standard diff-based estimation prompt improves accuracy of qwen3-coder:30b.

Design:
  A) Baseline: diff + basic stats → single estimation call (matches production pipeline)
  B) Enriched: diff + basic stats + v3 metadata block → single estimation call

20 commits × 2 variants = 40 LLM calls through local Ollama.

Usage:
    python experiment_metadata_enrichment.py --repo C:\\Projects\\_tmp_devghost_audit\\artisan-private
    python experiment_metadata_enrichment.py --repo ... --dry-run
    python experiment_metadata_enrichment.py --repo ... --commit a80e13df
"""

import re
import os
import sys
import json
import math
import time
import argparse
import statistics
from datetime import datetime

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
    _extract_json,
    _cache_key,
    _cache_path,
    read_cache,
    write_cache,
    CACHE_DIR,
    CALIBRATION,
    EXT_TO_LANG,
)


# ===== CONFIG =====

OLLAMA_URL = "http://localhost:11434"
OLLAMA_MODEL = "qwen3-coder:30b"

ESTIMATE_SCHEMA = {
    "type": "object",
    "properties": {
        "estimated_hours": {"type": "number"},
        "reasoning": {"type": "string"},
    },
    "required": ["estimated_hours", "reasoning"],
}

# 20 diverse normal-sized commits (3-30 files) from artisan-private with GT estimates
GT_CASES = [
    # --- Small fixes (3-5 files) ---
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

    # --- Small features (3-7 files) ---
    {"sha": "026ac924", "gt_low": 1, "gt_high": 2.5,
     "label": "feat: add credit deduction to admin test billing (5 files, +193/-15)"},
    {"sha": "07809e14", "gt_low": 0.5, "gt_high": 1.5,
     "label": "feat: skip LinkedIn steps when sender has no account (3 files, +127/-2)"},
    {"sha": "d674fef7", "gt_low": 0.5, "gt_high": 1.5,
     "label": "feat: inbox parsing optimisation (4 files, +117/-22)"},

    # --- Medium features (8-15 files) ---
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

    # --- Larger features (15-30 files) ---
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

    # --- Refactoring ---
    {"sha": "680dcb92", "gt_low": 3, "gt_high": 6,
     "label": "refactor: call tasks (21 files, +610/-274)"},
    {"sha": "a579d648", "gt_low": 2, "gt_high": 5,
     "label": "refactor: remove mocking from inbox APIs (29 files, +234/-2190)"},
]


# ===== PROMPTS =====

# System prompt — matches production PROMPT_2PASS_V2 + calibration context
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


def build_baseline_prompt(commit_data, diff):
    """Variant A: diff + basic stats (matches current production pipeline)."""
    msg = commit_data["message"]
    fc = commit_data["total_files"]
    la = commit_data["total_la"]
    ld = commit_data["total_ld"]

    return f"Commit: {msg}\nFiles: {fc}, +{la}/-{ld}\n\n{diff}\n\nEstimate hours:"


def build_enriched_prompt(commit_data, diff, v3_meta):
    """Variant B: diff + basic stats + v3 metadata block."""
    msg = commit_data["message"]
    fc = commit_data["total_files"]
    la = commit_data["total_la"]
    ld = commit_data["total_ld"]
    filter_result = commit_data["filter_result"]
    move_info = commit_data["move_info"]
    bulk_info = commit_data["bulk_info"]
    clusters = commit_data["clusters"]

    skip_count = filter_result["filter_stats"]["skip"]
    heuristic_count = filter_result["filter_stats"]["heuristic"]
    llm_count = filter_result["filter_stats"]["llm"]
    heur_total = filter_result["heuristic_total"]

    meta_lines = []
    meta_lines.append("== Commit Metadata ==")
    meta_lines.append(f"Commit: {msg}")
    meta_lines.append(f"Files: {fc}, +{la}/-{ld}")
    meta_lines.append("")

    # File tier breakdown
    meta_lines.append(f"File tiers: {skip_count} SKIP (generated/lock) | "
                      f"{heuristic_count} HEURISTIC (~{heur_total:.1f}h) | "
                      f"{llm_count} substantive code")
    meta_lines.append(f"Effective churn (code files only): +{v3_meta['effective_la']}/-{v3_meta['effective_ld']}")
    meta_lines.append("")

    # Distribution metrics
    meta_lines.append(f"Change entropy: {v3_meta['entropy']:.2f} bits ({v3_meta['entropy_label']})")
    meta_lines.append(f"File size distribution (lines): p50={v3_meta['file_size_p50']}, "
                      f"p90={v3_meta['file_size_p90']}, max={v3_meta['file_size_max']}")
    meta_lines.append(f"Module boundaries: {v3_meta['module_boundary_count']} "
                      f"({', '.join(v3_meta['modules'][:6])})")
    meta_lines.append("")

    # Pattern flags
    flags = []
    if move_info.get("is_move"):
        mt = move_info.get("move_type", "MOVE")
        pairs = len(move_info.get("pairs", []))
        overlap = move_info.get("avg_overlap", 0)
        flags.append(f"{mt}: {pairs} file pairs, avg_overlap={overlap:.0%}")
    if bulk_info.get("is_bulk"):
        br = bulk_info.get("bulk_ratio", 0)
        flags.append(f"BULK_REFACTOR: ratio={br:.0%}")

    if flags:
        meta_lines.append("Patterns: " + "; ".join(flags))
    else:
        meta_lines.append("Patterns: none detected")
    meta_lines.append("")

    # Structure
    if clusters:
        cluster_lines = []
        for c in clusters[:8]:
            name = c.get("name", "(root)")
            n = len(c.get("files", []))
            a = c.get("total_added", 0)
            d = c.get("total_deleted", 0)
            cluster_lines.append(f"  {name}: {n} files (+{a}/-{d})")
        meta_lines.append("Code structure:")
        meta_lines.extend(cluster_lines)
        meta_lines.append("")

    metadata_block = "\n".join(meta_lines)

    return f"{metadata_block}== Code Changes ==\n\n{diff}\n\nEstimate hours:"


# ===== OLLAMA API =====

def call_ollama(system, prompt, model=OLLAMA_MODEL, schema=None, no_cache=False):
    """Call local Ollama API. Returns (parsed, meta)."""
    cache_model = f"ollama-enrich/{model}"
    if not no_cache:
        cached = read_cache(system, prompt, cache_model, schema)
        if cached:
            resp, meta = cached
            meta["cache_hit"] = True
            return resp, meta

    system_content = system
    if schema:
        system_content += (
            f"\n\nYou MUST respond with ONLY valid JSON (no markdown, no extra text) "
            f"matching this schema:\n{json.dumps(schema)}"
        )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_content},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "options": {
            "temperature": 0,
            "num_predict": 512,
            "num_ctx": 32768,
            "seed": 42,
        },
    }

    url = f"{OLLAMA_URL}/api/chat"
    max_retries = 2
    last_error = None

    for attempt in range(max_retries + 1):
        start = time.time()
        try:
            import urllib.request
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            elapsed_ms = (time.time() - start) * 1000
            content = data.get("message", {}).get("content", "")
            text = re.sub(r'<think>[\s\S]*?</think>', '', content).strip()
            parsed = _extract_json(text) if schema else text

            if schema and parsed is None:
                last_error = f"Invalid JSON: {text[:200]}"
                if attempt < max_retries:
                    time.sleep(1)
                    continue
                return None, {"error": last_error, "elapsed_ms": elapsed_ms}

            meta = {
                "prompt_tokens": data.get("prompt_eval_count", 0),
                "completion_tokens": data.get("eval_count", 0),
                "elapsed_ms": elapsed_ms,
                "provider": "ollama",
                "cache_hit": False,
            }
            if not no_cache:
                write_cache(system, prompt, cache_model, parsed, meta, schema)
            return parsed, meta

        except Exception as e:
            elapsed_ms = (time.time() - start) * 1000
            last_error = str(e)
            if attempt < max_retries:
                time.sleep(2)
                continue

    return None, {"error": last_error, "elapsed_ms": 0}


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

def compute_aggregate(results, variant_key):
    """Compute aggregate metrics for one variant."""
    apes = []
    signed_errors = []
    in_range_count = 0
    total = 0

    for r in results:
        est = r.get(variant_key)
        if est is None:
            continue
        total += 1
        ape = compute_ape(est, r)
        se = compute_signed_error(est, r)
        apes.append(ape)
        signed_errors.append(se)
        if is_in_range(est, r):
            in_range_count += 1

    if not apes:
        return {}

    return {
        "count": total,
        "mape": statistics.mean(apes) * 100,
        "median_ape": statistics.median(apes) * 100,
        "in_range": in_range_count,
        "in_range_pct": in_range_count / total * 100,
        "mean_signed_error": statistics.mean(signed_errors) * 100,
        "mae": statistics.mean([abs(r[variant_key] - gt_midpoint(r))
                                for r in results if r.get(variant_key) is not None]),
    }


# ===== EXPERIMENT RUNNER =====

def run_experiment(repo, cases, no_cache=False, dry_run=False):
    """Run A/B experiment: baseline vs metadata-enriched estimation."""
    results = []

    print(f"\n{'='*70}")
    print(f"METADATA ENRICHMENT EXPERIMENT")
    print(f"Model: {OLLAMA_MODEL}")
    print(f"Commits: {len(cases)}")
    print(f"Variants: A (baseline diff) vs B (diff + v3 metadata)")
    print(f"Total LLM calls: {len(cases) * 2}")
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

        v3_meta = compute_v3_metadata(commit_data)

        # Get full diff for the prompt
        import subprocess
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
        diff_len = len(diff)

        print(f"  Files: {fc}, +{la}/-{ld}, diff: {diff_len//1000}K chars")
        print(f"  Metadata: entropy={v3_meta['entropy']:.2f} ({v3_meta['entropy_label']}), "
              f"modules={v3_meta['module_boundary_count']}, "
              f"effective_fc={v3_meta['effective_fc']}")

        if dry_run:
            results.append({**case, "fc": fc, "la": la, "ld": ld, "diff_chars": diff_len})
            continue

        # --- Variant A: Baseline (diff only) ---
        prompt_a = build_baseline_prompt(commit_data, diff)
        print(f"  A (baseline)...", end="", flush=True)
        result_a, meta_a = call_ollama(SYSTEM_PROMPT, prompt_a, schema=ESTIMATE_SCHEMA, no_cache=no_cache)
        est_a = result_a.get("estimated_hours") if result_a else None
        cache_a = meta_a.get("cache_hit", False)
        elapsed_a = meta_a.get("elapsed_ms", 0)

        if est_a is not None:
            ape_a = compute_ape(est_a, case) * 100
            in_a = "OK" if is_in_range(est_a, case) else "MISS"
            print(f" {est_a:.1f}h (APE={ape_a:.0f}%, {in_a}) "
                  f"[{elapsed_a/1000:.1f}s{'$' if cache_a else ''}]")
        else:
            print(f" FAILED: {meta_a.get('error', '?')[:60]}")

        # --- Variant B: Enriched (diff + metadata) ---
        prompt_b = build_enriched_prompt(commit_data, diff, v3_meta)
        print(f"  B (enriched)...", end="", flush=True)
        result_b, meta_b = call_ollama(SYSTEM_PROMPT, prompt_b, schema=ESTIMATE_SCHEMA, no_cache=no_cache)
        est_b = result_b.get("estimated_hours") if result_b else None
        cache_b = meta_b.get("cache_hit", False)
        elapsed_b = meta_b.get("elapsed_ms", 0)

        if est_b is not None:
            ape_b = compute_ape(est_b, case) * 100
            in_b = "OK" if is_in_range(est_b, case) else "MISS"
            print(f" {est_b:.1f}h (APE={ape_b:.0f}%, {in_b}) "
                  f"[{elapsed_b/1000:.1f}s{'$' if cache_b else ''}]")
        else:
            print(f" FAILED: {meta_b.get('error', '?')[:60]}")

        # Compare
        if est_a is not None and est_b is not None:
            delta = est_b - est_a
            better = "B" if compute_ape(est_b, case) < compute_ape(est_a, case) else "A" if compute_ape(est_a, case) < compute_ape(est_b, case) else "="
            print(f"  → delta={delta:+.1f}h, winner={better}")

        results.append({
            **case,
            "fc": fc, "la": la, "ld": ld, "diff_chars": diff_len,
            "est_a": est_a,
            "est_b": est_b,
            "reasoning_a": result_a.get("reasoning", "") if result_a else "",
            "reasoning_b": result_b.get("reasoning", "") if result_b else "",
            "elapsed_a_ms": elapsed_a,
            "elapsed_b_ms": elapsed_b,
            "cache_a": cache_a,
            "cache_b": cache_b,
            "meta_entropy": v3_meta["entropy"],
            "meta_entropy_label": v3_meta["entropy_label"],
            "meta_modules": v3_meta["module_boundary_count"],
            "meta_effective_fc": v3_meta["effective_fc"],
        })

    return results


# ===== REPORT GENERATION =====

def generate_report(results, output_dir):
    """Generate markdown + JSON reports."""
    ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    os.makedirs(output_dir, exist_ok=True)

    # Filter valid results
    valid = [r for r in results if r.get("est_a") is not None and r.get("est_b") is not None]

    if not valid:
        print("\nNo valid results to report.")
        return

    agg_a = compute_aggregate(valid, "est_a")
    agg_b = compute_aggregate(valid, "est_b")

    # Per-commit comparison
    a_wins = 0
    b_wins = 0
    ties = 0
    for r in valid:
        ape_a = compute_ape(r["est_a"], r)
        ape_b = compute_ape(r["est_b"], r)
        if ape_a < ape_b:
            a_wins += 1
        elif ape_b < ape_a:
            b_wins += 1
        else:
            ties += 1

    # --- Markdown report ---
    lines = []
    lines.append("# Metadata Enrichment Experiment Results")
    lines.append(f"\n**Date**: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"**Model**: {OLLAMA_MODEL}")
    lines.append(f"**Commits**: {len(valid)}")
    lines.append(f"**Design**: A (baseline diff) vs B (diff + v3 metadata)")
    lines.append("")

    lines.append("## Summary")
    lines.append("")
    lines.append("| Metric | A (baseline) | B (enriched) | Delta |")
    lines.append("|--------|-------------|-------------|-------|")

    def delta_str(a_val, b_val, lower_is_better=True):
        d = b_val - a_val
        if lower_is_better:
            arrow = "better" if d < 0 else "worse" if d > 0 else "same"
        else:
            arrow = "better" if d > 0 else "worse" if d < 0 else "same"
        return f"{d:+.1f} ({arrow})"

    lines.append(f"| MAPE | {agg_a['mape']:.1f}% | {agg_b['mape']:.1f}% | {delta_str(agg_a['mape'], agg_b['mape'])} |")
    lines.append(f"| Median APE | {agg_a['median_ape']:.1f}% | {agg_b['median_ape']:.1f}% | {delta_str(agg_a['median_ape'], agg_b['median_ape'])} |")
    lines.append(f"| MAE (hours) | {agg_a['mae']:.2f} | {agg_b['mae']:.2f} | {delta_str(agg_a['mae'], agg_b['mae'])} |")
    lines.append(f"| In-range | {agg_a['in_range']}/{agg_a['count']} ({agg_a['in_range_pct']:.0f}%) | {agg_b['in_range']}/{agg_b['count']} ({agg_b['in_range_pct']:.0f}%) | {delta_str(agg_a['in_range_pct'], agg_b['in_range_pct'], lower_is_better=False)} |")
    lines.append(f"| Mean signed error | {agg_a['mean_signed_error']:+.1f}% | {agg_b['mean_signed_error']:+.1f}% | |")
    lines.append(f"| Head-to-head | A wins: {a_wins} | B wins: {b_wins} | ties: {ties} |")
    lines.append("")

    # Verdict
    lines.append("## Verdict")
    lines.append("")
    if agg_b["mape"] < agg_a["mape"] - 3 and b_wins > a_wins:
        lines.append("**POSITIVE**: Metadata enrichment measurably improves estimation accuracy.")
        lines.append(f"MAPE drops by {agg_a['mape'] - agg_b['mape']:.1f}pp, B wins {b_wins}/{len(valid)} head-to-head.")
    elif abs(agg_b["mape"] - agg_a["mape"]) <= 3:
        lines.append("**NEUTRAL**: Metadata enrichment shows no significant impact on accuracy.")
        lines.append(f"MAPE difference is {abs(agg_b['mape'] - agg_a['mape']):.1f}pp (within noise margin).")
    else:
        lines.append("**NEGATIVE**: Metadata enrichment degrades estimation accuracy.")
        lines.append(f"MAPE increases by {agg_b['mape'] - agg_a['mape']:.1f}pp.")
    lines.append("")

    # Per-commit table
    lines.append("## Per-Commit Results")
    lines.append("")
    lines.append("| # | SHA | Files | GT | A (h) | B (h) | APE-A | APE-B | Winner |")
    lines.append("|---|-----|------:|---:|------:|------:|------:|------:|--------|")

    for i, r in enumerate(valid, 1):
        sha = r["sha"][:8]
        fc = r.get("fc", "?")
        gt = f"{r['gt_low']}-{r['gt_high']}"
        ea = r["est_a"]
        eb = r["est_b"]
        ape_a = compute_ape(ea, r) * 100
        ape_b = compute_ape(eb, r) * 100
        w = "B" if ape_b < ape_a else "A" if ape_a < ape_b else "="
        in_a = "**" if is_in_range(ea, r) else ""
        in_b = "**" if is_in_range(eb, r) else ""
        lines.append(f"| {i} | {sha} | {fc} | {gt} | {in_a}{ea:.1f}{in_a} | {in_b}{eb:.1f}{in_b} | {ape_a:.0f}% | {ape_b:.0f}% | {w} |")

    lines.append("")
    lines.append("*Bold* estimates are within GT range.")
    lines.append("")

    # Breakdown by commit size
    lines.append("## Breakdown by Commit Size")
    lines.append("")

    size_buckets = {
        "Small (3-7 files)": [r for r in valid if r.get("fc", 0) <= 7],
        "Medium (8-15 files)": [r for r in valid if 8 <= r.get("fc", 0) <= 15],
        "Large (16-30 files)": [r for r in valid if r.get("fc", 0) >= 16],
    }

    lines.append("| Size | Count | MAPE-A | MAPE-B | Winner |")
    lines.append("|------|------:|-------:|-------:|--------|")
    for name, bucket in size_buckets.items():
        if not bucket:
            continue
        agg_a_b = compute_aggregate(bucket, "est_a")
        agg_b_b = compute_aggregate(bucket, "est_b")
        w = "B" if agg_b_b["mape"] < agg_a_b["mape"] else "A" if agg_a_b["mape"] < agg_b_b["mape"] else "="
        lines.append(f"| {name} | {len(bucket)} | {agg_a_b['mape']:.1f}% | {agg_b_b['mape']:.1f}% | {w} |")
    lines.append("")

    # Reasoning samples (first 5)
    lines.append("## Sample Reasoning (first 5)")
    lines.append("")
    for r in valid[:5]:
        lines.append(f"### {r['sha'][:8]} — {r['label'][:60]}")
        lines.append(f"- **A**: {r.get('reasoning_a', '')[:200]}")
        lines.append(f"- **B**: {r.get('reasoning_b', '')[:200]}")
        lines.append("")

    md_path = os.path.join(output_dir, f"experiment_enrichment_{ts}.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"\nMarkdown report: {md_path}")

    # --- JSON report ---
    json_data = {
        "timestamp": ts,
        "model": OLLAMA_MODEL,
        "design": "A (baseline diff) vs B (diff + v3 metadata)",
        "summary": {
            "variant_a": agg_a,
            "variant_b": agg_b,
            "a_wins": a_wins,
            "b_wins": b_wins,
            "ties": ties,
        },
        "results": results,
    }
    json_path = os.path.join(output_dir, f"experiment_enrichment_{ts}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(json_data, f, indent=2, ensure_ascii=False, default=str)
    print(f"JSON report: {json_path}")

    return md_path, json_path


# ===== MAIN =====

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Metadata enrichment A/B experiment")
    parser.add_argument("--repo", required=True, help="Path to git repository")
    parser.add_argument("--dry-run", action="store_true", help="Extract data only, no LLM calls")
    parser.add_argument("--no-cache", action="store_true", help="Disable LLM cache")
    parser.add_argument("--commit", type=str, help="Run single commit only (for debugging)")
    args = parser.parse_args()

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
    results = run_experiment(repo, cases, no_cache=args.no_cache, dry_run=args.dry_run)
    elapsed = time.time() - start_time

    print(f"\n{'='*70}")
    print(f"EXPERIMENT COMPLETE — {elapsed/60:.1f} minutes")
    print(f"{'='*70}")

    if not args.dry_run:
        output_dir = os.path.join(os.path.dirname(__file__), "experiment_v3_results")
        generate_report(results, output_dir)

        # Quick summary
        valid = [r for r in results if r.get("est_a") is not None and r.get("est_b") is not None]
        if valid:
            agg_a = compute_aggregate(valid, "est_a")
            agg_b = compute_aggregate(valid, "est_b")
            print(f"\n  A (baseline):  MAPE={agg_a['mape']:.1f}%  in-range={agg_a['in_range']}/{agg_a['count']}")
            print(f"  B (enriched):  MAPE={agg_b['mape']:.1f}%  in-range={agg_b['in_range']}/{agg_b['count']}")
            diff_mape = agg_b["mape"] - agg_a["mape"]
            if diff_mape < -3:
                print(f"\n  RESULT: Metadata enrichment HELPS (MAPE {diff_mape:+.1f}pp)")
            elif diff_mape > 3:
                print(f"\n  RESULT: Metadata enrichment HURTS (MAPE {diff_mape:+.1f}pp)")
            else:
                print(f"\n  RESULT: No significant difference (MAPE {diff_mape:+.1f}pp)")
