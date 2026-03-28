#!/usr/bin/env python3
"""
FD v2 Real LLM Validation against Ground Truth commits.

Runs the actual pipeline with OpenRouter on known commits,
compares estimates to expert ground truth ranges.

Usage:
  cd packages/server/scripts/pipeline
  set OPENROUTER_API_KEY=<key>
  python validate_fd_v2.py --repo C:\Projects\_tmp_devghost_audit\artisan-private

Optional:
  --branch-a   Enable Branch A with FD_LARGE_LLM_MODEL (default: anthropic/claude-sonnet-4)
  --no-cache   Disable LLM cache (force fresh calls)
  --model      Override default model (default: qwen/qwen-2.5-coder-32b-instruct)
"""
import argparse
import json
import os
import subprocess
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

# ---------------------------------------------------------------------------
# GT cases: sha, label, gt_low, gt_high, expect_v2
# ---------------------------------------------------------------------------

GT_CASES = [
    {
        "sha": "188c43e",
        "label": "Refactor/monorepo (#597) — 870 files, cross-repo copy",
        "gt_low": 15, "gt_high": 30,
        "expect_method": "FD_bulk_scaffold",
        "expect_v2": False,
    },
    {
        "sha": "1d02576",
        "label": "Feat/dialer v1 (#968) — 272 files, real feature",
        "gt_low": 40, "gt_high": 60,
        "expect_v2": True,
    },
    {
        "sha": "16dc74e",
        "label": "Feat/pnpm vitest migration (#974) — 1036 files, tooling",
        "gt_low": 8, "gt_high": 16,
        "expect_v2": True,
    },
    {
        "sha": "9c2a0ed",
        "label": "Feat/web visitors rehaul (#1048) — 159 files, feature",
        "gt_low": 25, "gt_high": 40,
        "expect_v2": True,
    },
    {
        "sha": "18156d0",
        "label": "Temporal scheduler (#939) — 123 files, feature",
        "gt_low": 20, "gt_high": 35,
        "expect_v2": True,
    },
    {
        "sha": "7d4a37e",
        "label": "Chat with Ava — feature",
        "gt_low": 15, "gt_high": 25,
        "expect_v2": True,
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


def get_diff_and_stats(repo, sha):
    parent = git_cmd(repo, "log", "--format=%P", "-1", sha).strip().split()[0]
    diff = git_cmd(repo, "diff", f"{parent}..{sha}")
    raw = git_cmd(repo, "diff", "--numstat", f"{parent}..{sha}")
    la, ld, fc = 0, 0, 0
    for line in raw.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) >= 3:
            if parts[0] != "-":
                la += int(parts[0])
                ld += int(parts[1])
            fc += 1
    return diff, fc, la, ld


def get_message(repo, sha):
    return git_cmd(repo, "log", "--format=%s", "-1", sha).strip()


# ---------------------------------------------------------------------------
# Run validation
# ---------------------------------------------------------------------------

def run_validation(repo, enable_branch_a=False, large_model="anthropic/claude-sonnet-4",
                   default_model="qwen/qwen-2.5-coder-32b-instruct", no_cache=False,
                   branch="B"):
    # Configure environment
    os.environ["LLM_PROVIDER"] = "openrouter"
    os.environ["OPENROUTER_MODEL"] = default_model
    os.environ["FD_V2_MIN_FILES"] = "50"
    os.environ["FD_V2_BRANCH"] = branch
    os.environ["FD_V2_HOLISTIC"] = "true"
    # Clear provider restrictions for validation — avoid 404 "all providers ignored"
    os.environ["OPENROUTER_PROVIDER_ORDER"] = ""
    os.environ["OPENROUTER_PROVIDER_IGNORE"] = ""
    os.environ["OPENROUTER_ALLOW_FALLBACKS"] = "true"
    os.environ["OPENROUTER_REQUIRE_PARAMETERS"] = "false"

    if enable_branch_a:
        os.environ["FD_LARGE_LLM_MODEL"] = large_model
        os.environ["FD_LARGE_LLM_PROVIDER"] = "openrouter"
    else:
        os.environ.pop("FD_LARGE_LLM_MODEL", None)
        os.environ.pop("FD_LARGE_LLM_PROVIDER", None)

    if no_cache:
        os.environ["NO_LLM_CACHE"] = "true"
    else:
        os.environ.pop("NO_LLM_CACHE", None)

    # Force reload config after env changes
    import run_v16_pipeline as pipeline
    pipeline.reload_config()

    from file_decomposition import run_fd_hybrid

    # Build LLM wrappers
    def call_llm(system, prompt, schema=None, max_tokens=1024):
        parsed, meta = pipeline.call_openrouter(system, prompt, schema, max_tokens)
        return parsed

    call_llm_large = None
    if enable_branch_a and pipeline.FD_LARGE_LLM_MODEL:
        def call_llm_large(system, prompt, schema=None, max_tokens=1024):
            cached = pipeline._read_llm_cache(system, prompt, schema, max_tokens,
                                               provider_override='openrouter',
                                               model_override=pipeline.FD_LARGE_LLM_MODEL)
            if cached is not None:
                print(" [cache-hit]", end="", flush=True)
                return cached[0]
            parsed, meta = pipeline.call_openrouter_large(system, prompt, schema, max_tokens)
            if parsed is not None:
                pipeline._write_llm_cache(system, prompt, schema, max_tokens, parsed, meta,
                                           provider_override='openrouter',
                                           model_override=pipeline.FD_LARGE_LLM_MODEL)
            return parsed

    # Run each GT case
    results = []
    print(f"\n{'='*70}")
    print(f"FD V2 REAL LLM VALIDATION")
    print(f"Default model: {default_model}")
    if enable_branch_a:
        print(f"Branch A model: {large_model}")
    else:
        print(f"Branch A: disabled")
    print(f"Cache: {'disabled' if no_cache else 'enabled'}")
    print(f"{'='*70}\n")

    for case in GT_CASES:
        sha = case["sha"]
        print(f"\n--- {sha[:7]} {case['label']} ---")
        print(f"    GT: {case['gt_low']}-{case['gt_high']}h")

        try:
            t0 = time.time()
            diff, fc, la, ld = get_diff_and_stats(repo, sha)
            msg = get_message(repo, sha)
            print(f"    Stats: {fc} files, +{la}/-{ld}, diff={len(diff)//1000}K chars")

            result = run_fd_hybrid(diff, msg, "typescript", fc, la, ld,
                                   call_llm, call_large_fn=call_llm_large)
            elapsed = time.time() - t0

            est = result["estimated_hours"]
            method = result.get("method", "?")
            fd_details = result.get("fd_details")

            # Determine if within GT range
            gt_mid = (case["gt_low"] + case["gt_high"]) / 2
            ape = abs(est - gt_mid) / gt_mid * 100 if gt_mid > 0 else 0
            in_range = case["gt_low"] <= est <= case["gt_high"]
            within_2x = est <= case["gt_high"] * 2

            status = "OK" if in_range else ("~OK" if within_2x else "MISS")

            print(f"    Result: {est:.1f}h  method={method}  ({elapsed:.1f}s)")
            print(f"    [{status}] APE={ape:.0f}% vs GT midpoint {gt_mid:.0f}h", end="")
            if in_range:
                print(" (within GT range)")
            elif within_2x:
                print(f" (outside range but within 2x)")
            else:
                print(f" (OUTSIDE 2x range!)")

            if fd_details:
                fs = fd_details.get("filter_stats", {})
                print(f"    Filter: skip={fs.get('skip', '?')} heur={fs.get('heuristic', '?')} llm={fs.get('llm', '?')}")
                heur_total = fd_details.get("heuristic_total", 0)
                print(f"    Heuristic total: {heur_total:.1f}h")
                clusters = fd_details.get("clusters", [])
                if clusters:
                    print(f"    Clusters: {len(clusters)}")
                    for c in clusters[:5]:
                        nf = c.get('n_files', '?')
                        ta = c.get('total_added', '?')
                        print(f"      - {c['name']}: {nf} files, +{ta} lines")

            results.append({
                "sha": sha,
                "label": case["label"],
                "gt_low": case["gt_low"],
                "gt_high": case["gt_high"],
                "gt_mid": gt_mid,
                "estimate": est,
                "method": method,
                "ape": ape,
                "in_range": in_range,
                "elapsed_s": elapsed,
            })

        except Exception as e:
            print(f"    ERROR: {e}")
            import traceback
            traceback.print_exc()
            results.append({
                "sha": sha,
                "label": case["label"],
                "gt_low": case["gt_low"],
                "gt_high": case["gt_high"],
                "gt_mid": (case["gt_low"] + case["gt_high"]) / 2,
                "estimate": None,
                "method": "ERROR",
                "ape": None,
                "in_range": False,
                "elapsed_s": 0,
                "error": str(e),
            })

    # Summary
    print(f"\n{'='*70}")
    print(f"SUMMARY")
    print(f"{'='*70}")
    print(f"{'SHA':<10} {'Estimate':>10} {'GT Range':>12} {'APE':>8} {'Status':<8} {'Method'}")
    print(f"{'-'*10} {'-'*10} {'-'*12} {'-'*8} {'-'*8} {'-'*20}")

    valid_apes = []
    for r in results:
        est_str = f"{r['estimate']:.1f}h" if r['estimate'] is not None else "ERROR"
        gt_str = f"{r['gt_low']}-{r['gt_high']}h"
        ape_str = f"{r['ape']:.0f}%" if r['ape'] is not None else "N/A"
        status = "OK" if r["in_range"] else "MISS"
        print(f"{r['sha']:<10} {est_str:>10} {gt_str:>12} {ape_str:>8} {status:<8} {r['method']}")
        if r["ape"] is not None:
            valid_apes.append(r["ape"])

    if valid_apes:
        mape = sum(valid_apes) / len(valid_apes)
        print(f"\nMAPE: {mape:.1f}% (target: <50%)")
        print(f"In-range: {sum(1 for r in results if r['in_range'])}/{len(results)}")
    print()

    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FD v2 real LLM validation")
    parser.add_argument("--repo", default=r"C:\Projects\_tmp_devghost_audit\artisan-private",
                        help="Path to artisan-private clone")
    parser.add_argument("--branch-a", action="store_true",
                        help="Enable Branch A with large model")
    parser.add_argument("--large-model", default="anthropic/claude-sonnet-4",
                        help="Model for Branch A")
    parser.add_argument("--model", default="qwen/qwen-2.5-coder-32b-instruct",
                        help="Default model for Branch B")
    parser.add_argument("--no-cache", action="store_true",
                        help="Disable LLM cache")
    parser.add_argument("--branch", default="B", choices=["A", "B"],
                        help="FD v2 branch (A=single-call, B=cluster)")
    args = parser.parse_args()

    if not os.path.isdir(args.repo):
        print(f"ERROR: repo not found at {args.repo}")
        sys.exit(1)

    if not os.environ.get("OPENROUTER_API_KEY"):
        # Try loading from .env
        env_path = os.path.join(SCRIPT_DIR, "..", "..", ".env")
        if os.path.exists(env_path):
            with open(env_path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("OPENROUTER_API_KEY=") and not line.startswith("#"):
                        os.environ["OPENROUTER_API_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break

    if not os.environ.get("OPENROUTER_API_KEY"):
        print("ERROR: OPENROUTER_API_KEY not set")
        sys.exit(1)

    results = run_validation(
        args.repo,
        enable_branch_a=args.branch_a,
        large_model=args.large_model,
        default_model=args.model,
        no_cache=args.no_cache,
        branch=args.branch,
    )
    sys.exit(0)
