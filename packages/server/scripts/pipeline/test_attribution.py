#!/usr/bin/env python3
"""Unit tests for per-commit model attribution in _resolve_commit_model."""
import os
import sys
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

# Set env vars before importing the module (module reads them at import time).
os.environ.setdefault('OPENROUTER_MODEL', 'qwen/qwen3-coder-next')
os.environ.setdefault('FD_LARGE_LLM_MODEL', 'qwen/qwen3-coder-plus')

from run_v16_pipeline import _resolve_commit_model, _FD_LARGE_MODEL_METHODS


class TestResolveCommitModel(unittest.TestCase):
    """Verify _resolve_commit_model returns correct model for every FD route."""

    # --- FD routes that call the large model ---

    def test_fd_v3_holistic_returns_large_model(self):
        result = _resolve_commit_model('FD_v3_holistic')
        self.assertEqual(result, os.environ['FD_LARGE_LLM_MODEL'])

    def test_fd_v2_single_holistic_returns_large_model(self):
        result = _resolve_commit_model('FD_v2_single_holistic')
        self.assertEqual(result, os.environ['FD_LARGE_LLM_MODEL'])

    def test_fd_v2_single_call_returns_large_model(self):
        result = _resolve_commit_model('FD_v2_single_call')
        self.assertEqual(result, os.environ['FD_LARGE_LLM_MODEL'])

    def test_fd_v2_cluster_holistic_returns_large_model(self):
        result = _resolve_commit_model('FD_v2_cluster_holistic')
        self.assertEqual(result, os.environ['FD_LARGE_LLM_MODEL'])

    def test_fd_v2_cluster_returns_large_model(self):
        result = _resolve_commit_model('FD_v2_cluster')
        self.assertEqual(result, os.environ['FD_LARGE_LLM_MODEL'])

    def test_large_model_methods_set_is_exhaustive(self):
        expected = {'FD_v3_holistic', 'FD_v2_single_holistic', 'FD_v2_single_call',
                    'FD_v2_cluster_holistic', 'FD_v2_cluster'}
        self.assertEqual(_FD_LARGE_MODEL_METHODS, expected)

    # --- FD routes that use the default model (not heuristic-only) ---

    def test_fd_hybrid_mechanical_none_returns_default_model(self):
        result = _resolve_commit_model('FD_hybrid_mechanical_none')
        self.assertEqual(result, os.environ['OPENROUTER_MODEL'])

    def test_fd_hybrid_mechanical_module_returns_default_model(self):
        result = _resolve_commit_model('FD_hybrid_mechanical_module')
        self.assertEqual(result, os.environ['OPENROUTER_MODEL'])

    def test_fd_hybrid_mechanical_architectural_returns_default_model(self):
        result = _resolve_commit_model('FD_hybrid_mechanical_architectural')
        self.assertEqual(result, os.environ['OPENROUTER_MODEL'])

    # --- FD routes that are heuristic-only (no LLM call) ---

    def test_fd_cheap_returns_none(self):
        result = _resolve_commit_model('FD_cheap')
        self.assertIsNone(result)

    def test_fd_bulk_scaffold_returns_none(self):
        result = _resolve_commit_model('FD_bulk_scaffold')
        self.assertIsNone(result)

    def test_fd_v3_heuristic_only_returns_none(self):
        result = _resolve_commit_model('FD_v3_heuristic_only')
        self.assertIsNone(result)

    def test_fd_v3_fallback_returns_none(self):
        result = _resolve_commit_model('FD_v3_fallback')
        self.assertIsNone(result)

    def test_fd_v2_heuristic_only_returns_none(self):
        result = _resolve_commit_model('FD_v2_heuristic_only')
        self.assertIsNone(result)

    def test_fd_fallback_returns_none(self):
        result = _resolve_commit_model('FD_fallback')
        self.assertIsNone(result)

    # --- Non-FD routes ---

    def test_cascading_none_returns_default_model(self):
        result = _resolve_commit_model('cascading_none')
        self.assertEqual(result, os.environ['OPENROUTER_MODEL'])

    def test_cascading_module_returns_default_model(self):
        result = _resolve_commit_model('cascading_module')
        self.assertEqual(result, os.environ['OPENROUTER_MODEL'])

    def test_cascading_architectural_returns_default_model(self):
        result = _resolve_commit_model('cascading_architectural')
        self.assertEqual(result, os.environ['OPENROUTER_MODEL'])

    def test_error_method_returns_default_model(self):
        """Error is not FD-prefixed, so it falls through to OPENROUTER_MODEL.
        TypeScript handles error→null separately in mapToCommitAnalysis."""
        result = _resolve_commit_model('error')
        self.assertEqual(result, os.environ['OPENROUTER_MODEL'])

    # --- Edge case: FD_LARGE_LLM_MODEL not configured ---

    def test_large_model_returns_none_when_env_empty(self):
        import run_v16_pipeline as mod
        orig = mod.FD_LARGE_LLM_MODEL
        try:
            mod.FD_LARGE_LLM_MODEL = ''
            result = _resolve_commit_model('FD_v3_holistic')
            self.assertIsNone(result)
        finally:
            mod.FD_LARGE_LLM_MODEL = orig


if __name__ == '__main__':
    unittest.main()
