#!/usr/bin/env python3
"""Unit tests for FD v2 functions. No git repo or API needed."""
import os
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from file_decomposition import classify_file_tier, adaptive_filter, build_clusters, combine_estimates, estimate_branch_b, estimate_holistic


class TestClassifyFileTier(unittest.TestCase):
    """Test adaptive filter tier classification."""

    def test_generated_file_is_skip(self):
        tier, est = classify_file_tier("package-lock.json", ["generated"], 5000, 0, "")
        self.assertEqual(tier, "SKIP")
        self.assertEqual(est, 0.0)

    def test_snap_file_is_skip(self):
        tier, est = classify_file_tier("Button.test.tsx.snap", ["generated"], 200, 0, "")
        self.assertEqual(tier, "SKIP")
        self.assertEqual(est, 0.0)

    def test_svg_is_skip(self):
        tier, est = classify_file_tier("icon.svg", [], 100, 0, "")
        self.assertEqual(tier, "SKIP")
        self.assertEqual(est, 0.0)

    def test_binary_is_skip(self):
        tier, est = classify_file_tier("logo.png", [], 0, 0, "")
        self.assertEqual(tier, "SKIP")
        self.assertEqual(est, 0.0)

    def test_locale_json_is_skip(self):
        # Note: classify_file_regex() does not tag messages/ as locale.
        # Task 1 also adds r'messages/' to LOCALE_PATTERNS in file_decomposition.py
        tier, est = classify_file_tier("messages/en.json", ["locale"], 300, 0, "")
        self.assertEqual(tier, "SKIP")
        self.assertEqual(est, 0.0)

    def test_docs_is_heuristic(self):
        tier, est = classify_file_tier("README.md", ["docs"], 200, 0, "")
        self.assertEqual(tier, "HEURISTIC")
        self.assertAlmostEqual(est, min(0.5, 200 * 0.003))

    def test_config_is_heuristic(self):
        tier, est = classify_file_tier("tsconfig.json", ["config"], 50, 0, "")
        self.assertEqual(tier, "HEURISTIC")
        self.assertAlmostEqual(est, 50 * 0.01)

    def test_test_file_is_heuristic(self):
        tier, est = classify_file_tier("auth.test.ts", ["test"], 400, 0, "")
        self.assertEqual(tier, "HEURISTIC")
        self.assertAlmostEqual(est, 400 * 0.002)

    def test_ddl_migration_is_heuristic(self):
        diff = "+CREATE TABLE users (\n+  id SERIAL PRIMARY KEY\n+);\n+ALTER TABLE orders ADD COLUMN status TEXT;"
        # Detected by path pattern (migrations/) not by tag
        tier, est = classify_file_tier("migrations/001_create_users.sql", [], 4, 0, diff)
        self.assertEqual(tier, "HEURISTIC")
        # 2 DDL operations (CREATE + ALTER) * 0.1h = 0.2h
        self.assertAlmostEqual(est, 0.2)

    def test_data_migration_is_llm(self):
        diff = "+INSERT INTO users SELECT * FROM old_users;\n+UPDATE orders SET status = 'active';"
        tier, est = classify_file_tier("migrations/002_migrate_data.sql", [], 2, 0, diff)
        self.assertEqual(tier, "LLM_REQUIRED")
        self.assertEqual(est, 0.0)

    def test_code_file_is_llm(self):
        tier, est = classify_file_tier("auth.service.ts", [], 500, 10, "")
        self.assertEqual(tier, "LLM_REQUIRED")
        self.assertEqual(est, 0.0)

    def test_untagged_code_is_llm(self):
        tier, est = classify_file_tier("utils.py", [], 100, 50, "")
        self.assertEqual(tier, "LLM_REQUIRED")
        self.assertEqual(est, 0.0)


class TestAdaptiveFilter(unittest.TestCase):
    """Test full adaptive filter pipeline."""

    def _make_file(self, name, tags, added=100, deleted=0, diff=""):
        return {"filename": name, "tags": tags, "added": added, "deleted": deleted, "diff": diff}

    def test_all_generated_returns_only_heuristic_total(self):
        files = [
            self._make_file("package-lock.json", ["generated"], added=5000),
            self._make_file("yarn.lock", ["generated"], added=3000),
        ]
        result = adaptive_filter(files)
        self.assertEqual(len(result["skip_files"]), 2)
        self.assertEqual(len(result["llm_files"]), 0)
        self.assertAlmostEqual(result["heuristic_total"], 0.0)

    def test_mixed_files_split_correctly(self):
        files = [
            self._make_file("bun.lock", ["generated"], added=10000),
            self._make_file("auth.test.ts", ["test"], added=400),
            self._make_file("README.md", ["docs"], added=200),
            self._make_file("auth.service.ts", [], added=500),
            self._make_file("db.service.ts", [], added=300),
        ]
        result = adaptive_filter(files)
        self.assertEqual(len(result["skip_files"]), 1)        # generated
        self.assertEqual(len(result["heuristic_files"]), 2)    # test + docs
        self.assertEqual(len(result["llm_files"]), 2)          # 2 code files
        # heuristic_total = test(400*0.002) + docs(min(0.5, 200*0.003))
        expected = 400 * 0.002 + min(0.5, 200 * 0.003)
        self.assertAlmostEqual(result["heuristic_total"], expected)

    def test_llm_diff_assembled(self):
        files = [
            self._make_file("a.ts", [], added=10, diff="diff --git a/a.ts\n+code"),
            self._make_file("b.ts", [], added=20, diff="diff --git a/b.ts\n+more code"),
        ]
        result = adaptive_filter(files)
        self.assertIn("a.ts", result["llm_diff"])
        self.assertIn("b.ts", result["llm_diff"])

    def test_token_estimate_uses_chars_per_token_2(self):
        diff_text = "x" * 10000
        files = [self._make_file("big.ts", [], added=500, diff=diff_text)]
        result = adaptive_filter(files)
        self.assertEqual(result["llm_token_estimate"], 10000 / 2.0)

    def test_filter_stats(self):
        files = [
            self._make_file("lock.json", ["generated"]),
            self._make_file("a.test.ts", ["test"]),
            self._make_file("code.ts", []),
        ]
        result = adaptive_filter(files)
        self.assertEqual(result["filter_stats"]["skip"], 1)
        self.assertEqual(result["filter_stats"]["heuristic"], 1)
        self.assertEqual(result["filter_stats"]["llm"], 1)


class TestBuildClusters(unittest.TestCase):
    """Test directory+suffix clustering."""

    def _make_file(self, name, added=100):
        return {"filename": name, "added": added, "deleted": 0, "diff": f"diff {name}", "tags": []}

    def test_single_directory_one_cluster(self):
        files = [
            self._make_file("src/components/Button.tsx"),
            self._make_file("src/components/Input.tsx"),
            self._make_file("src/components/Modal.tsx"),
        ]
        clusters = build_clusters(files)
        self.assertEqual(len(clusters), 1)
        self.assertEqual(len(clusters[0]["files"]), 3)

    def test_different_directories_separate_clusters(self):
        files = [
            self._make_file("src/components/Button.tsx"),
            self._make_file("src/lib/services/auth.ts"),
            self._make_file("src/lib/services/credit.ts"),
        ]
        clusters = build_clusters(files)
        self.assertEqual(len(clusters), 2)

    def test_suffix_split_within_directory(self):
        files = [
            self._make_file("src/dialer/call-task.service.ts"),
            self._make_file("src/dialer/compliance.service.ts"),
            self._make_file("src/dialer/call-task.repository.ts"),
            self._make_file("src/dialer/compliance.repository.ts"),
            self._make_file("src/dialer/DialerModal.tsx"),
            self._make_file("src/dialer/DialerSettings.tsx"),
        ]
        clusters = build_clusters(files)
        # Should produce subclusters: services, repositories, general
        self.assertGreaterEqual(len(clusters), 2)
        self.assertLessEqual(len(clusters), 4)

    def test_small_clusters_merged(self):
        files = [
            self._make_file("src/a/file1.ts"),
            self._make_file("src/a/file2.ts"),
            self._make_file("src/b/lonely.ts"),  # only 1 file — should merge
        ]
        clusters = build_clusters(files)
        # src/b has <3 files, should merge with nearest (src/a)
        total_files = sum(len(c["files"]) for c in clusters)
        self.assertEqual(total_files, 3)

    def test_max_15_clusters(self):
        # 20 different directories with 3 files each = 20 initial clusters
        files = []
        for i in range(20):
            for j in range(3):
                files.append(self._make_file(f"src/mod{i}/file{j}.ts"))
        clusters = build_clusters(files)
        self.assertLessEqual(len(clusters), 15)
        # All files preserved
        total_files = sum(len(c["files"]) for c in clusters)
        self.assertEqual(total_files, 60)

    def test_cluster_has_name_and_stats(self):
        files = [
            self._make_file("src/auth/login.ts", added=200),
            self._make_file("src/auth/register.ts", added=150),
        ]
        clusters = build_clusters(files)
        c = clusters[0]
        self.assertIn("name", c)
        self.assertIn("files", c)
        self.assertIn("total_added", c)
        self.assertEqual(c["total_added"], 350)

    def test_empty_input(self):
        clusters = build_clusters([])
        self.assertEqual(clusters, [])


class TestCombineEstimates(unittest.TestCase):
    """Test branch+holistic combining logic."""

    def test_normal_divergence_averages(self):
        # branch=40, holistic=50, heuristic=5 → (40+50)/2 + 5 = 50
        result = combine_estimates(40.0, 50.0, 5.0)
        self.assertAlmostEqual(result, 50.0)

    def test_strong_divergence_takes_min(self):
        # branch=20, holistic=50, divergence=2.5 → min(20,50) + 5 = 25
        result = combine_estimates(20.0, 50.0, 5.0)
        self.assertAlmostEqual(result, 25.0)

    def test_exactly_2x_divergence_averages(self):
        # branch=20, holistic=40, ratio=2.0 → average: (20+40)/2 + 3 = 33
        result = combine_estimates(20.0, 40.0, 3.0)
        self.assertAlmostEqual(result, 33.0)

    def test_zero_holistic_extreme_divergence(self):
        # holistic=0 → divergence extreme → min(30, 0) + 2 = 2
        result = combine_estimates(30.0, 0.0, 2.0)
        self.assertAlmostEqual(result, 2.0)

    def test_zero_branch_extreme_divergence(self):
        # branch=0 → divergence extreme → min(0, 40) + 5 = 5
        result = combine_estimates(0.0, 40.0, 5.0)
        self.assertAlmostEqual(result, 5.0)

    def test_heuristic_only(self):
        # Both zero → just heuristic
        result = combine_estimates(0.0, 0.0, 10.0)
        self.assertAlmostEqual(result, 10.0)

    def test_symmetric(self):
        # Same estimate from both → average = same
        result = combine_estimates(30.0, 30.0, 0.0)
        self.assertAlmostEqual(result, 30.0)


class TestBranchB(unittest.TestCase):
    """Test cluster-based estimation (Branch B)."""

    def _make_cluster(self, name, files, total_added=500):
        return {"name": name, "files": files, "total_added": total_added, "total_deleted": 0}

    def _make_file(self, name, added=100, diff="diff content"):
        return {"filename": name, "added": added, "deleted": 0, "diff": diff, "tags": []}

    def test_sums_cluster_estimates(self):
        """Mock LLM returns 10h per cluster -> 2 clusters = 20h."""
        clusters = [
            self._make_cluster("auth", [self._make_file("auth.ts")]),
            self._make_cluster("billing", [self._make_file("billing.ts")]),
        ]
        call_count = [0]
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            call_count[0] += 1
            return {"estimated_hours": 10.0, "reasoning": "mock"}
        result = estimate_branch_b(clusters, "feat: add auth+billing", "typescript", 100, mock_llm)
        self.assertAlmostEqual(result, 20.0)
        self.assertEqual(call_count[0], 2)

    def test_llm_failure_uses_fallback(self):
        """If LLM returns None for a cluster, use heuristic fallback."""
        clusters = [
            self._make_cluster("auth", [self._make_file("auth.ts", added=300)], total_added=300),
        ]
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            return None  # LLM failed
        result = estimate_branch_b(clusters, "feat: auth", "typescript", 100, mock_llm)
        self.assertGreater(result, 0)  # should use heuristic fallback

    def test_prompt_includes_commit_message(self):
        """Verify prompt contains commit context."""
        captured = []
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            captured.append(prompt)
            return {"estimated_hours": 5.0, "reasoning": "mock"}
        clusters = [self._make_cluster("auth", [self._make_file("auth.ts")])]
        estimate_branch_b(clusters, "feat: add OAuth flow", "typescript", 100, mock_llm)
        self.assertIn("OAuth flow", captured[0])


class TestHolistic(unittest.TestCase):
    """Test independent holistic estimation."""

    def test_returns_estimate(self):
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            return {"estimated_hours": 35.0, "reasoning": "mock holistic"}
        clusters = [{"name": "auth", "files": [{"filename": "auth.ts", "added": 500}], "total_added": 500}]
        result = estimate_holistic("feat: auth", "typescript", clusters,
                                   {"skip": 5, "heuristic": 3, "llm": 10},
                                   100, 5000, 200, 0.6, mock_llm)
        self.assertAlmostEqual(result, 35.0)

    def test_prompt_has_no_estimate_anchor(self):
        captured = []
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            captured.append({"system": system, "prompt": prompt})
            return {"estimated_hours": 25.0, "reasoning": "mock"}
        clusters = [{"name": "auth", "files": [{"filename": "auth.ts", "added": 500}], "total_added": 500}]
        estimate_holistic("feat: auth", "typescript", clusters,
                          {"skip": 0, "heuristic": 0, "llm": 5},
                          5, 1000, 0, 0.8, mock_llm)
        full_text = captured[0]["system"] + captured[0]["prompt"]
        # Must NOT contain any numeric hour estimate
        self.assertNotIn("branch", full_text.lower())
        self.assertNotIn("cluster estimate", full_text.lower())

    def test_prompt_includes_cluster_structure(self):
        captured = []
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            captured.append(prompt)
            return {"estimated_hours": 10.0, "reasoning": "mock"}
        clusters = [
            {"name": "auth", "files": [{"filename": "auth.ts", "added": 500}], "total_added": 500},
            {"name": "billing", "files": [{"filename": "billing.ts", "added": 300}], "total_added": 300},
        ]
        estimate_holistic("feat: add auth", "typescript", clusters,
                          {"skip": 0, "heuristic": 0, "llm": 2}, 2, 800, 0, 0.5, mock_llm)
        self.assertIn("auth", captured[0])
        self.assertIn("billing", captured[0])

    def test_llm_failure_returns_zero(self):
        def mock_llm(system, prompt, schema=None, max_tokens=1024):
            return None
        result = estimate_holistic("feat: x", "ts", [], {"skip": 0, "heuristic": 0, "llm": 0},
                                   0, 0, 0, 0, mock_llm)
        self.assertEqual(result, 0.0)


if __name__ == "__main__":
    unittest.main()
