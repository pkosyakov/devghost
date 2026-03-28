#!/usr/bin/env python3
"""
Isolated test: audit pipeline estimation for a single bulk-copy commit.

Commit: 188c43e933883194f0bddb29f9fa3d1f67d0c2ba (artisan-private)
Ground truth: 8-30h (per tech lead)
Pipeline estimate: 639.8h

Tests three fix variants:
  A) Bulk new-file detector (pre-LLM heuristic)
  B) Expanded MOVE_KEYWORDS + monorepo heuristic
  C) Hard cap on FD aggregation
  A+C) Combined

With --with-llm: runs actual LLM calls via OpenRouter to test:
  1) Current pipeline metadata classify (what LLM sees)
  2) Fix B mechanical path (classify + estimate in 2 LLM calls)

Usage:
  cd packages/server/scripts/pipeline
  python test_bulk_commit_audit.py [--repo PATH] [--sha SHA] [--with-llm]

Defaults to the artisan-private commit.
"""
import argparse
import os
import re
import subprocess
import sys
import json
import time
import random
from collections import Counter
from pathlib import Path

# ---------------------------------------------------------------------------
# Import pipeline modules (same directory)
# ---------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from file_decomposition import (
    split_diff_by_file,
    parse_file_stat,
    classify_file_regex,
    classify_move_commit,
    detect_bulk_refactoring,
    extract_edit_patterns,
    MOVE_KEYWORDS,
    ARCHITECTURAL_KEYWORDS,
    ANALYSIS_SCHEMA,
)

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_REPO = r"C:\Projects\_tmp_devghost_audit\artisan-private"
DEFAULT_SHA = "188c43e933883194f0bddb29f9fa3d1f67d0c2ba"
GROUND_TRUTH_MIN = 8.0
GROUND_TRUTH_MAX = 30.0
ORIGINAL_ESTIMATE = 639.8

# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

def git_cmd(repo, *args):
    result = subprocess.run(
        ["git"] + list(args),
        cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout


def get_commit_info(repo, sha):
    raw = git_cmd(repo, "log", "--format=%H%n%P%n%an <%ae>%n%ai%n%s", "-1", sha)
    lines = raw.strip().split("\n")
    parents = lines[1].split() if lines[1].strip() else []
    return {
        "sha": lines[0],
        "parents": parents,
        "parent_count": len(parents),
        "author": lines[2],
        "date": lines[3],
        "message": lines[4],
    }


def get_diff(repo, sha):
    return git_cmd(repo, "diff", f"{sha}^..{sha}")


def get_numstat(repo, sha):
    raw = git_cmd(repo, "diff", "--numstat", f"{sha}^..{sha}")
    files = []
    total_add = 0
    total_del = 0
    for line in raw.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        a, d, f = parts[0], parts[1], parts[2]
        if a == "-":
            files.append({"file": f, "added": 0, "deleted": 0, "binary": True})
        else:
            ia, id_ = int(a), int(d)
            files.append({"file": f, "added": ia, "deleted": id_, "binary": False})
            total_add += ia
            total_del += id_
    return files, total_add, total_del


# ---------------------------------------------------------------------------
# Analysis helpers
# ---------------------------------------------------------------------------

def analyze_file_composition(numstat_files):
    """Classify files by nature from numstat."""
    new_files = [f for f in numstat_files if f["deleted"] == 0 and not f["binary"]]
    modified = [f for f in numstat_files if f["deleted"] > 0 and not f["binary"]]
    binary = [f for f in numstat_files if f["binary"]]

    # Classify new files by extension
    ext_counts = Counter()
    for f in new_files:
        name = f["file"]
        ext = name.rsplit(".", 1)[-1] if "." in name else "none"
        ext_counts[ext] += 1

    return {
        "total": len(numstat_files),
        "new_files": len(new_files),
        "modified": len(modified),
        "binary": len(binary),
        "new_file_ratio": len(new_files) / max(len(numstat_files), 1),
        "new_lines": sum(f["added"] for f in new_files),
        "ext_distribution": ext_counts.most_common(15),
    }


def run_current_pipeline_routing(diff, message, file_info, fc, la, ld):
    """Simulate the current pipeline routing logic (no LLM calls)."""
    results = {}

    # 1. Check cheap signals
    from file_decomposition import _check_cheap_signals
    cheap_est, cheap_tag = _check_cheap_signals(message, fc, la, ld)
    results["cheap_signal"] = {"fires": cheap_est is not None, "estimate": cheap_est, "tag": cheap_tag}

    # 2. Move detection
    move_info = classify_move_commit(message, file_info)
    results["move_detection"] = {
        "is_move": move_info.get("is_move", False),
        "move_type": move_info.get("move_type"),
        "pairs": len(move_info.get("pairs", [])),
    }

    # 3. Bulk detection
    bulk_info = detect_bulk_refactoring(file_info)
    results["bulk_detection"] = {
        "is_bulk": bulk_info.get("is_bulk", False),
        "patterned_files": len(bulk_info.get("patterned_files", set())),
        "bulk_ratio": bulk_info.get("bulk_ratio", 0),
    }

    # 4. MOVE_KEYWORDS check
    has_kw = bool(MOVE_KEYWORDS.search(message))
    results["move_keywords_match"] = has_kw

    # 5. Commit ratio
    if la > 0 and ld > 0:
        commit_ratio = min(la, ld) / max(la, ld)
    else:
        commit_ratio = 0
    results["commit_ratio"] = round(commit_ratio, 4)

    # 6. FD threshold
    diff_len = len(diff)
    fd_threshold = 59392  # default for 32K context
    results["diff_chars"] = diff_len
    results["fd_threshold"] = fd_threshold
    results["triggers_fd"] = diff_len > fd_threshold

    # 7. Check force_complex triggers (version release / migration file)
    force_complex = False
    force_reason = None
    msg_lower = message.lower()
    if re.match(r'^v\d+\b', msg_lower):
        force_complex = True
        force_reason = "version release (^v\\d)"
    elif 'breaking' in msg_lower and fc >= 10:
        force_complex = True
        force_reason = "'breaking' keyword + 10+ files"
    if not force_complex:
        for f in file_info:
            if 'migrat' in f['filename'].lower():
                force_complex = True
                force_reason = f"file '{f['filename']}' contains 'migrat'"
                break
    results["force_complex"] = force_complex
    results["force_complex_reason"] = force_reason

    # 8. Expected route
    if cheap_est is not None:
        results["expected_route"] = f"FD_cheap ({cheap_tag})"
    elif not results["triggers_fd"]:
        results["expected_route"] = "direct_cascading (diff < threshold)"
    elif force_complex:
        results["expected_route"] = f"run_fd_hybrid -> FORCE COMPLEX -> run_file_decomposition (full per-file FD)"
        results["why_full_fd"] = f"force_complex triggered by: {force_reason}"
    else:
        results["expected_route"] = "run_fd_hybrid -> LLM classify -> route by new_logic%"
        results["why_full_fd"] = "Would depend on LLM classify new_logic_percent"

    return results, move_info, bulk_info


# ---------------------------------------------------------------------------
# FIX A: Bulk new-file detector
# ---------------------------------------------------------------------------

def fix_a_bulk_new_file_detector(file_info, fc, la, ld, message):
    """Detect bulk new-file commits (cross-repo copy, scaffold, vendor).

    Fires when:
    - >80% of files are purely new (deleted == 0)
    - total additions > 10K
    - file count > 50
    """
    new_file_count = sum(1 for f in file_info if f["deleted"] == 0)
    new_file_ratio = new_file_count / max(len(file_info), 1)

    fires = new_file_ratio > 0.8 and la > 10000 and fc > 50

    if not fires:
        return {"fires": False, "estimate": None}

    # Estimate: architectural overhead + minimal per-file adaptation
    # Base: 8-16h for workspace setup (config, build, CI, dependency resolution)
    # Per-file adaptation: near-zero for copied files, small for import path fixes
    #
    # Heuristic for a mid-level dev without AI:
    #   - Workspace/config setup: 4-8h (Nx/turborepo/pnpm workspace config)
    #   - Import path migration: 2-8h (find-replace + manual fixes)
    #   - Build/test verification: 2-8h (fixing compilation, test runner)
    #   - Total: ~8-24h capped at 40h

    # Count config/build files (signals workspace complexity)
    config_count = sum(1 for f in file_info
                       if any(re.search(p, f["filename"])
                              for p in [r'project\.json', r'tsconfig', r'\.eslintrc',
                                        r'package\.json', r'nx\.json', r'workspace']))
    # Count files with actual modifications (not pure adds)
    modified_count = sum(1 for f in file_info if f["deleted"] > 0)

    base_hours = 8.0  # minimum workspace setup
    config_hours = min(8.0, config_count * 0.3)  # config tweaking
    adaptation_hours = min(8.0, modified_count * 0.5)  # fixing existing files
    import_fix_hours = min(8.0, fc * 0.01)  # bulk import path fixes

    estimate = base_hours + config_hours + adaptation_hours + import_fix_hours
    estimate = min(40.0, max(10.0, estimate))  # floor 10h, cap 40h

    return {
        "fires": True,
        "estimate": round(estimate, 1),
        "new_file_count": new_file_count,
        "new_file_ratio": round(new_file_ratio, 3),
        "config_count": config_count,
        "modified_count": modified_count,
        "breakdown": {
            "base_workspace_setup": base_hours,
            "config_tweaking": round(config_hours, 1),
            "existing_file_adaptation": round(adaptation_hours, 1),
            "import_path_fixes": round(import_fix_hours, 1),
        },
        "method": "FD_bulk_new_file",
    }


# ---------------------------------------------------------------------------
# FIX B: Expanded MOVE_KEYWORDS + monorepo heuristic
# ---------------------------------------------------------------------------

MOVE_KEYWORDS_V2 = re.compile(
    r'\b(move|rename|extract|split|reorganize|relocate|migrate|monorepo|mono[- ]?repo|'
    r'workspace|refactor.*module|refactor.*mono|consolidat)\b', re.IGNORECASE
)

ARCHITECTURAL_KEYWORDS_V2 = re.compile(
    r'\b(extract\s+(crate|package|library|workspace)|create\s+(new\s+)?(crate|package|module)|'
    r'split\s+into|monorepo|mono[- ]?repo|workspace\s+(restructur|migrat|refactor))\b', re.IGNORECASE
)


def fix_b_expanded_keywords(message, file_info, fc, la, ld):
    """Test expanded MOVE_KEYWORDS for monorepo/workspace detection."""
    has_kw_v1 = bool(MOVE_KEYWORDS.search(message))
    has_kw_v2 = bool(MOVE_KEYWORDS_V2.search(message))
    has_arch_v2 = bool(ARCHITECTURAL_KEYWORDS_V2.search(message))

    new_file_ratio = sum(1 for f in file_info if f["deleted"] == 0) / max(len(file_info), 1)

    # Extended logic: if keyword matches AND many new files, force move detection
    force_move = has_kw_v2 and fc > 100 and new_file_ratio > 0.7

    return {
        "original_keyword_match": has_kw_v1,
        "v2_keyword_match": has_kw_v2,
        "v2_arch_keyword_match": has_arch_v2,
        "force_move": force_move,
        "would_route_to": "mechanical (FD_hybrid_mechanical)" if force_move else "unchanged (still full FD)",
    }


# ---------------------------------------------------------------------------
# FIX C: Hard cap for FD aggregation
# ---------------------------------------------------------------------------

MAX_FD_HOURS = 80  # 2 work weeks — absolute max for a single commit


def fix_c_hard_cap(original_estimate):
    """Apply hard cap to FD estimates."""
    capped = min(original_estimate, MAX_FD_HOURS)
    return {
        "original": original_estimate,
        "capped": capped,
        "reduction": round(original_estimate - capped, 1),
        "still_overestimated": capped > GROUND_TRUTH_MAX,
    }


# ---------------------------------------------------------------------------
# Combined A+C
# ---------------------------------------------------------------------------

def fix_ac_combined(fix_a_result, original_estimate):
    """Fix A fires first; if not, apply fix C as safety net."""
    if fix_a_result["fires"]:
        return {
            "route": "Fix A (bulk new-file)",
            "estimate": fix_a_result["estimate"],
        }
    else:
        capped = min(original_estimate, MAX_FD_HOURS)
        return {
            "route": "Fix C (hard cap)",
            "estimate": capped,
        }


# ---------------------------------------------------------------------------
# OpenRouter LLM client (standalone, no pipeline imports needed)
# ---------------------------------------------------------------------------

def load_env(env_path):
    """Load .env file into dict (simple key=value parser)."""
    env = {}
    if not os.path.exists(env_path):
        return env
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, val = line.partition("=")
            val = val.strip().strip('"').strip("'")
            env[key.strip()] = val
    return env


def call_openrouter(system, prompt, schema, api_key, model, max_tokens=1024):
    """Minimal OpenRouter call. Returns (parsed_dict, meta_dict)."""
    import requests

    system_content = system
    if schema:
        system_content += f'\n\nYou MUST respond with ONLY valid JSON (no markdown, no extra text) matching this schema:\n{json.dumps(schema)}'

    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system_content},
            {'role': 'user', 'content': prompt},
        ],
        'temperature': 0,
        'max_tokens': max_tokens,
        'seed': 42,
        'provider': {
            'allow_fallbacks': True,
            'require_parameters': True,
        },
    }
    if schema:
        payload['response_format'] = {
            'type': 'json_schema',
            'json_schema': {
                'name': 'response',
                'strict': True,
                'schema': schema,
            },
        }

    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }

    start = time.time()
    resp = requests.post(
        'https://openrouter.ai/api/v1/chat/completions',
        json=payload, headers=headers, timeout=(10, 300),
    )
    elapsed_ms = (time.time() - start) * 1000

    if resp.status_code != 200:
        raise RuntimeError(f"OpenRouter HTTP {resp.status_code}: {resp.text[:500]}")

    data = resp.json()
    if 'error' in data:
        raise RuntimeError(f"OpenRouter API error: {data['error']}")

    content = data['choices'][0]['message']['content']
    text = re.sub(r'<think>[\s\S]*?</think>', '', content).strip()

    # Parse JSON
    parsed = None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r'```(?:json)?\s*\n?([\s\S]*?)```', text)
        if m:
            try:
                parsed = json.loads(m.group(1).strip())
            except json.JSONDecodeError:
                pass
        if parsed is None:
            start_idx = text.find('{')
            if start_idx >= 0:
                depth = 0
                for i in range(start_idx, len(text)):
                    if text[i] == '{': depth += 1
                    elif text[i] == '}':
                        depth -= 1
                        if depth == 0:
                            try:
                                parsed = json.loads(text[start_idx:i+1])
                            except json.JSONDecodeError:
                                pass
                            break

    usage = data.get('usage', {})
    provider = data.get('provider', '?')
    meta = {
        'prompt_tokens': usage.get('prompt_tokens', 0),
        'completion_tokens': usage.get('completion_tokens', 0),
        'total_ms': round(elapsed_ms, 0),
        'provider': provider,
        'raw_text': text[:500],
    }
    return parsed, meta


# ---------------------------------------------------------------------------
# LLM-based tests
# ---------------------------------------------------------------------------

def run_llm_tests(message, file_info, fc, la, ld, api_key, model, language="TypeScript"):
    """Run actual LLM calls to test classification and estimation paths.

    Returns dict with results for each test.
    """
    from file_decomposition import (
        _build_metadata_prompt, PROMPT_CLASSIFY, ANALYSIS_SCHEMA,
        PROMPT_EST_ARCHITECTURAL, PROMPT_EST_TASK_DECOMP, PROMPT_EST_SIMPLE,
        ESTIMATE_SCHEMA, DECOMP_SCHEMA,
        classify_move_commit, detect_bulk_refactoring,
    )

    results = {}

    # Build metadata prompt (same as pipeline)
    metadata_prompt = _build_metadata_prompt(message, fc, la, ld, file_info, language)
    results["metadata_prompt_chars"] = len(metadata_prompt)

    print(f"\n  Metadata prompt: {len(metadata_prompt)} chars")
    print(f"  Model: {model}")

    # --- Test 1: Metadata classification (what the current pipeline does) ---
    print(f"\n  [1/3] Classifying commit via metadata-only...")
    classify_prompt = f"{metadata_prompt}\n\nClassify this commit:"
    analysis, meta1 = call_openrouter(
        PROMPT_CLASSIFY.format(lang=language),
        classify_prompt, ANALYSIS_SCHEMA, api_key, model,
    )
    results["classify"] = {
        "analysis": analysis,
        "tokens": meta1.get("prompt_tokens", 0) + meta1.get("completion_tokens", 0),
        "time_ms": meta1.get("total_ms", 0),
        "provider": meta1.get("provider", "?"),
    }
    print(f"    Result: {json.dumps(analysis, indent=2)}")
    print(f"    Tokens: {meta1.get('prompt_tokens', 0)}+{meta1.get('completion_tokens', 0)}, "
          f"Time: {meta1.get('total_ms', 0):.0f}ms")

    if not analysis or not isinstance(analysis, dict):
        print("    ERROR: Classification failed, cannot proceed")
        return results

    new_logic = analysis.get('new_logic_percent', 50)
    scope = analysis.get('architectural_scope', 'none')

    # Check move/bulk enrichment (same as pipeline)
    move_info = classify_move_commit(message, file_info)
    bulk_info = detect_bulk_refactoring(file_info)

    if move_info.get("is_move") and analysis.get('moved_or_copied_percent', 0) < 30:
        analysis['moved_or_copied_percent'] = max(analysis.get('moved_or_copied_percent', 0), 60)
        new_logic = max(0, 100 - analysis['moved_or_copied_percent'] - analysis.get('boilerplate_percent', 0))
        analysis['new_logic_percent'] = new_logic

    if bulk_info.get("is_bulk") and analysis.get('boilerplate_percent', 0) < 30:
        analysis['boilerplate_percent'] = max(
            analysis.get('boilerplate_percent', 0),
            int(bulk_info['bulk_ratio'] * 100)
        )
        new_logic = max(0, 100 - analysis.get('moved_or_copied_percent', 0) - analysis['boilerplate_percent'])
        analysis['new_logic_percent'] = new_logic

    results["enriched_analysis"] = analysis
    results["routing"] = {
        "new_logic": new_logic,
        "scope": scope,
        "route": "mechanical" if new_logic < 20 else "complex (full per-file FD)",
    }
    print(f"\n    After enrichment: new_logic={new_logic}%, scope={scope}")
    print(f"    Route: {'MECHANICAL' if new_logic < 20 else 'COMPLEX -> full per-file FD (current: 639.8h)'}")

    # --- Test 2: Mechanical estimate (what Fix B would produce) ---
    print(f"\n  [2/3] Running mechanical estimation (Fix B path)...")

    analysis_text = (
        f"Change type: {analysis.get('change_type', '?')}\n"
        f"New logic: {analysis.get('new_logic_percent', '?')}%, "
        f"Moved: {analysis.get('moved_or_copied_percent', '?')}%, "
        f"Boilerplate: {analysis.get('boilerplate_percent', '?')}%\n"
        f"Scope: {scope}, Complexity: {analysis.get('cognitive_complexity', '?')}\n"
        f"Summary: {analysis.get('summary', '?')}"
    )

    context_lines = []
    if move_info.get("is_move"):
        context_lines.append(f"Move detected: {move_info.get('move_type', '?')}, "
                             f"{len(move_info.get('pairs', []))} file pairs")
    if bulk_info.get("is_bulk"):
        context_lines.append(f"Bulk edit: {len(bulk_info.get('patterned_files', set()))} patterned files "
                             f"out of {fc} total")
    context = "\n".join(context_lines)

    # Route prompt by scope (same as _estimate_mechanical)
    if scope == 'none':
        est_prompt = PROMPT_EST_SIMPLE.format(lang=language)
        est_schema = ESTIMATE_SCHEMA
    elif scope == 'module':
        est_prompt = PROMPT_EST_TASK_DECOMP.format(lang=language)
        est_schema = DECOMP_SCHEMA
    else:
        est_prompt = PROMPT_EST_ARCHITECTURAL.format(lang=language)
        est_schema = ESTIMATE_SCHEMA

    user_prompt = f"{metadata_prompt}\n\nAnalysis:\n{analysis_text}\n"
    if context:
        user_prompt += f"\nDetected patterns:\n{context}\n"
    user_prompt += "\nEstimate:"

    mech_result, meta2 = call_openrouter(
        est_prompt, user_prompt, est_schema, api_key, model,
    )
    results["mechanical_estimate"] = {
        "result": mech_result,
        "tokens": meta2.get("prompt_tokens", 0) + meta2.get("completion_tokens", 0),
        "time_ms": meta2.get("total_ms", 0),
        "estimated_hours": mech_result.get("estimated_hours") if isinstance(mech_result, dict) else None,
    }
    print(f"    Result: {json.dumps(mech_result, indent=2)}")
    print(f"    Tokens: {meta2.get('prompt_tokens', 0)}+{meta2.get('completion_tokens', 0)}, "
          f"Time: {meta2.get('total_ms', 0):.0f}ms")

    mech_hours = mech_result.get("estimated_hours", 5.0) if isinstance(mech_result, dict) else 5.0

    # --- Test 3: Force architectural scope, re-estimate ---
    print(f"\n  [3/3] Re-estimating with forced scope=multi_package...")

    forced_analysis = dict(analysis)
    forced_analysis["architectural_scope"] = "multi_package"
    forced_analysis["new_logic_percent"] = min(analysis.get("new_logic_percent", 0), 15)
    forced_analysis["moved_or_copied_percent"] = max(analysis.get("moved_or_copied_percent", 0), 80)

    analysis_text_forced = (
        f"Change type: {forced_analysis.get('change_type', '?')}\n"
        f"New logic: {forced_analysis.get('new_logic_percent', '?')}%, "
        f"Moved: {forced_analysis.get('moved_or_copied_percent', '?')}%, "
        f"Boilerplate: {forced_analysis.get('boilerplate_percent', '?')}%\n"
        f"Scope: multi_package, Complexity: {forced_analysis.get('cognitive_complexity', '?')}\n"
        f"Summary: Monorepo migration - copying existing codebase into Nx workspace structure with import path updates"
    )

    forced_context = f"Bulk new-file commit: {sum(1 for f in file_info if f['deleted'] == 0)}/{fc} files are new (cross-repo copy).\n"
    if context:
        forced_context += context

    user_prompt_forced = (
        f"{metadata_prompt}\n\nAnalysis:\n{analysis_text_forced}\n"
        f"\nDetected patterns:\n{forced_context}\n"
        f"\nEstimate:"
    )

    forced_result, meta3 = call_openrouter(
        PROMPT_EST_ARCHITECTURAL.format(lang=language),
        user_prompt_forced, ESTIMATE_SCHEMA, api_key, model,
    )
    results["forced_architectural_estimate"] = {
        "result": forced_result,
        "tokens": meta3.get("prompt_tokens", 0) + meta3.get("completion_tokens", 0),
        "time_ms": meta3.get("total_ms", 0),
        "estimated_hours": forced_result.get("estimated_hours") if isinstance(forced_result, dict) else None,
    }
    print(f"    Result: {json.dumps(forced_result, indent=2)}")
    print(f"    Tokens: {meta3.get('prompt_tokens', 0)}+{meta3.get('completion_tokens', 0)}, "
          f"Time: {meta3.get('total_ms', 0):.0f}ms")

    forced_hours = forced_result.get("estimated_hours", 5.0) if isinstance(forced_result, dict) else 5.0

    # Summary
    results["summary"] = {
        "classify_route": results["routing"]["route"],
        "mechanical_hours": mech_hours,
        "forced_architectural_hours": forced_hours,
        "total_llm_calls": 3,
        "total_tokens": sum(r.get("tokens", 0) for r in [
            results["classify"], results["mechanical_estimate"],
            results["forced_architectural_estimate"]
        ]),
    }

    return results


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def print_header(text):
    print(f"\n{'=' * 70}")
    print(f"  {text}")
    print(f"{'=' * 70}")


def print_section(text):
    print(f"\n--- {text} ---")


def accuracy_label(estimate):
    if estimate is None:
        return "N/A"
    if GROUND_TRUTH_MIN <= estimate <= GROUND_TRUTH_MAX:
        return "ACCURATE"
    elif estimate < GROUND_TRUTH_MIN:
        ratio = GROUND_TRUTH_MIN / max(estimate, 0.1)
        return f"UNDERESTIMATED x{ratio:.1f}"
    else:
        ratio = estimate / GROUND_TRUTH_MAX
        return f"OVERESTIMATED x{ratio:.1f}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Audit pipeline for bulk-copy commit")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="Path to git repo")
    parser.add_argument("--sha", default=DEFAULT_SHA, help="Commit SHA")
    parser.add_argument("--with-llm", action="store_true", help="Run actual LLM calls via OpenRouter")
    parser.add_argument("--model", default="qwen/qwen3-coder-30b-a3b-instruct",
                        help="OpenRouter model ID")
    parser.add_argument("--api-key", default="", help="OpenRouter API key (or set in .env)")
    args = parser.parse_args()

    print_header("PIPELINE AUDIT: Bulk-Copy Commit")
    print(f"Repo:         {args.repo}")
    print(f"SHA:          {args.sha}")
    print(f"Ground truth: {GROUND_TRUTH_MIN}-{GROUND_TRUTH_MAX}h")
    print(f"Original est: {ORIGINAL_ESTIMATE}h ({accuracy_label(ORIGINAL_ESTIMATE)})")

    # --- Gather commit data ---
    print_section("1. Commit metadata")
    info = get_commit_info(args.repo, args.sha)
    print(f"Message:  {info['message']}")
    print(f"Author:   {info['author']}")
    print(f"Date:     {info['date']}")
    print(f"Parents:  {info['parent_count']} (squash merge)" if info['parent_count'] == 1 else f"Parents: {info['parent_count']}")

    print_section("2. File composition (from numstat)")
    numstat_files, total_add, total_del = get_numstat(args.repo, args.sha)
    comp = analyze_file_composition(numstat_files)
    print(f"Files:        {comp['total']}")
    print(f"New files:    {comp['new_files']} ({comp['new_file_ratio']:.1%})")
    print(f"Modified:     {comp['modified']}")
    print(f"Binary:       {comp['binary']}")
    print(f"Lines:        +{total_add}/-{total_del}")
    print(f"Extensions:   {comp['ext_distribution']}")

    # --- Get diff and build file_info ---
    print_section("3. Building file_info (split diff + regex classify)")
    diff = get_diff(args.repo, args.sha)
    print(f"Diff size: {len(diff):,} chars ({len(diff)//1024}KB)")

    file_diffs = split_diff_by_file(diff)
    file_info = []
    tag_stats = Counter()
    for filename, fdiff in file_diffs:
        fa, fd_stat = parse_file_stat(fdiff)
        tags = classify_file_regex(filename, fdiff, fa, fd_stat)
        file_info.append({
            "filename": filename, "diff": fdiff,
            "added": fa, "deleted": fd_stat, "tags": tags,
        })
        for t in tags:
            tag_stats[t] += 1
        if not tags:
            tag_stats["(untagged)"] += 1

    print(f"Files parsed: {len(file_info)}")
    print(f"Tag distribution:")
    for tag, count in tag_stats.most_common():
        print(f"  {tag:20s}: {count}")

    untagged_count = tag_stats.get("(untagged)", 0)
    print(f"\nUntagged files -> per-file LLM estimation: {untagged_count}")
    print(f"  (this is why FD sums to {ORIGINAL_ESTIMATE}h: ~{untagged_count} LLM calls at ~0.5-2h each)")

    # --- Current pipeline routing ---
    print_section("4. Current pipeline routing (no LLM)")
    fc = len(numstat_files)
    routing, move_info, bulk_info = run_current_pipeline_routing(
        diff, info["message"], file_info, fc, total_add, total_del
    )
    for key, val in routing.items():
        print(f"  {key}: {val}")

    # --- Fix A ---
    print_header("FIX A: Bulk New-File Detector")
    fix_a = fix_a_bulk_new_file_detector(file_info, fc, total_add, total_del, info["message"])
    if fix_a["fires"]:
        print(f"FIRES: Yes")
        print(f"Estimate:     {fix_a['estimate']}h ({accuracy_label(fix_a['estimate'])})")
        print(f"New files:    {fix_a['new_file_count']} ({fix_a['new_file_ratio']:.1%})")
        print(f"Config files: {fix_a['config_count']}")
        print(f"Modified:     {fix_a['modified_count']}")
        print(f"Breakdown:")
        for k, v in fix_a["breakdown"].items():
            print(f"  {k:30s}: {v}h")
        print(f"Method:       {fix_a['method']}")
    else:
        print(f"FIRES: No")
        print(f"  new_file_ratio: {fix_a.get('new_file_ratio', '?')}")

    # --- Fix B ---
    print_header("FIX B: Expanded Keywords")
    fix_b = fix_b_expanded_keywords(info["message"], file_info, fc, total_add, total_del)
    for key, val in fix_b.items():
        print(f"  {key}: {val}")

    # --- Fix C ---
    print_header("FIX C: Hard Cap ({0}h)".format(MAX_FD_HOURS))
    fix_c = fix_c_hard_cap(ORIGINAL_ESTIMATE)
    for key, val in fix_c.items():
        print(f"  {key}: {val}")

    # --- Combined A+C ---
    print_header("FIX A+C: Combined")
    fix_ac = fix_ac_combined(fix_a, ORIGINAL_ESTIMATE)
    print(f"Route:    {fix_ac['route']}")
    print(f"Estimate: {fix_ac['estimate']}h ({accuracy_label(fix_ac['estimate'])})")

    # --- Summary table ---
    print_header("SUMMARY")
    print(f"{'Variant':<25} {'Estimate':>10} {'vs Ground Truth':>20} {'LLM Calls':>12}")
    print(f"{'-'*25} {'-'*10} {'-'*20} {'-'*12}")

    rows = [
        ("Ground truth", f"{GROUND_TRUTH_MIN}-{GROUND_TRUTH_MAX}h", "-", "-"),
        ("Current pipeline", f"{ORIGINAL_ESTIMATE}h", accuracy_label(ORIGINAL_ESTIMATE), "~700+"),
        ("Fix A (bulk detect)", f"{fix_a['estimate']}h" if fix_a["fires"] else "N/A",
         accuracy_label(fix_a["estimate"]) if fix_a["fires"] else "N/A", "0"),
        ("Fix B (keywords)", fix_b["would_route_to"][:10], "needs LLM", "1-2"),
        ("Fix C (cap 80h)", f"{fix_c['capped']}h", accuracy_label(fix_c["capped"]), "~700+"),
        ("Fix A+C", f"{fix_ac['estimate']}h", accuracy_label(fix_ac["estimate"]),
         "0" if fix_a["fires"] else "~700+"),
    ]
    for name, est, vs_gt, calls in rows:
        print(f"{name:<25} {est:>10} {vs_gt:>20} {calls:>12}")

    # --- Optional LLM test ---
    llm_results = None
    if args.with_llm:
        print_header("LLM TESTS (OpenRouter)")

        # Load API key
        env_path = os.path.join(SCRIPT_DIR, "..", "..", ".env")
        env_path = os.path.normpath(env_path)
        env = load_env(env_path)
        api_key = args.api_key or env.get("OPENROUTER_API_KEY", "")
        model = args.model

        if not api_key:
            print("  ERROR: No OPENROUTER_API_KEY found. Pass --api-key or set in .env")
        else:
            print(f"  API key: ...{api_key[-8:]}")
            print(f"  Model:   {model}")

            try:
                llm_results = run_llm_tests(
                    info["message"], file_info, fc, total_add, total_del,
                    api_key, model,
                )
            except Exception as e:
                print(f"  ERROR: {e}")
                import traceback
                traceback.print_exc()

    # --- Final summary ---
    print_header("FINAL SUMMARY")
    print(f"{'Variant':<30} {'Estimate':>10} {'vs Ground Truth':>20} {'LLM Calls':>12}")
    print(f"{'-'*30} {'-'*10} {'-'*20} {'-'*12}")

    rows = [
        ("Ground truth", f"{GROUND_TRUTH_MIN}-{GROUND_TRUTH_MAX}h", "-", "-"),
        ("Current pipeline", f"{ORIGINAL_ESTIMATE}h", accuracy_label(ORIGINAL_ESTIMATE), "~700+"),
        ("Fix A (bulk detect)", f"{fix_a['estimate']}h" if fix_a["fires"] else "N/A",
         accuracy_label(fix_a["estimate"]) if fix_a["fires"] else "N/A", "0"),
        ("Fix B (keywords)", fix_b["would_route_to"][:15], "needs LLM", "1-2"),
        ("Fix C (cap 80h)", f"{fix_c['capped']}h", accuracy_label(fix_c["capped"]), "~700+"),
        ("Fix A+C", f"{fix_ac['estimate']}h", accuracy_label(fix_ac["estimate"]),
         "0" if fix_a["fires"] else "~700+"),
    ]

    # Add LLM results if available
    if llm_results and llm_results.get("summary"):
        s = llm_results["summary"]
        mh = s.get("mechanical_hours")
        fh = s.get("forced_architectural_hours")
        if mh is not None:
            rows.append(("LLM: mechanical path", f"{mh}h",
                         accuracy_label(mh), "2"))
        if fh is not None:
            rows.append(("LLM: forced multi_pkg", f"{fh}h",
                         accuracy_label(fh), "2"))

    for name, est, vs_gt, calls in rows:
        print(f"{name:<30} {est:>10} {vs_gt:>20} {calls:>12}")

    print(f"\n{'=' * 70}")
    if llm_results and llm_results.get("summary"):
        s = llm_results["summary"]
        print(f"  LLM classify route: {s.get('classify_route', '?')}")
        print(f"  LLM total tokens: {s.get('total_tokens', 0)}")
    print(f"  VERDICT: Fix A+C recommended")
    print(f"  - Fix A catches bulk-copy/scaffold commits (this case: {fix_ac['estimate']}h)")
    print(f"  - Fix C is a safety net for any future FD anomaly (cap {MAX_FD_HOURS}h)")
    print(f"{'=' * 70}\n")


if __name__ == "__main__":
    main()
