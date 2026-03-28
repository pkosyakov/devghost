#!/usr/bin/env python3
r"""
FD v3 Production Path Validation against 10 Ground Truth commits.

Runs the full production pipeline end-to-end (run_commit with correction rules,
complexity guard, and hard cap) with FD_V3_ENABLED=true and qwen/qwen3-coder-plus.

Usage:
  cd packages\server\scripts\pipeline
  set OPENROUTER_API_KEY=<key>
  python validate_fd_v3.py --repo C:\Projects\_tmp_devghost_audit\artisan-private

Optional:
  --no-cache   Disable LLM cache (force fresh calls)
  --model      Override large model (default: qwen/qwen3-coder-plus)
"""
import argparse
import json
import os
import statistics
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

# All 10 large GT cases from experiment_v3.py
GT_CASES = [
    {"sha": "188c43e", "label": "Refactor/monorepo (#597) — 870 files, cross-repo copy",
     "gt_low": 15, "gt_high": 30},
    {"sha": "1d02576", "label": "Feat/dialer v1 (#968) — 272 files, real feature",
     "gt_low": 40, "gt_high": 60},
    {"sha": "0237e3a", "label": "Feat/workos auth (#751) — 388 files, auth+RBAC+billing",
     "gt_low": 30, "gt_high": 50},
    {"sha": "47252d6", "label": "Feat/magic campaigns (#842) — 391 files, AI campaigns",
     "gt_low": 40, "gt_high": 60},
    {"sha": "4ccdf71", "label": "Feat/leads lists (#1297) — 265 files, unified API+UI",
     "gt_low": 30, "gt_high": 50},
    {"sha": "16dc74e", "label": "Feat/pnpm vitest migration (#974) — 1036 files, tooling",
     "gt_low": 8, "gt_high": 16},
    {"sha": "9c2a0ed", "label": "Feat/web visitors (#1048) — 159 files, feature",
     "gt_low": 25, "gt_high": 40},
    {"sha": "b4bb3f0", "label": "Adhoc: leadsdb rework (#782) — 145 files, protobuf+refactor",
     "gt_low": 20, "gt_high": 35},
    {"sha": "18156d0", "label": "Temporal scheduler (#939) — 123 files, feature",
     "gt_low": 20, "gt_high": 35},
    {"sha": "c8269d0", "label": "UI library setup — 107 files, scaffold",
     "gt_low": 4, "gt_high": 8},
]


def resolve_full_sha(repo, short_sha):
    """Resolve abbreviated SHA to full SHA for run_commit()."""
    import subprocess
    result = subprocess.run(
        ["git", "rev-parse", short_sha],
        cwd=repo, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError(f"Cannot resolve SHA {short_sha}: {result.stderr.strip()}")
    return result.stdout.strip()


def get_message(repo, sha):
    import subprocess
    result = subprocess.run(
        ["git", "log", "--format=%s", "-1", sha],
        cwd=repo, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    )
    return result.stdout.strip()


def run_validation(repo, large_model="qwen/qwen3-coder-plus", no_cache=False):
    # Configure environment for v3 production path
    os.environ["LLM_PROVIDER"] = "openrouter"
    os.environ["OPENROUTER_MODEL"] = "qwen/qwen-2.5-coder-32b-instruct"
    os.environ["FD_V2_MIN_FILES"] = "50"
    os.environ["FD_V3_ENABLED"] = "true"
    os.environ["FD_LARGE_LLM_MODEL"] = large_model
    os.environ["FD_LARGE_LLM_PROVIDER"] = "openrouter"
    # Clear provider restrictions
    os.environ["OPENROUTER_PROVIDER_ORDER"] = ""
    os.environ["OPENROUTER_PROVIDER_IGNORE"] = ""
    os.environ["OPENROUTER_ALLOW_FALLBACKS"] = "true"
    os.environ["OPENROUTER_REQUIRE_PARAMETERS"] = "false"

    if no_cache:
        os.environ["NO_LLM_CACHE"] = "true"
    else:
        os.environ.pop("NO_LLM_CACHE", None)

    # Force reload config after env changes
    import run_v16_pipeline as pipeline
    pipeline.reload_config()

    # Run each GT case through the full production pipeline
    results = []
    print(f"\n{'='*70}")
    print(f"FD V3 PRODUCTION PATH VALIDATION (end-to-end via run_commit)")
    print(f"Large model: {large_model}")
    print(f"FD_V3_ENABLED: {os.environ.get('FD_V3_ENABLED')}")
    print(f"Cache: {'disabled' if no_cache else 'enabled'}")
    print(f"{'='*70}\n")

    for case in GT_CASES:
        short_sha = case["sha"]
        print(f"\n--- {short_sha[:7]} {case['label']} ---")
        print(f"    GT: {case['gt_low']}-{case['gt_high']}h")

        try:
            full_sha = resolve_full_sha(repo, short_sha)
            msg = get_message(repo, full_sha)

            t0 = time.time()
            result = pipeline.run_commit(repo, "typescript", full_sha, msg)
            elapsed = time.time() - t0

            est = result["estimated_hours"]
            raw = result.get("raw_estimate", est)
            method = result.get("method", "?")
            routed_to = result.get("routed_to", "?")
            rule = result.get("rule_applied")
            cg = result.get("complexity_guard")
            cap = result.get("hard_cap")
            fd_details = result.get("fd_details") or {}

            gt_mid = (case["gt_low"] + case["gt_high"]) / 2
            ape = abs(est - gt_mid) / gt_mid * 100 if gt_mid > 0 else 0
            in_range = case["gt_low"] <= est <= case["gt_high"]
            within_2x = est <= case["gt_high"] * 2 and est >= case["gt_low"] * 0.5

            status = "OK" if in_range else ("~2x" if within_2x else "MISS")

            print(f"    Result: {est:.1f}h (raw={raw:.1f}h)  method={method}  route={routed_to}  ({elapsed:.1f}s)")
            if rule:
                print(f"    Correction rule: {rule}")
            if cg:
                print(f"    Complexity guard: {cg}")
            if cap:
                print(f"    Hard cap: {cap}")
            print(f"    [{status}] APE={ape:.0f}% vs GT midpoint {gt_mid:.0f}h")

            # Print v3-specific details
            if fd_details.get("version") == "v3":
                print(f"    Confidence: {fd_details.get('confidence', '?')}")
                print(f"    Range: {fd_details.get('estimate_low', '?')}-"
                      f"{fd_details.get('estimate_mid', '?')}-"
                      f"{fd_details.get('estimate_high', '?')}h")
                reasoning = fd_details.get("reasoning", "")
                if reasoning:
                    print(f"    Reasoning: {reasoning[:200]}")

            fs = fd_details.get("filter_stats", {})
            if fs:
                print(f"    Filter: skip={fs.get('skip', '?')} heur={fs.get('heuristic', '?')} llm={fs.get('llm', '?')}")
            heur_meta = fd_details.get("heuristic_total_metadata", fd_details.get("heuristic_total"))
            if heur_meta is not None:
                print(f"    Heuristic (metadata): {heur_meta:.1f}h")

            results.append({
                "sha": short_sha,
                "label": case["label"],
                "gt_low": case["gt_low"],
                "gt_high": case["gt_high"],
                "gt_mid": gt_mid,
                "estimate": est,
                "raw_estimate": raw,
                "method": method,
                "routed_to": routed_to,
                "rule_applied": rule,
                "complexity_guard": cg,
                "hard_cap": cap,
                "ape": ape,
                "in_range": in_range,
                "within_2x": within_2x,
                "elapsed_s": elapsed,
                "confidence": fd_details.get("confidence"),
                "reasoning": fd_details.get("reasoning"),
            })

        except Exception as e:
            print(f"    ERROR: {e}")
            import traceback
            traceback.print_exc()
            results.append({
                "sha": short_sha,
                "label": case["label"],
                "gt_low": case["gt_low"],
                "gt_high": case["gt_high"],
                "gt_mid": (case["gt_low"] + case["gt_high"]) / 2,
                "estimate": None,
                "method": "ERROR",
                "ape": None,
                "in_range": False,
                "within_2x": False,
                "elapsed_s": 0,
                "error": str(e),
            })

    # Summary
    print(f"\n{'='*70}")
    print(f"SUMMARY — FD v3 Production Path (end-to-end)")
    print(f"{'='*70}")
    print(f"{'SHA':<10} {'Final':>8} {'Raw':>8} {'GT Range':>12} {'APE':>8} {'Status':<8} {'Method':<25} {'Route'}")
    print(f"{'-'*10} {'-'*8} {'-'*8} {'-'*12} {'-'*8} {'-'*8} {'-'*25} {'-'*15}")

    valid_apes = []
    for r in results:
        est_str = f"{r['estimate']:.1f}h" if r['estimate'] is not None else "ERROR"
        raw_str = f"{r.get('raw_estimate', 0):.1f}h" if r.get('raw_estimate') is not None else "?"
        gt_str = f"{r['gt_low']}-{r['gt_high']}h"
        ape_str = f"{r['ape']:.0f}%" if r['ape'] is not None else "N/A"
        status = "OK" if r["in_range"] else ("~2x" if r.get("within_2x") else "MISS")
        method = r.get('method', '?')
        route = r.get('routed_to', '?')
        print(f"{r['sha']:<10} {est_str:>8} {raw_str:>8} {gt_str:>12} {ape_str:>8} {status:<8} {method:<25} {route}")
        if r["ape"] is not None:
            valid_apes.append(r["ape"])

    if valid_apes:
        mape = sum(valid_apes) / len(valid_apes)
        mdape = statistics.median(valid_apes)
        in_range_count = sum(1 for r in results if r["in_range"])
        within_2x_count = sum(1 for r in results if r.get("within_2x"))
        signed_errors = [r["estimate"] - r["gt_mid"] for r in results if r["estimate"] is not None]
        mean_bias = sum(signed_errors) / len(signed_errors) if signed_errors else 0

        # Show post-processing impact
        post_processed = [r for r in results if r.get("rule_applied") or r.get("complexity_guard") or r.get("hard_cap")]

        print(f"\nMAPE: {mape:.1f}% (target: <40%)")
        print(f"MdAPE: {mdape:.1f}%")
        print(f"In-range: {in_range_count}/{len(results)}")
        print(f"Within 2x: {within_2x_count}/{len(results)}")
        print(f"Mean bias: {mean_bias:+.1f}h ({'over' if mean_bias > 0 else 'under'}estimating)")
        if post_processed:
            print(f"Post-processed: {len(post_processed)}/{len(results)} commits had correction rules/guard/cap applied")
            for r in post_processed:
                mods = []
                if r.get("rule_applied"):
                    mods.append(f"rule={r['rule_applied']}")
                if r.get("complexity_guard"):
                    mods.append(f"cg={r['complexity_guard']}")
                if r.get("hard_cap"):
                    mods.append(f"cap={r['hard_cap']}")
                print(f"  {r['sha']}: raw={r.get('raw_estimate', '?')}h -> final={r['estimate']}h ({', '.join(mods)})")
        else:
            print(f"Post-processed: 0/{len(results)} (no correction rules, guards, or caps applied)")
    print()

    # Save results JSON
    results_path = os.path.join(SCRIPT_DIR, "validate_fd_v3_results.json")
    with open(results_path, "w", encoding="utf-8") as f:
        json.dump({"model": large_model, "pipeline": "run_commit (end-to-end)",
                   "results": results,
                   "mape": mape if valid_apes else None,
                   "in_range": in_range_count if valid_apes else 0},
                  f, indent=2, ensure_ascii=False)
    print(f"Results saved to {results_path}")

    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FD v3 production path validation (end-to-end)")
    parser.add_argument("--repo", default=r"C:\Projects\_tmp_devghost_audit\artisan-private",
                        help="Path to artisan-private clone")
    parser.add_argument("--model", default="qwen/qwen3-coder-plus",
                        help="Large model for v3 path")
    parser.add_argument("--no-cache", action="store_true",
                        help="Disable LLM cache")
    args = parser.parse_args()

    if not os.path.isdir(args.repo):
        print(f"ERROR: repo not found at {args.repo}")
        sys.exit(1)

    if not os.environ.get("OPENROUTER_API_KEY"):
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

    results = run_validation(args.repo, large_model=args.model, no_cache=args.no_cache)
    sys.exit(0)
