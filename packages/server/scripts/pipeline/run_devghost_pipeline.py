"""
DevGhost pipeline wrapper — processes a batch of commits via run_commit().
Called from Node.js as subprocess.

Usage:
    python scripts/run_devghost_pipeline.py <repo_path> <language> <commits_json_file>

Input JSON:  {"commits": [{"sha": "abc", "message": "feat: ...", "author_email": "...", "author_name": "..."}]}
Output JSON (stdout): {"status": "ok", "commits": [...], "errors": []}
Progress (stderr): PROGRESS:5/100
"""
import json
import math
import sys
import os
import io
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from run_v16_pipeline import run_commit, get_commit_diff


def is_root_commit(repo_dir: str, sha: str) -> bool:
    """Check if sha is the root commit (has no parent)."""
    result = subprocess.run(
        ['git', '-C', repo_dir, 'rev-parse', '--verify', f'{sha}~1'],
        capture_output=True, text=True
    )
    return result.returncode != 0


def _get_concurrency() -> int:
    """Determine concurrency from env. Default: 10 for openrouter, 1 for ollama."""
    explicit = os.environ.get('LLM_CONCURRENCY', '')
    if explicit:
        return max(1, int(explicit))
    provider = os.environ.get('LLM_PROVIDER', 'ollama')
    return 10 if provider == 'openrouter' else 1


def process_commits(repo_dir: str, language: str, commits: list) -> dict:
    repo_slug = os.path.basename(repo_dir).replace('/', '_')
    total = len(commits)
    concurrency = _get_concurrency()
    fail_fast = os.environ.get('FAIL_FAST', '').lower() in ('1', 'true', 'yes')
    fail_event = threading.Event()  # signals all workers to stop

    llm_provider = os.environ.get('LLM_PROVIDER', 'ollama')
    if llm_provider == 'openrouter':
        model = os.environ.get('OPENROUTER_MODEL', 'qwen/qwen-2.5-coder-32b-instruct')
        api_key = os.environ.get('OPENROUTER_API_KEY', '')
        print(f"OpenRouter key: {'present' if api_key else 'MISSING'}, model: {model}", file=sys.stderr, flush=True)
        print(
            "OpenRouter routing: "
            f"order={os.environ.get('OPENROUTER_PROVIDER_ORDER', 'Chutes')}, "
            f"allow_fallbacks={os.environ.get('OPENROUTER_ALLOW_FALLBACKS', 'true')}, "
            f"require_parameters={os.environ.get('OPENROUTER_REQUIRE_PARAMETERS', 'true')}",
            file=sys.stderr,
            flush=True,
        )
        if not api_key:
            print("FATAL: OPENROUTER_API_KEY is empty — all LLM calls will fail", file=sys.stderr, flush=True)
    else:
        model = os.environ.get('OLLAMA_MODEL', 'qwen2.5-coder:32b')
    print(f"LLM: {llm_provider} ({model}), commits: {total}, concurrency: {concurrency}",
          file=sys.stderr, flush=True)

    # Save real stdout for JSON output, redirect prints to stderr
    real_stdout = sys.stdout
    sys.stdout = sys.stderr

    # Thread-safe progress tracking
    completed_count = [0]
    lock = threading.Lock()
    results = [None] * total
    errors = []

    def process_one(idx: int, commit: dict):
        sha = commit['sha']
        message = commit.get('message', '')

        if fail_event.is_set():
            return idx, {
                'sha': sha, 'estimated_hours': 0, 'raw_estimate': 0,
                'method': 'skipped', 'routed_to': 'fail_fast',
                'analysis': None, 'rule_applied': None,
                'complexity_score': 0, 'complexity_guard': None, 'llm_calls': [],
            }, None

        try:
            if is_root_commit(repo_dir, sha):
                result = {
                    'sha': sha,
                    'estimated_hours': 0.5,
                    'raw_estimate': 0.5,
                    'method': 'root_commit_skip',
                    'routed_to': 'none',
                    'analysis': None,
                    'rule_applied': None,
                    'complexity_score': 0,
                    'complexity_guard': None,
                    'llm_calls': [],
                }
            else:
                result = run_commit(repo_dir, language, sha, message, repo_slug=repo_slug)
                result['sha'] = sha

            return idx, result, None

        except Exception as e:
            err_msg = f"Commit {sha[:8]}: {e}"
            error_result = {
                'sha': sha,
                'estimated_hours': 5.0,
                'raw_estimate': 5.0,
                'method': 'error',
                'routed_to': 'error',
                'analysis': None,
                'rule_applied': None,
                'complexity_score': 0,
                'complexity_guard': None,
                'llm_calls': [],
            }
            return idx, error_result, err_msg

    def on_complete(idx, result, err_msg):
        with lock:
            results[idx] = result
            if err_msg:
                errors.append(err_msg)
            # Fail-fast: stop on first LLM/processing error
            if fail_fast and (err_msg or result.get('method') == 'error'):
                fail_event.set()
            completed_count[0] += 1
            # Per-commit result for real-time UI log
            # Extract LLM error from llm_calls if no outer exception
            llm_calls = result.get('llm_calls', [])
            llm_error = err_msg
            if not llm_error and result.get('method') == 'error':
                for c in llm_calls:
                    if c.get('error'):
                        llm_error = c['error']
                        break
            log_entry = {
                'sha': result['sha'][:8],
                'status': 'error' if result.get('method') == 'error' else ('skip' if result.get('method') == 'root_commit_skip' else 'ok'),
                'hours': result.get('estimated_hours'),
                'method': result.get('method'),
                'type': (result.get('analysis') or {}).get('change_type'),
                'error': llm_error,
            }
            if llm_calls:
                log_entry['durationMs'] = sum(c.get('total_duration_ms', 0) for c in llm_calls)
            print(f"RESULT:{json.dumps(log_entry, default=str)}", file=sys.stderr, flush=True)
            print(f"PROGRESS:{completed_count[0]}/{total}", file=sys.stderr, flush=True)

    try:
        if concurrency <= 1:
            # Sequential processing (Ollama / single-threaded)
            for i, commit in enumerate(commits):
                idx, result, err_msg = process_one(i, commit)
                on_complete(idx, result, err_msg)
                if fail_event.is_set():
                    break
        else:
            # Parallel processing (OpenRouter)
            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                futures = {
                    executor.submit(process_one, i, commit): i
                    for i, commit in enumerate(commits)
                }
                for future in as_completed(futures):
                    idx, result, err_msg = future.result()
                    on_complete(idx, result, err_msg)
                    if fail_event.is_set():
                        # Cancel pending futures — already-submitted workers
                        # check fail_event and return immediately
                        for f in futures:
                            f.cancel()
                        break
    finally:
        sys.stdout = real_stdout

    # Filter out None slots (skipped commits after fail-fast)
    final_commits = [r for r in results if r is not None]
    status = 'error' if fail_event.is_set() else 'ok'
    return {'status': status, 'commits': final_commits, 'errors': errors}


def sanitize_floats(obj):
    """Replace NaN/Infinity with safe defaults — json.dumps produces invalid JSON for these."""
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return 0.0
        return obj
    if isinstance(obj, dict):
        return {k: sanitize_floats(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_floats(v) for v in obj]
    return obj


def main():
    if len(sys.argv) != 4:
        print(json.dumps({
            'status': 'error',
            'error': f'Usage: {sys.argv[0]} <repo_path> <language> <commits_json_file>',
            'commits': [], 'errors': [],
        }))
        sys.exit(1)

    repo_path = sys.argv[1]
    language = sys.argv[2]
    commits_file = sys.argv[3]

    try:
        with open(commits_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        commits = data.get('commits', [])
    except Exception as e:
        print(json.dumps({
            'status': 'error',
            'error': f'Failed to read commits file: {e}',
            'commits': [], 'errors': [],
        }))
        sys.exit(1)

    if not commits:
        print(json.dumps({'status': 'ok', 'commits': [], 'errors': []}))
        sys.exit(0)

    output = process_commits(repo_path, language, commits)
    print(json.dumps(sanitize_floats(output), default=str, ensure_ascii=False))


if __name__ == '__main__':
    main()
