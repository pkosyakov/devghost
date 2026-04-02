"""Helpers for per-commit LLM model attribution."""


def resolve_row_llm_model(method: str, result_model: str | None, default_model: str | None) -> str | None:
    """Return the model that actually produced the commit estimate.

    Rules:
    - root_commit_skip / error never have an LLM model.
    - FD* rows rely on the explicit model returned by the pipeline result.
      This preserves large-model attribution for FD_v3_holistic and leaves
      heuristic-only FD routes as null.
    - Non-FD rows use the current job's default model.
    """
    if method in {"root_commit_skip", "error"}:
        return None
    if method.startswith("FD"):
        return result_model or None
    return default_model
