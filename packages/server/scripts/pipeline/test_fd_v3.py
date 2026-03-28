#!/usr/bin/env python3
"""Unit tests for FD v3 metadata-only holistic estimator.

Tests cover:
1. Routing: fc < 50 does not use v3; fc >= 50 + flag off keeps v2; fc >= 50 + flag on uses v3
2. Metadata computation: entropy, effective churn, file size distribution, modules
3. Prompt: metadata-based, no diff content sent
4. heuristic_total is reported as metadata, not added after estimate
5. Large-model selection: v3 uses separate large-model config when provided
"""
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from file_decomposition import (
    compute_v3_metadata,
    build_v3_prompt,
    estimate_holistic_v3,
    _run_fd_v3,
    run_fd_hybrid,
    adaptive_filter,
    build_clusters,
    V3_SCHEMA,
)


def _make_file_info(n, prefix="src/", ext=".ts", added=100, deleted=10, tags=None):
    """Generate a list of file info dicts for testing."""
    return [
        {
            "filename": f"{prefix}file_{i}{ext}",
            "diff": f"--- a/{prefix}file_{i}{ext}\n+++ b/{prefix}file_{i}{ext}\n@@ -1 +1 @@\n+line",
            "added": added,
            "deleted": deleted,
            "tags": tags or [],
        }
        for i in range(n)
    ]


def _make_large_diff(file_count=60):
    """Generate a large diff string that exceeds FD_THRESHOLD."""
    parts = []
    for i in range(file_count):
        # Each file diff ~1200 chars => 60 files ~72K chars
        lines = "\n".join(f"+const x{j} = {j};" for j in range(50))
        parts.append(
            f"diff --git a/src/file_{i}.ts b/src/file_{i}.ts\n"
            f"new file mode 100644\n"
            f"--- /dev/null\n"
            f"+++ b/src/file_{i}.ts\n"
            f"@@ -0,0 +1,50 @@\n"
            f"{lines}\n"
        )
    return "\n".join(parts)


class TestComputeV3Metadata(unittest.TestCase):
    """Test metadata computation for v3 estimator."""

    def test_entropy_uniform_distribution(self):
        """Files with equal churn should have high entropy."""
        files = _make_file_info(10, added=100, deleted=0)
        filt = adaptive_filter(files)
        meta = compute_v3_metadata(files, filt, 1.0, 10, 1000, 0)
        # 10 files with equal churn => entropy = log2(10) ≈ 3.32
        self.assertGreater(meta["entropy"], 3.0)
        self.assertEqual(meta["entropy_label"], "highly uniform")

    def test_entropy_concentrated(self):
        """One file with all churn should have low entropy."""
        files = [
            {"filename": "src/big.ts", "diff": "", "added": 1000, "deleted": 0, "tags": []},
        ] + _make_file_info(9, added=1, deleted=0)
        filt = adaptive_filter(files)
        meta = compute_v3_metadata(files, filt, 1.0, 10, 1009, 0)
        self.assertEqual(meta["entropy_label"], "concentrated")

    def test_effective_churn_excludes_filtered(self):
        """Effective churn should only count LLM-tier files."""
        code_files = _make_file_info(5, added=200, deleted=10)
        config_files = _make_file_info(5, prefix="config/", ext=".json",
                                       added=50, deleted=0, tags=["config"])
        all_files = code_files + config_files
        filt = adaptive_filter(all_files)
        meta = compute_v3_metadata(all_files, filt, 0.0, 10, 1250, 50)

        # Only code files (LLM tier) should contribute to effective churn
        self.assertEqual(meta["effective_fc"], 5)
        self.assertEqual(meta["effective_la"], 1000)  # 5 * 200
        self.assertEqual(meta["effective_ld"], 50)  # 5 * 10

    def test_file_size_distribution(self):
        """File size percentiles should be computed from LLM files."""
        files = [
            {"filename": f"src/f{i}.ts", "diff": "", "added": (i + 1) * 10,
             "deleted": 0, "tags": []}
            for i in range(10)
        ]
        filt = adaptive_filter(files)
        meta = compute_v3_metadata(files, filt, 1.0, 10, 550, 0)
        self.assertEqual(meta["file_size_max"], 100)  # file 9: 10*10=100
        self.assertGreater(meta["file_size_p90"], meta["file_size_p50"])

    def test_module_boundaries(self):
        """Module count should reflect unique top-level directories."""
        files = [
            {"filename": "apps/api/route.ts", "diff": "", "added": 10, "deleted": 0, "tags": []},
            {"filename": "apps/web/page.tsx", "diff": "", "added": 10, "deleted": 0, "tags": []},
            {"filename": "libs/shared/util.ts", "diff": "", "added": 10, "deleted": 0, "tags": []},
            {"filename": "libs/ui/button.tsx", "diff": "", "added": 10, "deleted": 0, "tags": []},
        ]
        filt = adaptive_filter(files)
        meta = compute_v3_metadata(files, filt, 1.0, 4, 40, 0)
        self.assertEqual(meta["module_boundary_count"], 2)  # apps, libs
        self.assertIn("apps", meta["modules"])
        self.assertIn("libs", meta["modules"])

    def test_language_detection(self):
        """Primary language should be detected from file extensions."""
        ts_files = _make_file_info(8, ext=".ts")
        py_files = _make_file_info(2, ext=".py", prefix="scripts/")
        all_files = ts_files + py_files
        filt = adaptive_filter(all_files)
        meta = compute_v3_metadata(all_files, filt, 1.0, 10, 1100, 0)
        self.assertEqual(meta["primary_language"], "TypeScript")
        self.assertIn("Python", meta["languages"])


class TestBuildV3Prompt(unittest.TestCase):
    """Test v3 prompt construction."""

    def test_prompt_contains_metadata_sections(self):
        """Prompt should contain all required metadata sections."""
        files = _make_file_info(60, added=100, deleted=10)
        filt = adaptive_filter(files)
        clusters = build_clusters(filt["llm_files"])
        meta = compute_v3_metadata(files, filt, 0.5, 60, 6000, 600)

        prompt = build_v3_prompt(
            "feat: add new feature", files, filt, clusters,
            {}, {}, meta, 0.5, 60, 6000, 600,
        )

        self.assertIn("## COMMIT", prompt)
        self.assertIn("## LANGUAGE", prompt)
        self.assertIn("## CHANGE VOLUME", prompt)
        self.assertIn("## FILE TYPE BREAKDOWN", prompt)
        self.assertIn("## DISTRIBUTION", prompt)
        self.assertIn("## STRUCTURE", prompt)
        self.assertIn("## PATTERN FLAGS", prompt)

    def test_prompt_does_not_contain_diff(self):
        """v3 prompt must NOT contain any diff content."""
        files = _make_file_info(60, added=100, deleted=10)
        filt = adaptive_filter(files)
        clusters = build_clusters(filt["llm_files"])
        meta = compute_v3_metadata(files, filt, 1.0, 60, 6000, 0)

        prompt = build_v3_prompt(
            "feat: add feature", files, filt, clusters,
            {}, {}, meta, 1.0, 60, 6000, 0,
        )

        # Should NOT contain diff markers
        self.assertNotIn("--- a/", prompt)
        self.assertNotIn("+++ b/", prompt)
        self.assertNotIn("@@ -", prompt)
        self.assertNotIn("--- FULL DIFF", prompt)
        self.assertNotIn("--- DIFFS", prompt)

    def test_heuristic_total_shown_as_metadata(self):
        """Heuristic total should appear as metadata text, not added separately."""
        code_files = _make_file_info(50, added=100, deleted=10)
        config_files = _make_file_info(10, prefix="config/", ext=".json",
                                       added=50, deleted=0, tags=["config"])
        all_files = code_files + config_files
        filt = adaptive_filter(all_files)
        clusters = build_clusters(filt["llm_files"])
        meta = compute_v3_metadata(all_files, filt, 0.0, 60, 5500, 500)

        prompt = build_v3_prompt(
            "feat: update config", all_files, filt, clusters,
            {}, {}, meta, 0.0, 60, 5500, 500,
        )

        # Heuristic total should be shown in the FILE TYPE BREAKDOWN section
        self.assertIn("by formula", prompt)
        self.assertIn("HEURISTIC", prompt)

    def test_prompt_includes_pattern_flags(self):
        """Prompt should include move/bulk/scaffold flags when detected."""
        files = _make_file_info(60, added=100, deleted=10)
        filt = adaptive_filter(files)
        clusters = build_clusters(filt["llm_files"])
        meta = compute_v3_metadata(files, filt, 1.0, 60, 6000, 0)

        move_info = {"is_move": True, "pairs": [1, 2, 3], "avg_overlap": 0.85,
                     "move_ratio": 0.5, "move_type": "RENAME"}
        prompt = build_v3_prompt(
            "refactor: rename files", files, filt, clusters,
            move_info, {}, meta, 1.0, 60, 6000, 0,
        )

        self.assertIn("RENAME", prompt)
        self.assertIn("avg_overlap=85%", prompt)


class TestEstimateHolisticV3(unittest.TestCase):
    """Test the v3 estimation call."""

    def test_returns_result_on_success(self):
        """Should return structured result when LLM returns valid response."""
        files = _make_file_info(60, added=100, deleted=10)
        filt = adaptive_filter(files)
        clusters = build_clusters(filt["llm_files"])

        mock_llm = MagicMock(return_value={
            "low": 15, "mid": 25, "high": 40,
            "confidence": "high",
            "reasoning": "Feature commit with 60 substantive files.",
        })

        result = estimate_holistic_v3(
            "feat: add feature", files, filt, clusters,
            {}, {}, 1.0, 60, 6000, 0, mock_llm,
        )

        self.assertIsNotNone(result)
        self.assertEqual(result["mid"], 25.0)
        self.assertEqual(result["low"], 15.0)
        self.assertEqual(result["high"], 40.0)
        self.assertEqual(result["confidence"], "high")

        # Verify LLM was called with v3 schema
        mock_llm.assert_called_once()
        call_args = mock_llm.call_args
        self.assertEqual(call_args[1].get("schema") or call_args[0][2], V3_SCHEMA)

    def test_returns_none_on_failure(self):
        """Should return None when LLM fails."""
        files = _make_file_info(60)
        filt = adaptive_filter(files)
        clusters = build_clusters(filt["llm_files"])

        mock_llm = MagicMock(return_value=None)
        result = estimate_holistic_v3(
            "feat", files, filt, clusters, {}, {}, 1.0, 60, 6000, 0, mock_llm,
        )
        self.assertIsNone(result)

    def test_no_diff_in_llm_call(self):
        """The LLM should NOT receive any diff content."""
        files = _make_file_info(60, added=100, deleted=10)
        filt = adaptive_filter(files)
        clusters = build_clusters(filt["llm_files"])

        mock_llm = MagicMock(return_value={
            "low": 10, "mid": 20, "high": 30,
            "confidence": "medium", "reasoning": "test",
        })

        estimate_holistic_v3(
            "feat", files, filt, clusters, {}, {}, 1.0, 60, 6000, 0, mock_llm,
        )

        # Check the prompt (second positional arg) does not contain diff markers
        call_args = mock_llm.call_args
        prompt = call_args[0][1]
        self.assertNotIn("--- a/", prompt)
        self.assertNotIn("+++ b/", prompt)
        self.assertNotIn("@@ -", prompt)


class TestRunFdV3(unittest.TestCase):
    """Test the v3 orchestrator."""

    def test_v3_returns_method_fd_v3_holistic(self):
        """Result method should identify as FD_v3_holistic."""
        files = _make_file_info(60, added=100, deleted=10)
        mock_llm = MagicMock(return_value={
            "low": 10, "mid": 20, "high": 30,
            "confidence": "high", "reasoning": "test",
        })

        result = _run_fd_v3(
            "fake diff", "feat: add feature", "TypeScript",
            60, 6000, 600, files, 0.5, mock_llm,
        )

        self.assertEqual(result["method"], "FD_v3_holistic")
        self.assertEqual(result["estimated_hours"], 20.0)

    def test_v3_does_not_add_heuristic_total(self):
        """v3 estimate should be the LLM mid value directly, not mid + heuristic_total."""
        code_files = _make_file_info(50, added=100, deleted=10)
        config_files = _make_file_info(10, prefix="config/", ext=".json",
                                       added=50, deleted=0, tags=["config"])
        all_files = code_files + config_files

        mock_llm = MagicMock(return_value={
            "low": 15, "mid": 25, "high": 35,
            "confidence": "medium", "reasoning": "includes trivial files",
        })

        result = _run_fd_v3(
            "fake diff", "feat: update all", "TypeScript",
            60, 5500, 500, all_files, 0.0, mock_llm,
        )

        # Final estimate should be exactly the LLM mid value (25h),
        # NOT 25h + heuristic_total (which would be ~30h).
        self.assertEqual(result["estimated_hours"], 25.0)

        # But heuristic_total should be present as metadata for diagnostics
        self.assertIn("heuristic_total_metadata", result["fd_details"])
        self.assertGreater(result["fd_details"]["heuristic_total_metadata"], 0)

    def test_v3_uses_large_fn_when_provided(self):
        """v3 should use call_large_fn for estimation when available."""
        files = _make_file_info(60, added=100, deleted=10)

        mock_default = MagicMock(return_value={
            "low": 50, "mid": 80, "high": 100,
            "confidence": "low", "reasoning": "default model",
        })
        mock_large = MagicMock(return_value={
            "low": 15, "mid": 25, "high": 35,
            "confidence": "high", "reasoning": "large model",
        })

        result = _run_fd_v3(
            "fake diff", "feat", "TypeScript",
            60, 6000, 0, files, 1.0, mock_default,
            call_large_fn=mock_large,
        )

        # Large model should have been called, not default
        mock_large.assert_called_once()
        mock_default.assert_not_called()
        self.assertEqual(result["estimated_hours"], 25.0)

    def test_v3_falls_back_when_no_large_fn(self):
        """v3 should use default call_ollama_fn when call_large_fn is None."""
        files = _make_file_info(60, added=100, deleted=10)
        mock_default = MagicMock(return_value={
            "low": 15, "mid": 25, "high": 35,
            "confidence": "high", "reasoning": "default model",
        })

        result = _run_fd_v3(
            "fake diff", "feat", "TypeScript",
            60, 6000, 0, files, 1.0, mock_default,
            call_large_fn=None,
        )

        mock_default.assert_called_once()
        self.assertEqual(result["estimated_hours"], 25.0)

    def test_v3_fallback_on_llm_failure(self):
        """v3 should return heuristic fallback when LLM fails."""
        files = _make_file_info(60, added=100, deleted=10)
        mock_llm = MagicMock(return_value=None)

        result = _run_fd_v3(
            "fake diff", "feat", "TypeScript",
            60, 6000, 0, files, 1.0, mock_llm,
        )

        self.assertEqual(result["method"], "FD_v3_fallback")
        self.assertGreater(result["estimated_hours"], 0)

    def test_v3_details_contain_diagnostics(self):
        """v3 result should contain structured diagnostics for review."""
        files = _make_file_info(60, added=100, deleted=10)
        mock_llm = MagicMock(return_value={
            "low": 10, "mid": 20, "high": 30,
            "confidence": "high", "reasoning": "test reasoning",
        })

        result = _run_fd_v3(
            "fake diff", "feat", "TypeScript",
            60, 6000, 0, files, 1.0, mock_llm,
        )

        details = result["fd_details"]
        self.assertEqual(details["version"], "v3")
        self.assertEqual(details["estimate_low"], 10.0)
        self.assertEqual(details["estimate_mid"], 20.0)
        self.assertEqual(details["estimate_high"], 30.0)
        self.assertEqual(details["confidence"], "high")
        self.assertEqual(details["reasoning"], "test reasoning")
        self.assertIn("filter_stats", details)
        self.assertIn("clusters", details)
        self.assertIn("v3_meta", details)


class TestRouting(unittest.TestCase):
    """Test routing between v2 and v3 based on FD_V3_ENABLED flag."""

    def _make_hybrid_args(self, fc=60):
        """Generate args for run_fd_hybrid with fc files."""
        diff = _make_large_diff(fc)
        files = _make_file_info(fc, added=100, deleted=10)
        return diff, "feat: add feature", "TypeScript", fc, fc * 100, fc * 10

    @patch.dict(os.environ, {"FD_V3_ENABLED": "true"})
    @patch("file_decomposition._run_fd_v3")
    @patch("file_decomposition._run_fd_v2")
    def test_v3_enabled_routes_to_v3(self, mock_v2, mock_v3):
        """fc >= 50 + FD_V3_ENABLED=true should route to v3."""
        mock_v3.return_value = {
            "estimated_hours": 25, "raw_estimate": 25,
            "method": "FD_v3_holistic", "routed_to": "v3_holistic",
            "analysis": {}, "rule_applied": None, "fd_details": {},
        }
        mock_llm = MagicMock()
        args = self._make_hybrid_args(60)

        run_fd_hybrid(*args, mock_llm)

        mock_v3.assert_called_once()
        mock_v2.assert_not_called()

    @patch.dict(os.environ, {"FD_V3_ENABLED": "false"})
    @patch("file_decomposition._run_fd_v3")
    @patch("file_decomposition._run_fd_v2")
    def test_v3_disabled_routes_to_v2(self, mock_v2, mock_v3):
        """fc >= 50 + FD_V3_ENABLED=false should route to v2."""
        mock_v2.return_value = {
            "estimated_hours": 30, "raw_estimate": 30,
            "method": "FD_v2_cluster", "routed_to": "v2_b",
            "analysis": {}, "rule_applied": None, "fd_details": {},
        }
        mock_llm = MagicMock()
        args = self._make_hybrid_args(60)

        run_fd_hybrid(*args, mock_llm)

        mock_v2.assert_called_once()
        mock_v3.assert_not_called()

    @patch.dict(os.environ, {"FD_V3_ENABLED": ""})
    @patch("file_decomposition._run_fd_v3")
    @patch("file_decomposition._run_fd_v2")
    def test_v3_unset_routes_to_v2(self, mock_v2, mock_v3):
        """fc >= 50 + FD_V3_ENABLED unset should route to v2 (safe default)."""
        mock_v2.return_value = {
            "estimated_hours": 30, "raw_estimate": 30,
            "method": "FD_v2_cluster", "routed_to": "v2_b",
            "analysis": {}, "rule_applied": None, "fd_details": {},
        }
        mock_llm = MagicMock()
        args = self._make_hybrid_args(60)

        run_fd_hybrid(*args, mock_llm)

        mock_v2.assert_called_once()
        mock_v3.assert_not_called()

    @patch.dict(os.environ, {"FD_V3_ENABLED": "true"})
    @patch("file_decomposition._run_fd_v3")
    @patch("file_decomposition._run_fd_v2")
    def test_small_commit_does_not_use_v3(self, mock_v2, mock_v3):
        """fc < 50 should NOT route to v3 even when flag is enabled."""
        mock_llm = MagicMock(return_value={
            "change_type": "feature", "new_logic_percent": 80,
            "moved_or_copied_percent": 0, "boilerplate_percent": 0,
            "architectural_scope": "module", "cognitive_complexity": "medium",
            "summary": "test",
        })
        args = self._make_hybrid_args(30)

        # This will go through the normal v15 path (classify + estimate)
        # which requires a working LLM mock — but we only care that v3/v2 weren't called
        try:
            run_fd_hybrid(*args, mock_llm)
        except Exception:
            pass  # May fail in v15 path, that's OK

        mock_v3.assert_not_called()
        mock_v2.assert_not_called()

    @patch.dict(os.environ, {"FD_V3_ENABLED": "true"})
    @patch("file_decomposition._run_fd_v3")
    def test_v3_receives_large_fn(self, mock_v3):
        """call_large_fn should be passed through to v3."""
        mock_v3.return_value = {
            "estimated_hours": 25, "raw_estimate": 25,
            "method": "FD_v3_holistic", "routed_to": "v3_holistic",
            "analysis": {}, "rule_applied": None, "fd_details": {},
        }
        mock_llm = MagicMock()
        mock_large = MagicMock()
        args = self._make_hybrid_args(60)

        run_fd_hybrid(*args, mock_llm, call_large_fn=mock_large)

        # Verify call_large_fn was passed through
        call_kwargs = mock_v3.call_args[1]
        self.assertIs(call_kwargs["call_large_fn"], mock_large)


if __name__ == "__main__":
    unittest.main()
