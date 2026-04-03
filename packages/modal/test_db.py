import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from db import (
    MODEL_INDEPENDENT_NULL_METHODS,
    lookup_cached_commits,
    set_job_llm_identity,
    patch_runtime_state,
    patch_heartbeat_state,
)


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
        self.commits = 0

    def cursor(self, *args, **kwargs):
        self.cursor_kwargs = kwargs
        return _CursorContext(self.cursor_instance)

    def commit(self):
        self.commits += 1


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

    def test_set_job_llm_identity_updates_provider_and_model(self):
        conn = _FakeConn([])

        set_job_llm_identity(
            conn,
            "job-123",
            "openrouter",
            "qwen/qwen3-coder-next",
            True,
            "openrouter",
            "qwen/qwen3-coder-plus",
        )

        self.assertIn('"llmProvider" = %s', conn.cursor_instance.executed_query)
        self.assertIn('"llmModel" = %s', conn.cursor_instance.executed_query)
        self.assertIn('"smallLlmProvider" = %s', conn.cursor_instance.executed_query)
        self.assertIn('"largeLlmModel" = %s', conn.cursor_instance.executed_query)
        self.assertIn('"fdV3Enabled" = %s', conn.cursor_instance.executed_query)
        self.assertEqual(
            conn.cursor_instance.executed_params,
            (
                "openrouter",
                "qwen/qwen3-coder-next",
                "openrouter",
                "qwen/qwen3-coder-next",
                "openrouter",
                "qwen/qwen3-coder-plus",
                True,
                "job-123",
            ),
        )
        self.assertEqual(conn.commits, 1)


class PatchRuntimeStateTests(unittest.TestCase):
    """Tests for the patch_runtime_state DB helper."""

    def test_null_runtime_state_can_be_initialized(self):
        conn = _FakeConn([])
        patch_runtime_state(conn, "job-1", {"stage": "cloning", "repo": "o/r"})

        sql = conn.cursor_instance.executed_query
        self.assertIn('COALESCE("runtimeState"', sql)
        self.assertIn("|| %s::jsonb", sql)
        self.assertIn('"updatedAt" = NOW()', sql)

        params = conn.cursor_instance.executed_params
        self.assertEqual(params[1], "job-1")
        # First param is the JSON patch
        import json
        parsed = json.loads(params[0])
        self.assertEqual(parsed["stage"], "cloning")
        self.assertEqual(parsed["repo"], "o/r")
        self.assertEqual(conn.commits, 1)

    def test_unrelated_fields_not_dropped(self):
        """patch_runtime_state uses || merge — SQL preserves other keys by design."""
        conn = _FakeConn([])
        # Write only one key
        patch_runtime_state(conn, "job-2", {"stage": "extracting"})

        import json
        parsed = json.loads(conn.cursor_instance.executed_params[0])
        # Only the patched key is in the payload; the SQL || operator preserves others
        self.assertEqual(parsed, {"stage": "extracting"})


class PatchHeartbeatStateTests(unittest.TestCase):
    """Tests for the patch_heartbeat_state DB helper."""

    def test_null_heartbeat_subkey_can_be_initialized(self):
        conn = _FakeConn([])
        patch_heartbeat_state(conn, "job-3", {"lastTickAt": "2026-04-03T10:00:00Z", "lastWriteOk": True})

        sql = conn.cursor_instance.executed_query
        self.assertIn("jsonb_set", sql)
        self.assertIn("'{heartbeat}'", sql)
        self.assertIn('COALESCE("runtimeState"->\'heartbeat\'', sql)
        self.assertIn('"updatedAt" = NOW()', sql)

        params = conn.cursor_instance.executed_params
        self.assertEqual(params[1], "job-3")

        import json
        parsed = json.loads(params[0])
        self.assertEqual(parsed["lastTickAt"], "2026-04-03T10:00:00Z")
        self.assertTrue(parsed["lastWriteOk"])
        self.assertEqual(conn.commits, 1)

    def test_heartbeat_patch_preserves_sibling_keys(self):
        """Only heartbeat sub-key is touched; top-level runtimeState keys preserved via jsonb_set."""
        conn = _FakeConn([])
        patch_heartbeat_state(conn, "job-4", {"consecutiveFailures": 2})

        sql = conn.cursor_instance.executed_query
        # jsonb_set targets only '{heartbeat}' path, not the whole runtimeState
        self.assertIn("'{heartbeat}'", sql)
        # Does NOT use top-level || which would clobber other keys
        import json
        parsed = json.loads(conn.cursor_instance.executed_params[0])
        self.assertEqual(parsed, {"consecutiveFailures": 2})


if __name__ == "__main__":
    unittest.main()
