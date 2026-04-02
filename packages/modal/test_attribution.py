import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from attribution import resolve_row_llm_model


class ResolveRowLlmModelTests(unittest.TestCase):
    def test_fd_v3_holistic_keeps_explicit_large_model(self):
        self.assertEqual(
            resolve_row_llm_model("FD_v3_holistic", "qwen/qwen3-coder-plus", "qwen/qwen3-coder-next"),
            "qwen/qwen3-coder-plus",
        )

    def test_fd_mechanical_keeps_explicit_default_model(self):
        self.assertEqual(
            resolve_row_llm_model("FD_hybrid_mechanical_none", "qwen/qwen3-coder-next", "qwen/qwen3-coder-next"),
            "qwen/qwen3-coder-next",
        )

    def test_fd_heuristic_only_stays_null(self):
        self.assertIsNone(
            resolve_row_llm_model("FD_v3_heuristic_only", None, "qwen/qwen3-coder-next"),
        )

    def test_non_fd_uses_job_default_model(self):
        self.assertEqual(
            resolve_row_llm_model("cascading_none", None, "qwen/qwen3-coder-next"),
            "qwen/qwen3-coder-next",
        )

    def test_special_methods_stay_null(self):
        self.assertIsNone(resolve_row_llm_model("root_commit_skip", "qwen/qwen3-coder-next", "qwen/qwen3-coder-next"))
        self.assertIsNone(resolve_row_llm_model("error", "qwen/qwen3-coder-next", "qwen/qwen3-coder-next"))


if __name__ == "__main__":
    unittest.main()
