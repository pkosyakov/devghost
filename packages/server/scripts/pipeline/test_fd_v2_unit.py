#!/usr/bin/env python3
"""Unit tests for FD v2 functions. No git repo or API needed."""
import os
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from file_decomposition import classify_file_tier


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


if __name__ == "__main__":
    unittest.main()
