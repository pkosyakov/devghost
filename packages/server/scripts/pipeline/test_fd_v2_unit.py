#!/usr/bin/env python3
"""Unit tests for FD v2 functions. No git repo or API needed."""
import os
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from file_decomposition import classify_file_tier, adaptive_filter


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


if __name__ == "__main__":
    unittest.main()
