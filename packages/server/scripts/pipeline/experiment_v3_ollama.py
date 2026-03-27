"""
FD v3 Holistic Estimation — Ollama Baseline Experiment.

Tests whether v3 metadata-only holistic prompts work with the local Ollama
model (qwen3-coder:30b) on normal-sized commits (3-30 files).

Compares:
  A) Heuristic-only baseline (adaptive_filter heuristic_total, zero LLM calls)
  B) V3 holistic metadata-only single LLM call through local Ollama

Usage:
    python experiment_v3_ollama.py --repo C:\\Projects\\_tmp_devghost_audit\\artisan-private
    python experiment_v3_ollama.py --repo ... --dry-run
    python experiment_v3_ollama.py --repo ... --commit a80e13df
"""

import re
import os
import sys
import json
import math
import time
import hashlib
import argparse
import subprocess
import statistics
from collections import Counter
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

# Reuse v3 functions from the OpenRouter experiment
from experiment_v3 import (
    extract_commit_data,
    compute_v3_metadata,
    build_system_prompt,
    build_v3_prompt,
    V3_SCHEMA,
    CALIBRATION,
    _extract_json,
    _cache_key,
    _cache_path,
    read_cache,
    write_cache,
    CACHE_DIR,
)

# ===== CONFIG =====

OLLAMA_URL = "http://localhost:11434"
OLLAMA_MODEL = "qwen3-coder:30b"

# 50 normal-sized commits (3-30 files) from artisan-private
# GT estimated by analyzing commit metadata: message, file count, lines changed,
# file types, and change patterns. Methodology:
#   - fix (3-5 files, <100 lines): 0.5-2h
#   - fix (5-10 files, config+code): 1-4h
#   - small feat (3-7 files, <500 lines): 1-4h
#   - medium feat (8-15 files, 200-800 lines): 2-8h
#   - large feat (15-30 files, 500-2000 lines): 4-16h
#   - refactor (10-30 files, restructuring): 3-12h
#   - UI feature (10-25 files, components+pages): 3-12h
#   - perf optimization (5-20 files): 2-8h
#   - migration/infra (10-30 files, bulk changes): 2-8h
GT_CASES = [
    # --- Billing / API fixes ---
    {"sha": "a80e13df", "gt_low": 3, "gt_high": 6,
     "label": "fix: billing runway list-size capping and alert sync (12 files, +1166/-45)"},
    {"sha": "7a1ea8f9", "gt_low": 0.5, "gt_high": 1.5,
     "label": "fix: include recurring_credits in credit runway (4 files, +206/-8)"},
    {"sha": "f4805502", "gt_low": 0.5, "gt_high": 1.5,
     "label": "fix: make phone enrichment conditional on dialer steps (3 files, +109/-88)"},
    {"sha": "026ac924", "gt_low": 1, "gt_high": 2.5,
     "label": "feat: add credit deduction to admin test billing (5 files, +193/-15)"},
    {"sha": "57251337", "gt_low": 2, "gt_high": 5,
     "label": "feat: Datadog observability metrics for billing (10 files, +271/-23)"},

    # --- Search / entities ---
    {"sha": "6f4b6816", "gt_low": 1.5, "gt_high": 3.5,
     "label": "feat: group similar industry sectors (6 files, +722/-58)"},
    {"sha": "b6d87eae", "gt_low": 2, "gt_high": 4,
     "label": "feat: improve prospector contact relevance scoring (9 files, +372/-17)"},
    {"sha": "53edfeed", "gt_low": 0.5, "gt_high": 1.5,
     "label": "fix: location filter queries for keyword fields (3 files, +98/-115)"},
    {"sha": "094bd63e", "gt_low": 0.3, "gt_high": 1,
     "label": "fix: industries exclusion filter and cap metadata query (3 files, +13/-9)"},
    {"sha": "a70819e3", "gt_low": 2, "gt_high": 5,
     "label": "fix: prospector 500s (10 files, +261/-190)"},

    # --- Messaging / inbox ---
    {"sha": "37ce974c", "gt_low": 4, "gt_high": 8,
     "label": "feat: primary mailbox reconnection flow (28 files, +1469/-152)"},
    {"sha": "a4975a1e", "gt_low": 4, "gt_high": 8,
     "label": "feat: rework messaging (29 files, +1137/-218)"},
    {"sha": "d674fef7", "gt_low": 0.5, "gt_high": 1.5,
     "label": "feat: inbox parsing optimisation (4 files, +117/-22)"},
    {"sha": "56ed3148", "gt_low": 2, "gt_high": 5,
     "label": "feat: linkedin specific inbox changes (13 files, +522/-151)"},
    {"sha": "f82dd9d0", "gt_low": 1.5, "gt_high": 3.5,
     "label": "feat: wire inbox reply composer signature (10 files, +195/-24)"},

    # --- Campaigns / signals ---
    {"sha": "654df77f", "gt_low": 1.5, "gt_high": 4,
     "label": "fix: campaign signal targeting bugs, panel backgrounds (13 files, +562/-46)"},
    {"sha": "ccbc8586", "gt_low": 3, "gt_high": 6,
     "label": "feat: enhance campaign signal targeting + observability (11 files, +711/-173)"},
    {"sha": "9b1a0414", "gt_low": 3, "gt_high": 6,
     "label": "refactor: move company include guardrails to clause-budget (13 files, +613/-103)"},
    {"sha": "16b88e6a", "gt_low": 2, "gt_high": 5,
     "label": "feat: campaign list DNC (10 files, +643/-155)"},
    {"sha": "b7445f33", "gt_low": 1.5, "gt_high": 3.5,
     "label": "feat: added loader for campaign analytics (11 files, +347/-46)"},

    # --- UI features ---
    {"sha": "679ac18e", "gt_low": 2, "gt_high": 5,
     "label": "feat: campaign ui + credit ui change in sidebar (25 files, +254/-162)"},
    {"sha": "c19e1eda", "gt_low": 3, "gt_high": 7,
     "label": "feat: added slack integration page ui (21 files, +794/-173)"},
    {"sha": "7d50de03", "gt_low": 1, "gt_high": 2.5,
     "label": "feat: added improvement in ui states (7 files, +144/-178)"},
    {"sha": "5372c184", "gt_low": 2, "gt_high": 5,
     "label": "feat: chat with ava and sidebar changes (14 files, +391/-326)"},
    {"sha": "2c27791f", "gt_low": 1.5, "gt_high": 4,
     "label": "feat: sidebar ava bubble (15 files, +269/-22)"},

    # --- CRM / integrations ---
    {"sha": "82e02c56", "gt_low": 4, "gt_high": 8,
     "label": "feat: added property mapping for crm (25 files, +1955/-12)"},
    {"sha": "4506a789", "gt_low": 4, "gt_high": 8,
     "label": "feat: status mapping tab crm (30 files, +1247/-500)"},
    {"sha": "cd8d13e4", "gt_low": 2, "gt_high": 5,
     "label": "feat: added owner mapping tab for crm (9 files, +610/-6)"},
    {"sha": "5400de5e", "gt_low": 3, "gt_high": 6,
     "label": "adhoc: Crunchbase poller split processed ID (11 files, +831/-229)"},
    {"sha": "6a74f561", "gt_low": 2, "gt_high": 5,
     "label": "feat: add customer URL extraction (13 files, +251/-10)"},

    # --- Billing UI ---
    {"sha": "a84b7843", "gt_low": 4, "gt_high": 9,
     "label": "feat: credit UI indicators, cost breakdown, runway timeline (20 files, +1344/-66)"},
    {"sha": "241dc98f", "gt_low": 2, "gt_high": 5,
     "label": "feat: deliverability health/capacity + credits tab (7 files, +811/-77)"},

    # --- Performance ---
    {"sha": "ef323c98", "gt_low": 3, "gt_high": 7,
     "label": "perf: speed up magic campaign generation (20 files, +383/-324)"},

    # --- Refactoring ---
    {"sha": "680dcb92", "gt_low": 3, "gt_high": 6,
     "label": "refactor: call tasks (21 files, +610/-274)"},
    {"sha": "a579d648", "gt_low": 2, "gt_high": 5,
     "label": "refactor: remove mocking from inbox APIs (29 files, +234/-2190)"},
    {"sha": "6702abfd", "gt_low": 2, "gt_high": 5,
     "label": "feat: migrate CSV upload from flex tables to leads lists (23 files, +255/-616)"},
    {"sha": "08f97b19", "gt_low": 2, "gt_high": 4,
     "label": "fix: enrichments and make primary (24 files, +233/-76)"},

    # --- Misc features ---
    {"sha": "0eb27211", "gt_low": 1, "gt_high": 3,
     "label": "feat: basic support for local business CSV (16 files, +164/-43)"},
    {"sha": "41780127", "gt_low": 1, "gt_high": 3,
     "label": "feat: thread-level filtering + exclude Ampersand (4 files, +364/-51)"},
    {"sha": "601a94e7", "gt_low": 1.5, "gt_high": 3.5,
     "label": "fix: observability improvements and data fixes (10 files, +195/-60)"},
    {"sha": "cd320b77", "gt_low": 0.3, "gt_high": 1,
     "label": "fix: cooldown guard to prevent auto-save overwriting (3 files, +45/-17)"},
    {"sha": "cba942fb", "gt_low": 0.3, "gt_high": 0.8,
     "label": "fix: infinite re-render loop on prospector results (3 files, +20/-8)"},
    {"sha": "5aa5099b", "gt_low": 0.3, "gt_high": 1,
     "label": "fix: FullEnrich v2 response serialization failure (3 files, +38/-14)"},
    {"sha": "f63a460b", "gt_low": 0.3, "gt_high": 0.8,
     "label": "fix: add 200k contact limit for list actions (5 files, +26/-9)"},
    {"sha": "6ada2b20", "gt_low": 0.3, "gt_high": 0.8,
     "label": "fix: prevent adding all contacts to list without filters (5 files, +30/-17)"},
    {"sha": "4544aacc", "gt_low": 1, "gt_high": 2.5,
     "label": "fix: script URL derivation and domain verification (9 files, +99/-53)"},
    {"sha": "49aa81b8", "gt_low": 1.5, "gt_high": 3.5,
     "label": "feat: dev-only admin page for test billing setup (6 files, +428/-0)"},
    {"sha": "d6619670", "gt_low": 1, "gt_high": 3,
     "label": "fix: updated add domain logic (8 files, +253/-21)"},
    {"sha": "015c876a", "gt_low": 0.5, "gt_high": 1.5,
     "label": "fix: auto-add all org members as senders (7 files, +53/-4)"},
    {"sha": "3bb4373c", "gt_low": 1, "gt_high": 2.5,
     "label": "feat: add estimated row count to leads lists (12 files, +96/-37)"},
    {"sha": "082eaf12", "gt_low": 0.5, "gt_high": 1.5,
     "label": "fix: pool seeding VARCHAR overflow + monthly lead quota (4 files, +84/-17)"},

    # --- Additional ---
    {"sha": "26a198f2", "gt_low": 3, "gt_high": 6,
     "label": "feat: batch lead list population with _doc sort (13 files, +807/-85)"},
    {"sha": "59003b6e", "gt_low": 0.5, "gt_high": 1.5,
     "label": "fix: prospector table column resizing + render warnings (8 files, +50/-68)"},
    {"sha": "e2450463", "gt_low": 0.5, "gt_high": 1.5,
     "label": "fix: preview list eye icon + improve query performance (5 files, +44/-13)"},
    {"sha": "07809e14", "gt_low": 0.5, "gt_high": 1.5,
     "label": "feat: skip LinkedIn steps when sender has no account (3 files, +127/-2)"},
]


# ===== OLLAMA API =====

def call_ollama(system, prompt, model=OLLAMA_MODEL, schema=None, no_cache=False):
    """Call local Ollama API. Returns (parsed, meta)."""
    cache_model = f"ollama/{model}"
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
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = json.loads(resp.read().decode("utf-8"))

            elapsed_ms = (time.time() - start) * 1000
            content = data.get("message", {}).get("content", "")
            # Strip <think> tags from reasoning models
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


# ===== EXPERIMENT RUNNER =====

def run_experiment(repo, cases, no_cache=False, dry_run=False, cal=None):
    """Run A/B experiment: heuristic baseline vs v3 holistic Ollama."""
    system_prompt = build_system_prompt(cal)
    results = []

    print(f"\n{'='*70}")
    print(f"V3 HOLISTIC OLLAMA EXPERIMENT")
    print(f"Model: {OLLAMA_MODEL}")
    print(f"Commits: {len(cases)}")
    print(f"Cache: {'disabled' if no_cache else 'enabled'}")
    print(f"{'='*70}\n")

    for i, case in enumerate(cases, 1):
        sha = case["sha"]
        gt_low = case["gt_low"]
        gt_high = case["gt_high"]
        gt_mid = (gt_low + gt_high) / 2
        label = case["label"]

        print(f"[{i}/{len(cases)}] {sha[:8]} {label}")
        print(f"    GT: {gt_low}-{gt_high}h (mid={gt_mid:.1f}h)")

        try:
            commit_data = extract_commit_data(repo, sha)
            v3_meta = compute_v3_metadata(commit_data)
        except Exception as e:
            print(f"    ERROR extracting: {e}")
            results.append({
                "sha": sha, "label": label,
                "gt_low": gt_low, "gt_high": gt_high, "gt_mid": gt_mid,
                "error": str(e),
            })
            continue

        fs = commit_data["filter_result"]["filter_stats"]
        heur_total = commit_data["filter_result"]["heuristic_total"]

        print(f"    Files: {commit_data['total_files']}, LLM: {fs['llm']}, "
              f"Skip: {fs['skip']}, Heur: {fs['heuristic']} ({heur_total:.1f}h)")

        # --- Approach A: heuristic-only baseline ---
        heur_ape = abs(heur_total - gt_mid) / gt_mid * 100 if gt_mid > 0 else 0
        heur_in_range = gt_low <= heur_total <= gt_high

        prompt = build_v3_prompt(commit_data, v3_meta)

        if dry_run:
            print(f"    [heuristic] {heur_total:.1f}h APE={heur_ape:.0f}%")
            print(f"    --- PROMPT ({len(prompt)} chars) ---")
            print(prompt[:500])
            print("    ...")
            results.append({
                "sha": sha, "label": label,
                "gt_low": gt_low, "gt_high": gt_high, "gt_mid": gt_mid,
                "heur_total": heur_total, "heur_ape": heur_ape,
                "heur_in_range": heur_in_range,
            })
            continue

        # --- Approach B: v3 holistic via Ollama ---
        t0 = time.time()
        parsed, meta = call_ollama(
            system_prompt, prompt, schema=V3_SCHEMA, no_cache=no_cache,
        )
        wall_ms = (time.time() - t0) * 1000

        if parsed is None:
            print(f"    [heuristic] {heur_total:.1f}h APE={heur_ape:.0f}%")
            print(f"    [v3-ollama] ERROR: {meta.get('error', '?')}")
            results.append({
                "sha": sha, "label": label,
                "gt_low": gt_low, "gt_high": gt_high, "gt_mid": gt_mid,
                "heur_total": heur_total, "heur_ape": heur_ape,
                "heur_in_range": heur_in_range,
                "v3_error": meta.get("error", "unknown"),
            })
            continue

        est_mid = parsed.get("mid", 0)
        est_low = parsed.get("low", 0)
        est_high = parsed.get("high", 0)
        confidence = parsed.get("confidence", "?")
        reasoning = parsed.get("reasoning", "")

        v3_ape = abs(est_mid - gt_mid) / gt_mid * 100 if gt_mid > 0 else 0
        v3_in_range = gt_low <= est_mid <= gt_high
        v3_within_2x = est_mid <= gt_high * 2 and est_mid >= gt_low * 0.5

        cache_str = " [cached]" if meta.get("cache_hit") else ""
        h_status = "OK" if heur_in_range else "MISS"
        v_status = "OK" if v3_in_range else ("~2x" if v3_within_2x else "MISS")

        print(f"    [heuristic] {heur_total:.1f}h APE={heur_ape:.0f}% [{h_status}]")
        print(f"    [v3-ollama] {est_low:.1f}-{est_mid:.1f}-{est_high:.1f}h "
              f"APE={v3_ape:.0f}% [{v_status}] conf={confidence}{cache_str}")

        results.append({
            "sha": sha, "label": label,
            "gt_low": gt_low, "gt_high": gt_high, "gt_mid": gt_mid,
            # Heuristic
            "heur_total": heur_total, "heur_ape": heur_ape,
            "heur_in_range": heur_in_range,
            # V3 Ollama
            "v3_low": est_low, "v3_mid": est_mid, "v3_high": est_high,
            "v3_ape": v3_ape, "v3_in_range": v3_in_range, "v3_within_2x": v3_within_2x,
            "v3_confidence": confidence, "v3_reasoning": reasoning,
            "v3_elapsed_ms": meta.get("elapsed_ms", 0),
            "v3_cache_hit": meta.get("cache_hit", False),
            "prompt_tokens": meta.get("prompt_tokens", 0),
            "completion_tokens": meta.get("completion_tokens", 0),
        })

    return results


# ===== REPORTS =====

def generate_reports(results):
    """Generate JSON + Markdown comparison report."""
    timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    results_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "experiment_v3_results")
    os.makedirs(results_dir, exist_ok=True)

    ok_results = [r for r in results if "error" not in r and "v3_error" not in r]
    heur_only = [r for r in results if "error" not in r]

    # --- Heuristic aggregate ---
    if heur_only:
        h_apes = [r["heur_ape"] for r in heur_only]
        h_in = sum(1 for r in heur_only if r["heur_in_range"])
        h_signed = [r["heur_total"] - r["gt_mid"] for r in heur_only]
        h_mape = sum(h_apes) / len(h_apes)
        h_mdape = statistics.median(h_apes)
    else:
        h_mape = h_mdape = h_in = 0
        h_signed = []

    # --- V3 Ollama aggregate ---
    if ok_results:
        v_apes = [r["v3_ape"] for r in ok_results]
        v_in = sum(1 for r in ok_results if r["v3_in_range"])
        v_2x = sum(1 for r in ok_results if r["v3_within_2x"])
        v_signed = [r["v3_mid"] - r["gt_mid"] for r in ok_results]
        v_mape = sum(v_apes) / len(v_apes)
        v_mdape = statistics.median(v_apes)
        v_bias = sum(v_signed) / len(v_signed)
        v_over = sum(1 for e in v_signed if e > 0)
        v_under = sum(1 for e in v_signed if e < 0)
        v_n = len(ok_results)
        avg_ms = sum(r["v3_elapsed_ms"] for r in ok_results) / v_n
    else:
        v_mape = v_mdape = v_bias = avg_ms = 0
        v_in = v_2x = v_over = v_under = v_n = 0

    n_heur = len(heur_only)
    h_bias = sum(h_signed) / n_heur if h_signed else 0
    h_over = sum(1 for e in h_signed if e > 0)
    h_under = sum(1 for e in h_signed if e < 0)

    # --- JSON ---
    json_path = os.path.join(results_dir, f"experiment_v3_ollama_{timestamp}.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({
            "timestamp": timestamp,
            "model": OLLAMA_MODEL,
            "n_commits": len(results),
            "n_ok": v_n,
            "heuristic": {"mape": round(h_mape, 1), "mdape": round(h_mdape, 1),
                          "in_range": h_in, "n": n_heur, "bias": round(h_bias, 1)},
            "v3_ollama": {"mape": round(v_mape, 1), "mdape": round(v_mdape, 1),
                          "in_range": v_in, "within_2x": v_2x, "n": v_n,
                          "bias": round(v_bias, 1), "over": v_over, "under": v_under,
                          "avg_ms": round(avg_ms)},
            "results": results,
        }, f, ensure_ascii=False, indent=2)

    # --- Markdown ---
    md_path = os.path.join(results_dir, f"experiment_v3_ollama_{timestamp}.md")
    lines = [
        "# V3 Holistic Ollama Experiment — Normal Commits",
        "",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"**Model:** {OLLAMA_MODEL}",
        f"**Commits:** {len(results)} (3-30 files each)",
        "",
        "## Summary",
        "",
        "| Approach | MAPE | MdAPE | In-Range | Bias (avg) | Over/Under |",
        "|----------|------|-------|----------|-----------|------------|",
        f"| **Heuristic only** | {h_mape:.1f}% | {h_mdape:.1f}% | {h_in}/{n_heur} "
        f"| {'+' if h_bias >= 0 else ''}{h_bias:.1f}h | {h_over}O/{h_under}U |",
    ]
    if v_n > 0:
        lines.append(
            f"| **V3 holistic ({OLLAMA_MODEL})** | {v_mape:.1f}% | {v_mdape:.1f}% | {v_in}/{v_n} "
            f"| {'+' if v_bias >= 0 else ''}{v_bias:.1f}h | {v_over}O/{v_under}U |"
        )
    lines += [
        "",
        f"**Avg latency:** {avg_ms:.0f}ms per call",
        "",
        "## Per-Commit Results",
        "",
        "| # | Commit | GT | Heuristic | H-APE | V3 mid | V3-APE | V3 status |",
        "|---|--------|-----|-----------|-------|--------|--------|-----------|",
    ]

    for i, r in enumerate(results, 1):
        sha = r["sha"][:8]
        gt = f"{r['gt_low']}-{r['gt_high']}h"
        h = f"{r.get('heur_total', 0):.1f}h"
        h_ape_s = f"{r.get('heur_ape', 0):.0f}%"
        if "v3_mid" in r:
            v = f"{r['v3_mid']:.1f}h"
            v_ape_s = f"{r['v3_ape']:.0f}%"
            v_stat = "**OK**" if r["v3_in_range"] else ("~2x" if r["v3_within_2x"] else "MISS")
        elif "v3_error" in r:
            v = "ERR"
            v_ape_s = "—"
            v_stat = "ERR"
        else:
            v = "—"
            v_ape_s = "—"
            v_stat = "—"
        lines.append(f"| {i} | {sha} | {gt} | {h} | {h_ape_s} | {v} | {v_ape_s} | {v_stat} |")

    # Reasoning section
    lines += ["", "## V3 Reasoning", ""]
    for r in results:
        if "v3_reasoning" in r:
            sha = r["sha"][:8]
            lines.append(f"**{sha}** ({r['gt_low']}-{r['gt_high']}h GT): "
                         f"{r['v3_low']:.0f}-{r['v3_mid']:.0f}-{r['v3_high']:.0f}h")
            lines.append(f"> {r['v3_reasoning']}")
            lines.append("")

    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    return json_path, md_path, {
        "h_mape": h_mape, "h_mdape": h_mdape, "h_in": h_in, "h_n": n_heur,
        "v_mape": v_mape, "v_mdape": v_mdape, "v_in": v_in, "v_n": v_n,
        "v_bias": v_bias, "avg_ms": avg_ms,
    }


# ===== MAIN =====

def parse_args():
    parser = argparse.ArgumentParser(description="V3 holistic Ollama experiment on normal commits")
    parser.add_argument("--repo", required=True, help="Path to artisan-private clone")
    parser.add_argument("--no-cache", action="store_true", help="Disable cache")
    parser.add_argument("--commit", default=None, help="Run only one commit SHA")
    parser.add_argument("--dry-run", action="store_true", help="Extract metadata only, no LLM calls")
    parser.add_argument("--model", default=OLLAMA_MODEL, help=f"Ollama model (default: {OLLAMA_MODEL})")
    parser.add_argument("--calibration", default=None, help="Path to JSON calibration overrides")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()

    if not os.path.isdir(args.repo):
        print(f"ERROR: repo not found at {args.repo}")
        sys.exit(1)

    OLLAMA_MODEL = args.model

    # Check Ollama is running
    try:
        import urllib.request
        urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=5)
    except Exception as e:
        print(f"ERROR: Ollama not reachable at {OLLAMA_URL}: {e}")
        sys.exit(1)

    cal = CALIBRATION
    if args.calibration:
        cal = dict(CALIBRATION)
        with open(args.calibration, "r", encoding="utf-8") as f:
            cal.update(json.load(f))
        print(f"Calibration overrides from {args.calibration}")

    cases = GT_CASES
    if args.commit:
        cases = [c for c in GT_CASES if c["sha"].startswith(args.commit)]
        if not cases:
            print(f"ERROR: commit {args.commit} not in GT_CASES")
            sys.exit(1)

    results = run_experiment(args.repo, cases, no_cache=args.no_cache,
                             dry_run=args.dry_run, cal=cal)

    if args.dry_run:
        print(f"\nDry run complete — {len(results)} commits processed.")
        sys.exit(0)

    json_path, md_path, agg = generate_reports(results)

    print(f"\n{'='*70}")
    print(f"RESULTS SUMMARY")
    print(f"{'='*70}")
    print(f"  Heuristic:  MAPE={agg['h_mape']:.1f}%  MdAPE={agg['h_mdape']:.1f}%  "
          f"InRange={agg['h_in']}/{agg['h_n']}")
    print(f"  V3 Ollama:  MAPE={agg['v_mape']:.1f}%  MdAPE={agg['v_mdape']:.1f}%  "
          f"InRange={agg['v_in']}/{agg['v_n']}  Bias={agg['v_bias']:+.1f}h  "
          f"Avg={agg['avg_ms']:.0f}ms")
    print(f"\nJSON: {json_path}")
    print(f"MD:   {md_path}")
