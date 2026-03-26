#!/usr/bin/env python3
"""
Regression tests for FD pipeline fixes.

Calls the PRODUCTION run_fd_hybrid() with mock LLM against known commits.
Validates routing decisions, not exact estimates (LLM estimates vary by model).

Usage:
  cd packages/server/scripts/pipeline
  python test_fd_regression.py --repo /path/to/artisan-private

Requires: local clone of artisan-private with blob access (authenticated remote).
"""
import argparse
import os
import re
import subprocess
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from file_decomposition import run_fd_hybrid


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
# Mock LLM factory
# ---------------------------------------------------------------------------

class _ClassifyDone(BaseException):
    """Raised by mock LLM after classify completes to abort before full FD.

    Inherits from BaseException (not Exception) so it won't be caught by
    `except Exception` handlers inside the pipeline code.
    """
    pass


def make_mock_llm(new_logic_pct=45, abort_after_classify=False):
    """Create a mock LLM that tracks calls and returns configurable classify results.

    If abort_after_classify=True, raises _ClassifyDone after the first classify call
    returns — this cleanly stops the pipeline before full FD runs, allowing us to
    verify routing without needing a full FD-compatible mock.
    """
    calls = []
    classify_done = [False]

    def mock(system, prompt, schema=None, max_tokens=1024):
        is_classify = "Classify" in prompt or "classify" in prompt.lower()[:100]
        calls.append("classify" if is_classify else "estimate")
        if is_classify:
            classify_done[0] = True
            return {
                "change_type": "feature",
                "new_logic_percent": new_logic_pct,
                "moved_or_copied_percent": 10,
                "boilerplate_percent": 20,
                "architectural_scope": "module",
                "cognitive_complexity": "high",
                "summary": "Mock classify",
            }
        # After classify, abort if requested — pipeline tried to proceed past routing
        if abort_after_classify and classify_done[0]:
            raise _ClassifyDone("classify completed, aborting before full FD")
        return {"estimated_hours": 35.0, "reasoning": "Mock estimate"}

    return mock, calls


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------

# Each test case: (sha, message_override, expected_method_prefix, expected_no_early_exit, description)
# message_override=None means use real commit message from git

SCAFFOLD_CASES = [
    {
        "sha": "188c43e",
        "label": "monorepo migration (keyword: monorepo)",
        "ground_truth": (8, 30),
        "expect_method": "FD_bulk_scaffold",
        "expect_llm_calls": 0,
    },
    {
        "sha": "c8269d0",
        "label": "UI library setup (keyword: wip+setup)",
        "ground_truth": (4, 8),
        "expect_method": "FD_bulk_scaffold",
        "expect_llm_calls": 0,
    },
]

FEATURE_CASES = [
    {
        "sha": "1d02576",
        "label": "Feat/dialer v1 (real feature, 90% new)",
        "ground_truth": (40, 60),
        "expect_method_not": "FD_bulk_scaffold",
        "expect_llm_classify": True,
    },
    {
        "sha": "9c2a0ed",
        "label": "Web visitors rehaul (real feature, 91% new)",
        "ground_truth": (25, 40),
        "expect_method_not": "FD_bulk_scaffold",
        "expect_llm_classify": True,
    },
    {
        "sha": "18156d0",
        "label": "Temporal scheduler (real feature, 85% new)",
        "ground_truth": (20, 35),
        "expect_method_not": "FD_bulk_scaffold",
        "expect_llm_classify": True,
    },
    {
        "sha": "7d4a37e",
        "label": "Chat with Ava (real feature, 83% new)",
        "ground_truth": (15, 25),
        "expect_method_not": "FD_bulk_scaffold",
        "expect_llm_classify": True,
    },
]

# Test that force_complex guard works (these have migration files but high new_file_ratio)
FORCE_COMPLEX_GUARD_CASES = [
    {
        "sha": "1d02576",
        "label": "Dialer: 12 migration files, 90% new -> force_complex should NOT fire",
        "expect_force_complex_bypassed": True,
    },
    {
        "sha": "9c2a0ed",
        "label": "Visitors: 9 migration files, 91% new -> force_complex should NOT fire",
        "expect_force_complex_bypassed": True,
    },
]


# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------

def run_tests(repo):
    passed = 0
    failed = 0
    errors = []

    # Redirect stdout to suppress pipeline prints on Windows (Unicode issues)
    original_stdout = sys.stdout

    # --- Scaffold tests: should early-exit, 0 LLM calls ---
    print("\n=== SCAFFOLD COMMITS (expect early exit, 0 LLM calls) ===\n")
    for case in SCAFFOLD_CASES:
        sha = case["sha"]
        try:
            diff, fc, la, ld = get_diff_and_stats(repo, sha)
            msg = get_message(repo, sha)
            mock_llm, calls = make_mock_llm()

            # Suppress pipeline prints
            sys.stdout = open(os.devnull, "w", encoding="utf-8")
            try:
                result = run_fd_hybrid(diff, msg, "typescript", fc, la, ld, mock_llm)
            finally:
                sys.stdout.close()
                sys.stdout = original_stdout

            method = result["method"]
            est = result["estimated_hours"]
            gt_lo, gt_hi = case["ground_truth"]
            llm_count = len(calls)

            ok_method = method == case["expect_method"]
            ok_llm = llm_count == case["expect_llm_calls"]
            ok_range = est <= gt_hi * 2  # allow 2x over ground truth upper bound

            test_ok = ok_method and ok_llm and ok_range
            status = "PASS" if test_ok else "FAIL"

            details = []
            if not ok_method:
                details.append(f"method={method}, expected {case['expect_method']}")
            if not ok_llm:
                details.append(f"llm_calls={llm_count}, expected {case['expect_llm_calls']}")
            if not ok_range:
                details.append(f"est={est:.1f}h > {gt_hi*2}h (2x GT upper)")

            detail_str = f" ({', '.join(details)})" if details else ""
            print(f"  [{status}] {sha:.7s} {case['label']}")
            print(f"         method={method}, est={est:.1f}h, GT={gt_lo}-{gt_hi}h, LLM={llm_count}{detail_str}")

            if test_ok:
                passed += 1
            else:
                failed += 1
                errors.append(f"SCAFFOLD {sha}: {detail_str}")

        except Exception as e:
            sys.stdout = original_stdout
            print(f"  [ERROR] {sha:.7s} {case['label']}: {e}")
            failed += 1
            errors.append(f"SCAFFOLD {sha}: exception {e}")

    # --- Feature tests: verify ROUTING only ---
    # These tests prove: scaffold early exit does NOT fire, LLM classify IS called.
    # They do NOT validate estimate accuracy (that requires real LLM calls).
    #
    # Mechanism: mock LLM raises _ClassifyDone after classify returns, cleanly
    # aborting before full FD runs. If scaffold early exit fired, classify would
    # never be called and _ClassifyDone would never be raised.
    print("\n=== FEATURE COMMITS (routing: no scaffold early exit, classify called) ===\n")
    # Disable v2 for feature routing tests — they validate v1 classify routing
    os.environ["FD_V2_MIN_FILES"] = "999999"
    for case in FEATURE_CASES:
        sha = case["sha"]
        try:
            diff, fc, la, ld = get_diff_and_stats(repo, sha)
            msg = get_message(repo, sha)
            mock_llm, calls = make_mock_llm(new_logic_pct=45, abort_after_classify=True)

            got_classify_done = False
            got_scaffold_result = False

            sys.stdout = open(os.devnull, "w", encoding="utf-8")
            try:
                result = run_fd_hybrid(diff, msg, "typescript", fc, la, ld, mock_llm)
                # If we get here without _ClassifyDone, check if it's scaffold early exit
                got_scaffold_result = (result.get("method") == "FD_bulk_scaffold"
                                       or result.get("rule_applied") == "bulk_scaffold_detector")
            except _ClassifyDone:
                # Expected: classify ran, then pipeline tried to proceed, mock aborted it
                got_classify_done = True
            finally:
                sys.stdout.close()
                sys.stdout = original_stdout

            gt_lo, gt_hi = case["ground_truth"]

            # PASS conditions:
            # 1. _ClassifyDone was raised (classify called, pipeline proceeded past scaffold check)
            # 2. OR: pipeline returned a non-scaffold result (e.g., cheap signal or mechanical)
            ok = got_classify_done or (not got_scaffold_result and "classify" in calls)
            status = "PASS" if ok else "FAIL"

            details = []
            if got_classify_done:
                details.append("classify called, routed to FD (aborted by mock)")
            elif got_scaffold_result:
                details.append("WRONG: scaffold early exit fired on a feature commit")
            else:
                details.append(f"returned without scaffold, calls={calls[:3]}")

            print(f"  [{status}] {sha:.7s} {case['label']}")
            print(f"         {', '.join(details)}, GT={gt_lo}-{gt_hi}h")

            if ok:
                passed += 1
            else:
                failed += 1
                errors.append(f"FEATURE {sha}: {', '.join(details)}")

        except Exception as e:
            sys.stdout = original_stdout
            print(f"  [FAIL] {sha:.7s} {case['label']}: unexpected exception: {e}")
            failed += 1
            errors.append(f"FEATURE {sha}: unexpected exception {e}")

    os.environ.pop("FD_V2_MIN_FILES", None)

    # --- Summary ---
    print(f"\n{'=' * 60}")
    total = passed + failed
    print(f"Results: {passed}/{total} passed, {failed} failed")
    if errors:
        print("\nFailures:")
        for e in errors:
            print(f"  - {e}")
    print()

    return failed == 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FD pipeline regression tests")
    parser.add_argument("--repo", default=r"C:\Projects\_tmp_devghost_audit\artisan-private",
                        help="Path to artisan-private clone")
    args = parser.parse_args()

    if not os.path.isdir(args.repo):
        print(f"ERROR: repo not found at {args.repo}")
        sys.exit(1)

    success = run_tests(args.repo)
    sys.exit(0 if success else 1)
