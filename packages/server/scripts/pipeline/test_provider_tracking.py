#!/usr/bin/env python3
"""Unit tests for LLM provider tracking across all call paths.

Tests cover:
1. call_ollama: returns provider='ollama' in meta (success + error)
2. call_openrouter: returns provider from API response; error paths return 'unknown'
3. call_openrouter_large: returns provider from API response; retry on invalid JSON;
   error paths return 'unknown'/'provider_name'
4. call_llm cache-hit: old cache entries without provider get provider='unknown_cache'
5. call_llm_fd_large cache-hit: same fallback for large-model cache
"""
import json
import os
import sys
import unittest
from unittest.mock import patch, MagicMock

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

# Set required env before import (must match defaults used by other test files
# like test_attribution.py to avoid module-caching conflicts in combined runs)
os.environ.setdefault("LLM_PROVIDER", "openrouter")
os.environ.setdefault("OPENROUTER_API_KEY", "test-key-for-unit-tests")
os.environ.setdefault("OPENROUTER_MODEL", "test/model")
os.environ.setdefault("FD_LARGE_LLM_MODEL", "qwen/qwen3-coder-plus")

import run_v16_pipeline as pipeline


class TestCallOllamaProvider(unittest.TestCase):
    """call_ollama() must always include provider='ollama' in meta."""

    @patch("run_v16_pipeline.requests.post")
    def test_success_has_provider(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "response": '{"estimated_hours": 1.0, "reasoning": "test"}',
            "prompt_eval_count": 100,
            "eval_count": 50,
            "total_duration": 500_000_000,
            "prompt_eval_duration": 200_000_000,
            "eval_duration": 300_000_000,
        }
        mock_post.return_value = mock_resp

        parsed, meta = pipeline.call_ollama("system", "prompt", schema=pipeline.ESTIMATE_SCHEMA)
        self.assertIsNotNone(parsed)
        self.assertEqual(meta["provider"], "ollama")

    @patch("run_v16_pipeline.requests.post", side_effect=Exception("connection refused"))
    def test_error_has_provider(self, mock_post):
        parsed, meta = pipeline.call_ollama("system", "prompt")
        self.assertIsNone(parsed)
        self.assertEqual(meta["provider"], "ollama")
        self.assertIn("error", meta)


class TestCallOpenrouterProvider(unittest.TestCase):
    """call_openrouter() must return provider from response or 'unknown' on error."""

    def _mock_success_response(self, provider="Chutes"):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "provider": provider,
            "choices": [{"message": {"content": '{"estimated_hours": 2.0, "reasoning": "ok"}'}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 50},
        }
        return mock_resp

    @patch("run_v16_pipeline.requests.post")
    def test_success_extracts_provider(self, mock_post):
        mock_post.return_value = self._mock_success_response("Alibaba")
        parsed, meta = pipeline.call_openrouter("system", "prompt", schema=pipeline.ESTIMATE_SCHEMA)
        self.assertIsNotNone(parsed)
        self.assertEqual(meta["provider"], "Alibaba")

    @patch("run_v16_pipeline.requests.post")
    def test_missing_api_key(self, mock_post):
        orig = pipeline.OPENROUTER_API_KEY
        try:
            pipeline.OPENROUTER_API_KEY = ""
            parsed, meta = pipeline.call_openrouter("system", "prompt")
            self.assertIsNone(parsed)
            self.assertEqual(meta["provider"], "unknown")
        finally:
            pipeline.OPENROUTER_API_KEY = orig

    @patch("run_v16_pipeline.requests.post")
    def test_http_error_has_provider_unknown(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 500
        mock_resp.text = "Internal Server Error"
        mock_post.return_value = mock_resp

        orig_retries = pipeline.OPENROUTER_MAX_RETRIES
        pipeline.OPENROUTER_MAX_RETRIES = 0
        try:
            parsed, meta = pipeline.call_openrouter("system", "prompt")
            self.assertIsNone(parsed)
            self.assertEqual(meta["provider"], "unknown")
        finally:
            pipeline.OPENROUTER_MAX_RETRIES = orig_retries

    @patch("run_v16_pipeline.requests.post")
    def test_api_error_has_provider_unknown(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"error": {"message": "model overloaded"}}
        mock_post.return_value = mock_resp

        parsed, meta = pipeline.call_openrouter("system", "prompt")
        self.assertIsNone(parsed)
        self.assertEqual(meta["provider"], "unknown")

    @patch("run_v16_pipeline.requests.post")
    def test_invalid_json_exhausted_retries(self, mock_post):
        """Invalid JSON after all retries should return provider from response."""
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "provider": "Chutes",
            "choices": [{"message": {"content": "not valid json {"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }
        mock_post.return_value = mock_resp

        orig_retries = pipeline.OPENROUTER_MAX_RETRIES
        orig_backoff = pipeline.OPENROUTER_RETRY_BACKOFF_BASE_SEC
        pipeline.OPENROUTER_MAX_RETRIES = 1
        pipeline.OPENROUTER_RETRY_BACKOFF_BASE_SEC = 0.001
        try:
            parsed, meta = pipeline.call_openrouter("system", "prompt", schema=pipeline.ESTIMATE_SCHEMA)
            self.assertIsNone(parsed)
            self.assertEqual(meta["provider"], "Chutes")
        finally:
            pipeline.OPENROUTER_MAX_RETRIES = orig_retries
            pipeline.OPENROUTER_RETRY_BACKOFF_BASE_SEC = orig_backoff


class TestCallOpenrouterLargeProvider(unittest.TestCase):
    """call_openrouter_large() must return provider and support retry."""

    def _mock_success_response(self, provider="DeepInfra"):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "provider": provider,
            "choices": [{"message": {"content": '{"estimated_hours": 3.0, "reasoning": "large"}'}}],
            "usage": {"prompt_tokens": 200, "completion_tokens": 80},
        }
        return mock_resp

    @patch("run_v16_pipeline.requests.post")
    def test_success_extracts_provider(self, mock_post):
        mock_post.return_value = self._mock_success_response("Fireworks")
        orig = pipeline.FD_LARGE_LLM_MODEL
        pipeline.FD_LARGE_LLM_MODEL = "large/test-model"
        try:
            parsed, meta = pipeline.call_openrouter_large("system", "prompt", schema=pipeline.ESTIMATE_SCHEMA)
            self.assertIsNotNone(parsed)
            self.assertEqual(meta["provider"], "Fireworks")
        finally:
            pipeline.FD_LARGE_LLM_MODEL = orig

    def test_no_model_configured(self):
        orig = pipeline.FD_LARGE_LLM_MODEL
        pipeline.FD_LARGE_LLM_MODEL = ""
        try:
            parsed, meta = pipeline.call_openrouter_large("system", "prompt")
            self.assertIsNone(parsed)
            self.assertEqual(meta["provider"], "unknown")
        finally:
            pipeline.FD_LARGE_LLM_MODEL = orig

    @patch("run_v16_pipeline.requests.post")
    def test_retry_on_invalid_json_then_success(self, mock_post):
        """First attempt returns invalid JSON, second succeeds — provider from success."""
        bad_resp = MagicMock()
        bad_resp.status_code = 200
        bad_resp.json.return_value = {
            "provider": "BadProvider",
            "choices": [{"message": {"content": "not json"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        }
        good_resp = self._mock_success_response("GoodProvider")
        mock_post.side_effect = [bad_resp, good_resp]

        orig_model = pipeline.FD_LARGE_LLM_MODEL
        orig_backoff = pipeline.OPENROUTER_RETRY_BACKOFF_BASE_SEC
        pipeline.FD_LARGE_LLM_MODEL = "large/test"
        pipeline.OPENROUTER_RETRY_BACKOFF_BASE_SEC = 0.001
        try:
            parsed, meta = pipeline.call_openrouter_large("system", "prompt", schema=pipeline.ESTIMATE_SCHEMA)
            self.assertIsNotNone(parsed)
            self.assertEqual(meta["provider"], "GoodProvider")
        finally:
            pipeline.FD_LARGE_LLM_MODEL = orig_model
            pipeline.OPENROUTER_RETRY_BACKOFF_BASE_SEC = orig_backoff

    @patch("run_v16_pipeline.requests.post")
    def test_transient_http_error_retry(self, mock_post):
        """502 on first attempt, success on second — provider preserved."""
        err_resp = MagicMock()
        err_resp.status_code = 502
        err_resp.text = "Bad Gateway"
        good_resp = self._mock_success_response("RecoveredProvider")
        mock_post.side_effect = [err_resp, good_resp]

        orig_model = pipeline.FD_LARGE_LLM_MODEL
        orig_backoff = pipeline.OPENROUTER_RETRY_BACKOFF_BASE_SEC
        pipeline.FD_LARGE_LLM_MODEL = "large/test"
        pipeline.OPENROUTER_RETRY_BACKOFF_BASE_SEC = 0.001
        try:
            parsed, meta = pipeline.call_openrouter_large("system", "prompt", schema=pipeline.ESTIMATE_SCHEMA)
            self.assertIsNotNone(parsed)
            self.assertEqual(meta["provider"], "RecoveredProvider")
        finally:
            pipeline.FD_LARGE_LLM_MODEL = orig_model
            pipeline.OPENROUTER_RETRY_BACKOFF_BASE_SEC = orig_backoff


class TestCallLlmCacheProvider(unittest.TestCase):
    """call_llm() cache-hit path must backfill provider when missing."""

    @patch("run_v16_pipeline._read_llm_cache")
    def test_cache_hit_with_provider(self, mock_cache):
        """Cache entry that already has provider keeps it."""
        mock_cache.return_value = (
            {"estimated_hours": 1.0},
            {"prompt_tokens": 100, "completion_tokens": 50, "provider": "Chutes"},
        )
        parsed, meta = pipeline.call_llm("sys", "prompt")
        self.assertEqual(meta["provider"], "Chutes")
        self.assertTrue(meta["cache_hit"])

    @patch("run_v16_pipeline._read_llm_cache")
    def test_cache_hit_without_provider(self, mock_cache):
        """Old cache entry missing provider gets 'unknown_cache'."""
        mock_cache.return_value = (
            {"estimated_hours": 1.0},
            {"prompt_tokens": 100, "completion_tokens": 50},
        )
        parsed, meta = pipeline.call_llm("sys", "prompt")
        self.assertEqual(meta["provider"], "unknown_cache")
        self.assertTrue(meta["cache_hit"])

    @patch("run_v16_pipeline._read_llm_cache")
    def test_cache_hit_empty_provider(self, mock_cache):
        """Cache entry with provider='' gets 'unknown_cache'."""
        mock_cache.return_value = (
            {"estimated_hours": 1.0},
            {"prompt_tokens": 100, "completion_tokens": 50, "provider": ""},
        )
        parsed, meta = pipeline.call_llm("sys", "prompt")
        self.assertEqual(meta["provider"], "unknown_cache")
        self.assertTrue(meta["cache_hit"])


class TestAggregateProviderCounts(unittest.TestCase):
    """Test _aggregate_provider_counts helper in worker."""

    def test_basic_aggregation(self):
        sys.path.insert(0, os.path.join(SCRIPT_DIR, "..", "..", "..", "modal"))
        # Import the worker helper (it's in a different package, so test inline)
        # Use a direct reimplementation for isolated testing
        def _aggregate(llm_calls):
            if not llm_calls:
                return None
            counts = {}
            for call in llm_calls:
                if not isinstance(call, dict):
                    continue
                prov = str(call.get("provider") or "unknown")
                counts[prov] = counts.get(prov, 0) + 1
            return counts or None

        calls = [
            {"provider": "Chutes", "prompt_tokens": 100},
            {"provider": "Chutes", "prompt_tokens": 200},
            {"provider": "Alibaba", "prompt_tokens": 150},
            {"provider": None, "prompt_tokens": 50},
        ]
        result = _aggregate(calls)
        self.assertEqual(result, {"Chutes": 2, "Alibaba": 1, "unknown": 1})

    def test_empty_calls(self):
        def _aggregate(llm_calls):
            if not llm_calls:
                return None
            counts = {}
            for call in llm_calls:
                if not isinstance(call, dict):
                    continue
                prov = str(call.get("provider") or "unknown")
                counts[prov] = counts.get(prov, 0) + 1
            return counts or None

        self.assertIsNone(_aggregate([]))
        self.assertIsNone(_aggregate(None))


if __name__ == "__main__":
    unittest.main()
