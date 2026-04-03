"""Tests for PR 2B1: heartbeat contract, runtime state builders, HeartbeatThread evidence."""
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch, call

sys.path.insert(0, str(Path(__file__).resolve().parent))

from worker import (
    HEARTBEAT_INTERVAL_S,
    HEARTBEAT_WARN_AFTER_S,
    HEARTBEAT_STALE_AFTER_S,
    validate_heartbeat_contract,
    heartbeat_contract_dict,
    build_stage_patch,
    build_heartbeat_tick_patch,
    build_heartbeat_fail_patch,
)


# ---------------------------------------------------------------------------
# A. Heartbeat contract tests
# ---------------------------------------------------------------------------

class HeartbeatContractTests(unittest.TestCase):
    def test_interval_is_explicit_and_positive(self):
        self.assertIsInstance(HEARTBEAT_INTERVAL_S, int)
        self.assertGreater(HEARTBEAT_INTERVAL_S, 0)

    def test_warn_threshold_is_explicit(self):
        self.assertIsInstance(HEARTBEAT_WARN_AFTER_S, int)
        self.assertGreater(HEARTBEAT_WARN_AFTER_S, HEARTBEAT_INTERVAL_S)

    def test_stale_threshold_is_explicit(self):
        self.assertIsInstance(HEARTBEAT_STALE_AFTER_S, int)
        self.assertGreater(HEARTBEAT_STALE_AFTER_S, HEARTBEAT_WARN_AFTER_S)

    def test_threshold_ordering_is_validated(self):
        # Valid: should not raise
        validate_heartbeat_contract(10, 20, 60)

    def test_zero_interval_fails_fast(self):
        with self.assertRaises(ValueError) as ctx:
            validate_heartbeat_contract(0, 20, 60)
        self.assertIn("must be > 0", str(ctx.exception))

    def test_negative_interval_fails_fast(self):
        with self.assertRaises(ValueError):
            validate_heartbeat_contract(-5, 20, 60)

    def test_warn_not_greater_than_interval_fails(self):
        with self.assertRaises(ValueError) as ctx:
            validate_heartbeat_contract(60, 60, 120)
        self.assertIn("must be > HEARTBEAT_INTERVAL_S", str(ctx.exception))

    def test_stale_not_greater_than_warn_fails(self):
        with self.assertRaises(ValueError) as ctx:
            validate_heartbeat_contract(10, 30, 30)
        self.assertIn("must be > HEARTBEAT_WARN_AFTER_S", str(ctx.exception))

    def test_contract_dict_returns_current_values(self):
        d = heartbeat_contract_dict()
        self.assertEqual(d["intervalSec"], HEARTBEAT_INTERVAL_S)
        self.assertEqual(d["warnAfterSec"], HEARTBEAT_WARN_AFTER_S)
        self.assertEqual(d["staleAfterSec"], HEARTBEAT_STALE_AFTER_S)


# ---------------------------------------------------------------------------
# C. Worker runtime state builder tests
# ---------------------------------------------------------------------------

class BuildStagePatchTests(unittest.TestCase):
    def test_produces_expected_minimal_shape(self):
        patch = build_stage_patch("cloning")
        self.assertEqual(patch["stage"], "cloning")
        self.assertIn("stageStartedAt", patch)
        self.assertIsNone(patch["activeCommand"])
        # Should not contain optional keys when not provided
        self.assertNotIn("repo", patch)
        self.assertNotIn("attempt", patch)

    def test_includes_repo_when_provided(self):
        patch = build_stage_patch("cloning", repo="owner/repo")
        self.assertEqual(patch["repo"], "owner/repo")

    def test_includes_attempt_when_provided(self):
        patch = build_stage_patch("worker_acquired", attempt=2)
        self.assertEqual(patch["attempt"], 2)

    def test_stage_started_at_is_iso_format(self):
        patch = build_stage_patch("extracting")
        ts = patch["stageStartedAt"]
        self.assertTrue(ts.endswith("Z"))
        # Should be parseable
        datetime.fromisoformat(ts.replace("Z", "+00:00"))

    def test_all_required_stages_produce_valid_patches(self):
        for stage in ["worker_acquired", "cloning", "extracting", "analyzing",
                      "llm_complete", "completed", "cancelled", "failed"]:
            patch = build_stage_patch(stage)
            self.assertEqual(patch["stage"], stage)
            self.assertIn("stageStartedAt", patch)
            self.assertIsNone(patch["activeCommand"])


class BuildHeartbeatTickPatchTests(unittest.TestCase):
    def test_success_tick_shape(self):
        patch = build_heartbeat_tick_patch(loop_lag_ms=12.345)
        self.assertIn("lastTickAt", patch)
        self.assertTrue(patch["lastWriteOk"])
        self.assertEqual(patch["consecutiveFailures"], 0)
        self.assertIsNone(patch["lastError"])
        self.assertEqual(patch["lastLoopLagMs"], 12.3)

    def test_zero_lag_default(self):
        patch = build_heartbeat_tick_patch()
        self.assertEqual(patch["lastLoopLagMs"], 0)

    def test_clears_last_error_on_success(self):
        patch = build_heartbeat_tick_patch()
        self.assertIn("lastError", patch)
        self.assertIsNone(patch["lastError"])


class BuildHeartbeatFailPatchTests(unittest.TestCase):
    def test_failure_patch_shape(self):
        patch = build_heartbeat_fail_patch("connection reset", consecutive_failures=3)
        self.assertFalse(patch["lastWriteOk"])
        self.assertEqual(patch["consecutiveFailures"], 3)
        self.assertEqual(patch["lastError"], "connection reset")

    def test_first_failure_default(self):
        patch = build_heartbeat_fail_patch("timeout")
        self.assertEqual(patch["consecutiveFailures"], 1)

    def test_zero_consecutive_clamped_to_one(self):
        patch = build_heartbeat_fail_patch("err", consecutive_failures=0)
        self.assertEqual(patch["consecutiveFailures"], 1)

    def test_error_truncation(self):
        long_error = "x" * 500
        patch = build_heartbeat_fail_patch(long_error)
        self.assertEqual(len(patch["lastError"]), 300)


# ---------------------------------------------------------------------------
# C. HeartbeatThread evidence tests (mocked DB)
# ---------------------------------------------------------------------------

class HeartbeatThreadTests(unittest.TestCase):
    """Test that HeartbeatThread calls the right DB functions on success/failure."""

    @patch("worker.connect_db")
    @patch("worker.update_heartbeat")
    @patch("worker.patch_heartbeat_state")
    @patch("worker.append_job_event")
    def test_successful_tick_updates_heartbeat_state(
        self, mock_event, mock_patch_hb, mock_update_hb, mock_connect
    ):
        from worker import HeartbeatThread
        mock_conn = MagicMock()
        mock_connect.return_value = mock_conn

        ht = HeartbeatThread("job-1", interval=0)
        ht._stop_event.wait = MagicMock(side_effect=[None, None])
        # After two ticks, stop
        call_count = [0]
        original_is_set = ht._stop_event.is_set

        def stop_after_one(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] >= 3:
                ht._stop_event.set()
            return original_is_set()

        ht._stop_event.is_set = stop_after_one
        ht.run()

        # update_heartbeat should have been called
        mock_update_hb.assert_called()
        # patch_heartbeat_state should have been called with a success patch
        mock_patch_hb.assert_called()
        args = mock_patch_hb.call_args
        hb_patch = args[0][2]  # (conn, job_id, patch)
        self.assertTrue(hb_patch["lastWriteOk"])
        self.assertEqual(hb_patch["consecutiveFailures"], 0)

    @patch("worker.connect_db")
    @patch("worker.update_heartbeat", side_effect=Exception("DB gone"))
    @patch("worker.patch_heartbeat_state")
    @patch("worker.append_job_event")
    def test_failed_tick_emits_write_fail_event(
        self, mock_event, mock_patch_hb, mock_update_hb, mock_connect
    ):
        from worker import HeartbeatThread
        mock_conn = MagicMock()
        mock_connect.return_value = mock_conn

        ht = HeartbeatThread("job-2", interval=0)
        ht._stop_event.wait = MagicMock(return_value=None)
        call_count = [0]
        original_is_set = ht._stop_event.is_set

        def stop_after_one(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] >= 3:
                ht._stop_event.set()
            return original_is_set()

        ht._stop_event.is_set = stop_after_one
        ht.run()

        # Should have tried to emit HEARTBEAT_DB_WRITE_FAIL event
        event_calls = [c for c in mock_event.call_args_list
                       if c[1].get("code") == "HEARTBEAT_DB_WRITE_FAIL"]
        # At least one failure event
        self.assertGreater(len(event_calls), 0)

    @patch("worker.connect_db")
    @patch("worker.update_heartbeat")
    @patch("worker.patch_heartbeat_state")
    @patch("worker.append_job_event")
    def test_reconnect_event_after_recovery(
        self, mock_event, mock_patch_hb, mock_update_hb, mock_connect
    ):
        from worker import HeartbeatThread
        mock_conn = MagicMock()
        mock_connect.return_value = mock_conn

        # First call fails, second succeeds
        mock_update_hb.side_effect = [Exception("DB gone"), None]

        ht = HeartbeatThread("job-3", interval=0)
        ht._stop_event.wait = MagicMock(return_value=None)
        call_count = [0]
        original_is_set = ht._stop_event.is_set

        def stop_after_two(*args, **kwargs):
            call_count[0] += 1
            if call_count[0] >= 5:
                ht._stop_event.set()
            return original_is_set()

        ht._stop_event.is_set = stop_after_two
        ht.run()

        # Should have emitted HEARTBEAT_RECONNECTED event
        reconnect_calls = [c for c in mock_event.call_args_list
                           if len(c) >= 2 and c[1].get("code") == "HEARTBEAT_RECONNECTED"]
        self.assertGreater(len(reconnect_calls), 0)


if __name__ == "__main__":
    unittest.main()
