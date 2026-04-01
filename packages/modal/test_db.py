import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from db import MODEL_INDEPENDENT_NULL_METHODS, lookup_cached_commits


class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows
        self.executed_query = None
        self.executed_params = None

    def execute(self, query, params):
        self.executed_query = query
        self.executed_params = params

    def fetchall(self):
        return self._rows


class _CursorContext:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self._cursor

    def __exit__(self, exc_type, exc, tb):
        return False


class _FakeConn:
    def __init__(self, rows):
        self.cursor_instance = _FakeCursor(rows)
        self.cursor_kwargs = None

    def cursor(self, *args, **kwargs):
        self.cursor_kwargs = kwargs
        return _CursorContext(self.cursor_instance)


class LookupCachedCommitsTests(unittest.TestCase):
    def test_model_cache_requires_exact_llm_model_match(self):
        conn = _FakeConn([
            {"commitHash": "abc123", "effortHours": 5},
            {"commitHash": "abc123", "effortHours": 99},
        ])

        rows, seen = lookup_cached_commits(
            conn,
            ["abc123"],
            "current-order",
            "user-1",
            "Artisan-AI/artisan",
            "model",
            "qwen/qwen3-coder-next",
        )

        self.assertEqual(rows, [{"commitHash": "abc123", "effortHours": 5}])
        self.assertEqual(seen, {"abc123"})
        self.assertIn('ca."llmModel" = %s', conn.cursor_instance.executed_query)
        self.assertIn('ca.method = ANY(%s)', conn.cursor_instance.executed_query)
        self.assertEqual(
            conn.cursor_instance.executed_params,
            [
                ["abc123"],
                "Artisan-AI/artisan",
                "current-order",
                "user-1",
                "qwen/qwen3-coder-next",
                list(MODEL_INDEPENDENT_NULL_METHODS),
            ],
        )

    def test_model_cache_keeps_explicit_model_independent_null_allowlist(self):
        conn = _FakeConn([])

        lookup_cached_commits(
            conn,
            ["abc123"],
            "current-order",
            "user-1",
            "Artisan-AI/artisan",
            "model",
            "qwen/qwen3-coder-next",
        )

        self.assertIn('ca."llmModel" IS NULL AND ca.method = ANY(%s)', conn.cursor_instance.executed_query)
        self.assertEqual(
            conn.cursor_instance.executed_params[-1],
            list(MODEL_INDEPENDENT_NULL_METHODS),
        )

    def test_any_cache_mode_does_not_add_model_filter(self):
        conn = _FakeConn([])

        rows, seen = lookup_cached_commits(
            conn,
            ["abc123"],
            "current-order",
            "user-1",
            "Artisan-AI/artisan",
            "any",
            "qwen/qwen3-coder-next",
        )

        self.assertEqual(rows, [])
        self.assertEqual(seen, set())
        self.assertNotIn('AND ca."llmModel" = %s', conn.cursor_instance.executed_query)
        self.assertEqual(
            conn.cursor_instance.executed_params,
            [["abc123"], "Artisan-AI/artisan", "current-order", "user-1"],
        )

    def test_off_cache_mode_short_circuits_without_db_call(self):
        conn = _FakeConn([])

        rows, seen = lookup_cached_commits(
            conn,
            ["abc123"],
            "current-order",
            "user-1",
            "Artisan-AI/artisan",
            "off",
            "qwen/qwen3-coder-next",
        )

        self.assertEqual(rows, [])
        self.assertEqual(seen, set())
        self.assertIsNone(conn.cursor_instance.executed_query)


if __name__ == "__main__":
    unittest.main()
