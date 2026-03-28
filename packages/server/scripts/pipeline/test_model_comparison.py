#!/usr/bin/env python3
"""
Model comparison test for FD v2 holistic estimation.

Tests multiple OpenRouter models on known commits with confirmed ground truth.
Goal: find optimal price/quality ratio for large commit estimation.

Approach: replicate how a senior engineer estimates — see file composition,
understand the nature of work, look at key code files, give ONE holistic estimate.

Usage:
  cd packages/server/scripts/pipeline
  python test_model_comparison.py --repo /path/to/artisan-private
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

import requests

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1/chat/completions"

# ---------------------------------------------------------------------------
# Models to test (tier, model_id, input_$/M, output_$/M)
# ---------------------------------------------------------------------------
MODELS = [
    ("baseline",  "qwen/qwen3-coder-30b-a3b-instruct", 0.07, 0.27),
    ("budget",    "google/gemini-2.5-flash",            0.30, 2.50),
    ("mid",       "google/gemini-2.5-pro",              1.25, 10.00),
    ("premium",   "anthropic/claude-sonnet-4",          3.00, 15.00),
    ("ultra",     "anthropic/claude-opus-4",            15.00, 75.00),
]

# ---------------------------------------------------------------------------
# Test commits with confirmed GT from tech lead
# ---------------------------------------------------------------------------
TEST_COMMITS = [
    {
        "sha": "188c43e",
        "label": "Refactor/monorepo (scaffold, 870 files, 95% new)",
        "gt_low": 15, "gt_high": 30, "gt_mid": 22.5,
    },
    {
        "sha": "1d02576",
        "label": "Feat/dialer v1 (feature, 272 files, 90% new)",
        "gt_low": 40, "gt_high": 60, "gt_mid": 50,
    },
    {
        "sha": "16dc74e",
        "label": "pnpm vitest migration (tooling, 1036 files, 7% new)",
        "gt_low": 8, "gt_high": 16, "gt_mid": 12,
    },
]

# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

def git_cmd(repo, *args):
    result = subprocess.run(
        ["git"] + list(args),
        cwd=repo, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout


# ---------------------------------------------------------------------------
# File classification
# ---------------------------------------------------------------------------

SKIP_RE = re.compile(
    r'\.lock$|lock\.yaml$|lock\.json$|'
    r'_pb\.ts$|_pb\.js$|_pb2\.py$|\.pb\.go$|'
    r'\.snap$|__snapshots__/|'
    r'\.svg$|\.png$|\.jpg$|\.gif$|\.ico$|'
    r'\.woff2?$|\.ttf$|\.eot$'
)
TEST_RE = re.compile(r'\.(test|spec)\.(ts|tsx|js|jsx)$|__tests__/')
CONFIG_RE = re.compile(r'tsconfig|eslint|jest\.config|vitest\.config|\.env|project\.json|\.prettierrc|babel\.config')
DOCS_RE = re.compile(r'\.(md|mdx|rst)$')
MIGRATION_RE = re.compile(r'migrat', re.IGNORECASE)


def classify_file(name):
    if SKIP_RE.search(name):
        return "generated"
    if TEST_RE.search(name):
        return "test"
    if CONFIG_RE.search(name):
        return "config"
    if DOCS_RE.search(name):
        return "docs"
    if MIGRATION_RE.search(name):
        return "migration"
    return "code"


def get_commit_data(repo, sha):
    """Get stats, message, per-file breakdown, and key diffs."""
    parent = git_cmd(repo, "log", "--format=%P", "-1", sha).strip().split()[0]
    message = git_cmd(repo, "log", "--format=%s", "-1", sha).strip()

    # Numstat for per-file breakdown
    raw = git_cmd(repo, "diff", "--numstat", f"{parent}..{sha}")
    files = []
    total_la, total_ld = 0, 0
    for line in raw.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) >= 3:
            la = int(parts[0]) if parts[0] != "-" else 0
            ld = int(parts[1]) if parts[1] != "-" else 0
            fname = parts[2]
            total_la += la
            total_ld += ld
            cat = classify_file(fname)
            files.append({"name": fname, "added": la, "deleted": ld, "category": cat})

    new_count = sum(1 for f in files if f["added"] > 0 and f["deleted"] == 0)
    new_pct = new_count / len(files) * 100 if files else 0

    # Group by category
    by_cat = {}
    for f in files:
        by_cat.setdefault(f["category"], []).append(f)

    # Get diffs for top code files only (by lines_added)
    code_files = sorted(by_cat.get("code", []), key=lambda x: x["added"], reverse=True)
    top_code = code_files[:15]  # top 15 largest code files

    # Get individual diffs for top code files
    top_diffs = {}
    for f in top_code:
        try:
            fdiff = git_cmd(repo, "diff", f"{parent}..{sha}", "--", f["name"])
            top_diffs[f["name"]] = fdiff
        except Exception:
            pass

    return {
        "message": message,
        "parent": parent,
        "total_files": len(files),
        "total_la": total_la,
        "total_ld": total_ld,
        "new_pct": new_pct,
        "new_count": new_count,
        "by_cat": by_cat,
        "code_files": code_files,
        "top_diffs": top_diffs,
    }


# ---------------------------------------------------------------------------
# Build holistic prompt (replicating how I estimated)
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a senior software engineer estimating development effort for a git commit.

You will see:
1. Commit metadata (message, file count, lines)
2. File composition breakdown (what types of files: generated, tests, config, code)
3. Key code files with their actual diffs

Estimate TOTAL hours for a mid-level developer WITHOUT AI assistance.
Include: writing code, writing tests, config setup, manual testing, code review fixes.
Exclude: meetings, planning, waiting for review.

IMPORTANT: Consider the NATURE of the work:
- Scaffold/copy commits (monorepo migration, library setup) have low effort despite high line count
- Generated/lock files require zero development effort
- Tests and configs are part of the work but faster to write than core logic
- Large feature commits benefit from shared context — the developer builds understanding progressively

Respond with ONLY valid JSON (no markdown, no extra text)."""

SCHEMA = {
    "type": "object",
    "properties": {
        "estimated_hours": {"type": "number", "description": "Total development hours"},
        "reasoning": {"type": "string", "description": "Brief explanation of estimate"},
    },
    "required": ["estimated_hours", "reasoning"],
}


def build_prompt(data, max_diff_chars=50000):
    """Build holistic estimation prompt with file composition + key diffs."""

    # File composition summary
    comp_lines = []
    for cat in ["generated", "test", "config", "docs", "migration", "code"]:
        flist = data["by_cat"].get(cat, [])
        if not flist:
            continue
        cat_la = sum(f["added"] for f in flist)
        cat_ld = sum(f["deleted"] for f in flist)
        top3 = sorted(flist, key=lambda x: x["added"], reverse=True)[:3]
        top3_str = ", ".join(f"{f['name'].split('/')[-1]} (+{f['added']})" for f in top3)
        comp_lines.append(
            f"  {cat}: {len(flist)} files, +{cat_la}/-{cat_ld} lines"
            f"\n    Largest: {top3_str}"
        )

    composition = "\n".join(comp_lines)

    # Code file list (all, not just top)
    code_files = data["code_files"]
    code_list_lines = []
    for f in code_files[:30]:
        code_list_lines.append(f"    {f['name']} (+{f['added']}/-{f['deleted']})")
    if len(code_files) > 30:
        rest_la = sum(f["added"] for f in code_files[30:])
        code_list_lines.append(f"    ... and {len(code_files) - 30} more files (+{rest_la} lines)")
    code_list = "\n".join(code_list_lines)

    prompt = f"""Commit: {data['message']}
Total: {data['total_files']} files, +{data['total_la']:,}/-{data['total_ld']:,} lines
New files (add-only, zero deletions): {data['new_count']}/{data['total_files']} ({data['new_pct']:.0f}%)

FILE COMPOSITION:
{composition}

CODE FILES ({len(code_files)} substantive files):
{code_list}

"""

    # Add diffs of top code files, respecting token budget
    diff_chars_used = 0
    diff_parts = []
    for f in sorted(data["top_diffs"].keys(), key=lambda k: len(data["top_diffs"][k]), reverse=True):
        fdiff = data["top_diffs"][f]
        if diff_chars_used + len(fdiff) > max_diff_chars:
            if diff_chars_used == 0:
                # At least include truncated version of largest file
                diff_parts.append(fdiff[:max_diff_chars])
                diff_chars_used += max_diff_chars
            break
        diff_parts.append(fdiff)
        diff_chars_used += len(fdiff)

    if diff_parts:
        shown = len(diff_parts)
        total_code = len(code_files)
        prompt += f"DIFFS OF TOP {shown} CODE FILES (out of {total_code}):\n"
        prompt += "\n".join(diff_parts)
        if shown < total_code:
            prompt += f"\n\n[Remaining {total_code - shown} code files not shown — estimate based on file names and line counts above]\n"
    else:
        prompt += "[Diffs too large to include — estimate based on file composition and names above]\n"

    prompt += "\nEstimate TOTAL development effort for this entire commit."
    return prompt


# ---------------------------------------------------------------------------
# OpenRouter API call
# ---------------------------------------------------------------------------

def call_model(model_id, system, prompt, max_tokens=1024):
    """Call OpenRouter API. Returns (result_dict, meta)."""
    if not OPENROUTER_API_KEY:
        return None, {"error": "no API key"}

    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": max_tokens,
        "seed": 42,
    }

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
    }

    start = time.time()
    try:
        resp = requests.post(
            OPENROUTER_BASE_URL, json=payload, headers=headers,
            timeout=(10, 300),
        )
        elapsed_ms = (time.time() - start) * 1000

        if resp.status_code != 200:
            return None, {"error": f"HTTP {resp.status_code}: {resp.text[:300]}", "elapsed_ms": elapsed_ms}

        rdata = resp.json()
        if "error" in rdata:
            return None, {"error": str(rdata["error"])[:300], "elapsed_ms": elapsed_ms}

        usage = rdata.get("usage", {})
        content = rdata["choices"][0]["message"]["content"]

        raw_content = content.strip() if content else ""

        text = raw_content

        # Strip <think>...</think> blocks (Qwen3, DeepSeek reasoning)
        if "<think>" in text:
            text = re.sub(r'<think>.*?</think>\s*', '', text, flags=re.DOTALL)
            text = text.strip()

        # Strip markdown fences if present
        if text.startswith("```"):
            text = re.sub(r'^```\w*\n?', '', text)
            text = re.sub(r'\n?```$', '', text)
            text = text.strip()

        # Try to extract JSON object — allow nested braces
        if not text.startswith("{"):
            match = re.search(r'\{[^}]*"estimated_hours"\s*:\s*[\d.]+[^}]*\}', text, re.DOTALL)
            if match:
                text = match.group(0)

        # Try direct parse
        try:
            result = json.loads(text)
        except json.JSONDecodeError:
            # Fallback: extract hours with regex — any field containing "hour"
            hours_match = re.search(r'"(?:\w*hours?\w*)"\s*:\s*([\d.]+)', text, re.IGNORECASE)
            reason_match = re.search(r'"reasoning"\s*:\s*"([^"]*)"', text)
            if hours_match:
                result = {
                    "estimated_hours": float(hours_match.group(1)),
                    "reasoning": reason_match.group(1) if reason_match else "",
                }
            else:
                # Last resort: look for any number pattern after "hours"
                num_match = re.search(r'(\d+(?:\.\d+)?)\s*(?:hours|h)\b', text, re.IGNORECASE)
                if num_match:
                    result = {"estimated_hours": float(num_match.group(1)), "reasoning": text[:200]}
                else:
                    raise

        # Normalize: accept various field names for hours
        _HOUR_KEYS = ["estimated_hours", "total_hours", "totalHours", "hours",
                      "estimate", "effort_hours", "effortHours", "total"]
        if "estimated_hours" not in result or not isinstance(result.get("estimated_hours"), (int, float)):
            for k in _HOUR_KEYS:
                if k in result and isinstance(result[k], (int, float)):
                    result["estimated_hours"] = result[k]
                    break

        meta = {
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "elapsed_ms": elapsed_ms,
        }
        return result, meta

    except json.JSONDecodeError as e:
        elapsed_ms = (time.time() - start) * 1000
        raw_preview = text[:300] if 'text' in dir() else ""
        return None, {"error": f"JSON parse: {e}", "elapsed_ms": elapsed_ms, "raw": raw_preview}
    except Exception as e:
        elapsed_ms = (time.time() - start) * 1000
        return None, {"error": str(e)[:300], "elapsed_ms": elapsed_ms}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run_test(repo):
    if not OPENROUTER_API_KEY:
        print("ERROR: OPENROUTER_API_KEY not set")
        sys.exit(1)

    print("=" * 80)
    print("FD v2 Model Comparison: Holistic single-call estimation")
    print("=" * 80)

    all_results = []

    for commit in TEST_COMMITS:
        sha = commit["sha"]
        print(f"\n{'=' * 80}")
        print(f"COMMIT: {sha} -- {commit['label']}")
        print(f"Ground truth: {commit['gt_low']}-{commit['gt_high']}h (mid={commit['gt_mid']}h)")
        print("=" * 80)

        try:
            data = get_commit_data(repo, sha)
        except Exception as e:
            print(f"  ERROR getting commit data: {e}")
            continue

        prompt = build_prompt(data)
        prompt_chars = len(prompt)
        prompt_tokens_est = prompt_chars / 2.0

        # Print composition
        for cat in ["generated", "test", "config", "docs", "migration", "code"]:
            flist = data["by_cat"].get(cat, [])
            if flist:
                cat_la = sum(f["added"] for f in flist)
                print(f"  {cat}: {len(flist)} files, +{cat_la} lines")
        print(f"  Prompt: {prompt_chars:,} chars (~{prompt_tokens_est:,.0f} tokens)")
        print(f"  Top diffs included: {len(data['top_diffs'])} files")
        print()

        for tier, model_id, in_price, out_price in MODELS:
            print(f"  [{tier:>8}] {model_id}...", end="", flush=True)

            result, meta = call_model(model_id, SYSTEM_PROMPT, prompt, max_tokens=1024)

            if result is None:
                err = meta.get("error", "unknown")[:80]
                print(f" ERROR: {err}")
                all_results.append({
                    "sha": sha, "model": model_id, "tier": tier, "error": err,
                })
                # If rate limited, wait a bit
                if "429" in str(meta.get("error", "")) or "limit" in str(meta.get("error", "")).lower():
                    print("    (waiting 5s for rate limit...)")
                    time.sleep(5)
                continue

            est = result.get("estimated_hours", 0)
            reasoning = result.get("reasoning", "")[:120]

            gt_mid = commit["gt_mid"]
            ape = abs(est - gt_mid) / gt_mid * 100
            in_range = commit["gt_low"] <= est <= commit["gt_high"]
            marker = "IN GT" if in_range else ("HIGH" if est > commit["gt_high"] else "LOW")

            pt = meta.get("prompt_tokens", 0)
            ct = meta.get("completion_tokens", 0)
            elapsed = meta.get("elapsed_ms", 0)

            # Compute cost
            cost = pt / 1e6 * in_price + ct / 1e6 * out_price

            print(f" {est:6.1f}h [{marker:>5}] APE={ape:3.0f}% "
                  f"| {pt}+{ct} tok, {elapsed/1000:.1f}s, ${cost:.4f}")
            if reasoning:
                print(f"           \"{reasoning}\"")

            all_results.append({
                "sha": sha, "label": commit["label"],
                "model": model_id, "tier": tier,
                "estimate": est,
                "gt_low": commit["gt_low"], "gt_high": commit["gt_high"],
                "gt_mid": gt_mid, "ape": ape, "in_range": in_range,
                "prompt_tokens": pt, "completion_tokens": ct,
                "cost_usd": cost, "elapsed_ms": elapsed,
                "reasoning": reasoning,
            })

            # Small delay between models to avoid rate limiting
            time.sleep(1)

    # ---------------------------------------------------------------------------
    # Summary
    # ---------------------------------------------------------------------------
    print(f"\n{'=' * 80}")
    print("SUMMARY")
    print("=" * 80)

    # Per-model aggregation
    model_data = {}
    for r in all_results:
        if "error" in r:
            continue
        mid = r["model"]
        if mid not in model_data:
            model_data[mid] = {"tier": r["tier"], "apes": [], "in_range": 0, "total": 0,
                               "cost": 0, "estimates": []}
        model_data[mid]["apes"].append(r["ape"])
        model_data[mid]["total"] += 1
        if r["in_range"]:
            model_data[mid]["in_range"] += 1
        model_data[mid]["cost"] += r["cost_usd"]
        model_data[mid]["estimates"].append(f"{r['sha'][:7]}={r['estimate']:.0f}h")

    print(f"\n  {'Tier':>8}  {'Model':<42} {'MAPE':>6}  {'In GT':>6}  {'Cost':>8}  Estimates")
    print(f"  {'-'*8}  {'-'*42} {'-'*6}  {'-'*6}  {'-'*8}  {'-'*30}")

    for tier, model_id, _, _ in MODELS:
        if model_id not in model_data:
            print(f"  {tier:>8}  {model_id:<42} {'ERR':>6}")
            continue
        info = model_data[model_id]
        mape = sum(info["apes"]) / len(info["apes"])
        in_gt = f"{info['in_range']}/{info['total']}"
        cost = f"${info['cost']:.4f}"
        ests = ", ".join(info["estimates"])
        print(f"  {info['tier']:>8}  {model_id:<42} {mape:5.0f}%  {in_gt:>6}  {cost:>8}  {ests}")

    print()

    # Save results
    out_path = os.path.join(SCRIPT_DIR, "model_comparison_results.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(all_results, f, indent=2, ensure_ascii=False)
    print(f"Results saved to: {out_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Model comparison for FD v2")
    parser.add_argument("--repo", default=r"C:\Projects\_tmp_devghost_audit\artisan-private",
                        help="Path to artisan-private clone")
    args = parser.parse_args()

    if not os.path.isdir(args.repo):
        print(f"ERROR: repo not found at {args.repo}")
        sys.exit(1)

    run_test(args.repo)
