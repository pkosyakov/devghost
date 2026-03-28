"""
Small-commit optimization experiment for the planned split rollout:

- small / normal commits: qwen/qwen3-coder-next
- large / true overflow commits: qwen/qwen3-coder-plus

The script focuses on the 20 revised-GT commits and answers a pragmatic
question for production: which small-path changes provide the best quality
gain with the least risk before customer demos.

It combines:
- existing exact-production replay results (baseline)
- existing calibrated single-call predictions
- a fresh live replay with Qwen3 Next using the model's actual context length

Usage:
    python experiment_small_commit_optimization.py --repo C:\\Projects\\_tmp_devghost_audit\\artisan-private
    python experiment_small_commit_optimization.py --repo ... --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

import requests

sys.stdout.reconfigure(encoding='utf-8')

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
sys.path.insert(0, str(SCRIPT_DIR))

import run_v16_pipeline as pipeline


DEFAULT_GT_FILE = REPO_ROOT / 'docs' / 'revised-small-commit-ground-truth.json'
DEFAULT_RESULTS_DIR = SCRIPT_DIR / 'experiment_v3_results'
CURRENT_MODEL = 'qwen/qwen3-coder-next'
LARGE_MODEL = 'qwen/qwen3-coder-plus'
CURRENT_LABEL = 'Qwen3 Next'
LARGE_LABEL = 'Qwen3 Coder+'

ENV_KEYS = [
    'LLM_PROVIDER',
    'OPENROUTER_MODEL',
    'OPENROUTER_API_KEY',
    'OPENROUTER_PROVIDER_ORDER',
    'OPENROUTER_PROVIDER_IGNORE',
    'OPENROUTER_ALLOW_FALLBACKS',
    'OPENROUTER_REQUIRE_PARAMETERS',
    'PIPELINE_CACHE_NAMESPACE',
    'NO_CACHE',
    'NO_LLM_CACHE',
    'MODEL_CONTEXT_LENGTH',
    'FD_V2_BRANCH',
    'FD_V2_HOLISTIC',
    'FD_V2_MIN_FILES',
    'FD_LARGE_LLM_PROVIDER',
    'FD_LARGE_LLM_MODEL',
]

MISSING = object()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Optimize the small-commit path around Qwen3 Next')
    parser.add_argument('--repo', required=True, help='Path to git repo with the evaluated commits')
    parser.add_argument('--repo-slug', default='artisan-private-small-opt')
    parser.add_argument('--language', default='TypeScript')
    parser.add_argument('--gt-file', default=str(DEFAULT_GT_FILE))
    parser.add_argument('--results-dir', default=str(DEFAULT_RESULTS_DIR))
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--no-llm-cache', action='store_true')
    parser.add_argument('--no-cache', action='store_true')
    parser.add_argument('--cache-namespace', default='small_commit_optimization')
    parser.add_argument(
        '--baseline-replay',
        help='Optional path to an exact replay JSON. If omitted, the latest suitable file is used.',
    )
    parser.add_argument(
        '--single-call-results',
        help='Optional path to model_comparison_small JSON. If omitted, the latest suitable file is used.',
    )
    return parser.parse_args()


def load_openrouter_key() -> str:
    key = os.environ.get('OPENROUTER_API_KEY', '').strip()
    if key:
        return key

    candidates = [
        REPO_ROOT / '.env',
        REPO_ROOT / 'packages' / '.env',
        REPO_ROOT / 'packages' / 'server' / '.env',
    ]
    for path in candidates:
        if not path.exists():
            continue
        for raw in path.read_text(encoding='utf-8').splitlines():
            line = raw.strip()
            if line.startswith('OPENROUTER_API_KEY='):
                value = line.split('=', 1)[1].strip().strip('"').strip("'")
                if value:
                    os.environ['OPENROUTER_API_KEY'] = value
                    return value
    return ''


def fetch_model_context_length(model_id: str, api_key: str) -> int:
    resp = requests.get(
        'https://openrouter.ai/api/v1/models',
        headers={'Authorization': f'Bearer {api_key}'},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    entry = next((item for item in data.get('data', []) if item.get('id') == model_id), None)
    if not entry or not entry.get('context_length'):
        raise RuntimeError(f'context_length not found for {model_id}')
    return int(entry['context_length'])


def git_subject(repo: Path, sha: str) -> str:
    return subprocess.run(
        ['git', '-C', str(repo), 'log', '--format=%s', '-1', sha],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        check=True,
    ).stdout.strip()


def load_gt_cases(gt_file: Path) -> list[dict[str, Any]]:
    raw = json.loads(gt_file.read_text(encoding='utf-8'))
    cases: list[dict[str, Any]] = []
    for item in raw:
        cases.append(
            {
                'sha': item['sha'],
                'gt_low': item['revised_gt_low'],
                'gt_high': item['revised_gt_high'],
                'original_gt_low': item.get('original_gt_low'),
                'original_gt_high': item.get('original_gt_high'),
                'rationale': item.get('rationale', ''),
            }
        )
    return cases


def gt_mid(case: dict[str, Any]) -> float:
    return (case['gt_low'] + case['gt_high']) / 2.0


def ape(estimate: float, case: dict[str, Any]) -> float:
    mid = gt_mid(case)
    return abs(estimate - mid) / mid * 100 if mid > 0 else 0.0


def is_in_range(estimate: float, case: dict[str, Any]) -> bool:
    return case['gt_low'] <= estimate <= case['gt_high']


def slugify(text: str) -> str:
    return text.replace('/', '_').replace('-', '_').replace('.', '_').replace(':', '_')


def find_latest_json(results_dir: Path, prefix: str, validator) -> Path:
    candidates = sorted(results_dir.glob(f'{prefix}_*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in candidates:
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except json.JSONDecodeError:
            continue
        if validator(data):
            return path
    raise FileNotFoundError(f'No matching {prefix}_*.json file found in {results_dir}')


def load_baseline_replay(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding='utf-8'))
    if 'cases' not in data:
        raise ValueError(f'{path} is not a production replay JSON')
    return data


def load_single_call_results(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding='utf-8'))
    if 'results' not in data:
        raise ValueError(f'{path} is not a model comparison JSON')
    return data


def prepare_cases(repo: Path, repo_slug: str, gt_cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pipeline.reload_config()
    prepared: list[dict[str, Any]] = []
    for case in gt_cases:
        sha = case['sha']
        message = git_subject(repo, sha)
        diff, fc, la, ld, changed_files = pipeline.get_commit_diff(str(repo), sha, repo_slug=repo_slug)
        prepared.append(
            {
                **case,
                'message': message,
                'label': f'{message} ({fc}f, +{la}/-{ld})',
                'fc': fc,
                'la': la,
                'ld': ld,
                'diff_chars': len(diff),
                'changed_files': changed_files,
            }
        )
    return prepared


def aggregate_from_predictions(cases: list[dict[str, Any]], prediction_by_sha: dict[str, float]) -> dict[str, Any]:
    valid = [(case, prediction_by_sha.get(case['sha'])) for case in cases]
    valid = [(case, est) for case, est in valid if est is not None]
    if not valid:
        return {'count': 0}

    apes = [ape(est, case) for case, est in valid]
    signed = [((est - gt_mid(case)) / gt_mid(case) * 100) for case, est in valid]
    maes = [abs(est - gt_mid(case)) for case, est in valid]
    in_range_count = sum(1 for case, est in valid if is_in_range(est, case))

    return {
        'count': len(valid),
        'mape': statistics.mean(apes),
        'median_ape': statistics.median(apes),
        'mae': statistics.mean(maes),
        'in_range': in_range_count,
        'in_range_pct': in_range_count / len(valid) * 100,
        'bias': statistics.mean(signed),
    }


def bucket_cases(cases: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    return {
        'Small (3-7 files)': [case for case in cases if case['fc'] <= 7],
        'Medium (8-15 files)': [case for case in cases if 8 <= case['fc'] <= 15],
        'Large (16-30 files)': [case for case in cases if case['fc'] >= 16],
    }


@contextmanager
def runtime_env(
    *,
    model: str,
    context_length: int,
    cache_namespace: str,
    no_cache: bool,
    no_llm_cache: bool,
) -> Any:
    saved = {key: os.environ.get(key, MISSING) for key in ENV_KEYS}
    try:
        api_key = load_openrouter_key()
        if not api_key:
            raise RuntimeError('OPENROUTER_API_KEY not found in env or .env files')

        os.environ['LLM_PROVIDER'] = 'openrouter'
        os.environ['OPENROUTER_MODEL'] = model
        os.environ['OPENROUTER_API_KEY'] = api_key
        os.environ['MODEL_CONTEXT_LENGTH'] = str(context_length)
        os.environ['PIPELINE_CACHE_NAMESPACE'] = cache_namespace
        os.environ['OPENROUTER_PROVIDER_ORDER'] = 'Chutes'
        os.environ['OPENROUTER_PROVIDER_IGNORE'] = 'Cloudflare'
        os.environ['OPENROUTER_ALLOW_FALLBACKS'] = 'true'
        os.environ['OPENROUTER_REQUIRE_PARAMETERS'] = 'true'
        os.environ['FD_V2_BRANCH'] = 'B'
        os.environ['FD_V2_HOLISTIC'] = 'true'
        os.environ['FD_V2_MIN_FILES'] = '50'
        os.environ.pop('FD_LARGE_LLM_PROVIDER', None)
        os.environ.pop('FD_LARGE_LLM_MODEL', None)

        if no_cache:
            os.environ['NO_CACHE'] = 'true'
        else:
            os.environ.pop('NO_CACHE', None)

        if no_llm_cache:
            os.environ['NO_LLM_CACHE'] = 'true'
        else:
            os.environ.pop('NO_LLM_CACHE', None)

        pipeline.reload_config()
        yield {
            'llm_provider': pipeline.LLM_PROVIDER,
            'model': pipeline.OPENROUTER_MODEL,
            'context_length': context_length,
            'fd_threshold': pipeline.FD_THRESHOLD,
            'provider_order': list(pipeline.OPENROUTER_PROVIDER_ORDER),
            'provider_ignore': list(pipeline.OPENROUTER_PROVIDER_IGNORE),
            'allow_fallbacks': pipeline.OPENROUTER_ALLOW_FALLBACKS,
            'require_parameters': pipeline.OPENROUTER_REQUIRE_PARAMETERS,
        }
    finally:
        for key, value in saved.items():
            if value is MISSING:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        pipeline.reload_config()


def run_actual_ctx_variant(
    repo: Path,
    repo_slug: str,
    language: str,
    cases: list[dict[str, Any]],
    *,
    context_length: int,
    dry_run: bool,
    no_cache: bool,
    no_llm_cache: bool,
    cache_namespace: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    result_by_sha: dict[str, Any] = {}
    with runtime_env(
        model=CURRENT_MODEL,
        context_length=context_length,
        cache_namespace=cache_namespace,
        no_cache=no_cache,
        no_llm_cache=no_llm_cache,
    ) as runtime:
        print(f"\n[VARIANT] actual_ctx_exact_next ({context_length} ctx, fd_threshold={runtime['fd_threshold']})")
        for idx, case in enumerate(cases, 1):
            print(f"  [{idx}/{len(cases)}] {case['sha'][:8]} {case['message'][:60]}...", end='', flush=True)
            if dry_run:
                result_by_sha[case['sha']] = {
                    'estimated_hours': None,
                    'raw_estimate': None,
                    'post_rules': None,
                    'method': None,
                    'routed_to': None,
                    'rule_applied': None,
                    'complexity_guard': None,
                    'llm_calls': [],
                    'dry_run': True,
                }
                print(' dry-run')
                continue

            started = time.time()
            result = pipeline.run_commit(str(repo), language, case['sha'], case['message'], repo_slug=repo_slug)
            elapsed_ms = int((time.time() - started) * 1000)
            result_by_sha[case['sha']] = {
                **result,
                'wall_time_ms_total': elapsed_ms,
            }
            print(
                f" est={result['estimated_hours']:.1f}h raw={result.get('raw_estimate', 0):.1f}"
                f" method={result.get('method')} rule={result.get('rule_applied') or '-'}"
                f" guard={result.get('complexity_guard') or '-'}"
            )

    return runtime, result_by_sha


def build_predictions_from_replay(replay: dict[str, Any], model_slug: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for case in replay['cases']:
        result = case['model_results'].get(model_slug)
        if result:
            out[case['sha']] = result
    return out


def build_predictions_from_single_call(single_call: dict[str, Any], key: str) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for row in single_call['results']:
        est = row.get(key)
        if est is not None:
            out[row['sha']] = {
                'estimated_hours': est,
                'reasoning': row.get(f'reasoning_{key}', ''),
            }
    return out


def summarize_variant(
    variant_id: str,
    label: str,
    cases: list[dict[str, Any]],
    prediction_by_sha: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    estimates = {sha: payload.get('estimated_hours') for sha, payload in prediction_by_sha.items()}
    overall = aggregate_from_predictions(cases, estimates)

    buckets: dict[str, Any] = {}
    for bucket_name, bucket in bucket_cases(cases).items():
        buckets[bucket_name] = aggregate_from_predictions(bucket, estimates)

    fd_cases = [case for case in cases if case.get('current_route_hint') == 'fd']
    non_fd_cases = [case for case in cases if case.get('current_route_hint') != 'fd']
    buckets['Current non-FD'] = aggregate_from_predictions(non_fd_cases, estimates)
    buckets['Current overflow/FD'] = aggregate_from_predictions(fd_cases, estimates)

    routing = {
        'fd_count': sum(
            1
            for sha, payload in prediction_by_sha.items()
            if str(payload.get('method', '')).lower().startswith('fd')
        ),
        'fallback_5h_count': sum(
            1
            for payload in prediction_by_sha.values()
            if payload.get('estimated_hours') == 5.0
        ),
    }

    llm_calls = [len(payload.get('llm_calls', [])) for payload in prediction_by_sha.values() if payload.get('llm_calls')]
    wall_times = [payload.get('wall_time_ms_total', 0) for payload in prediction_by_sha.values() if payload.get('wall_time_ms_total')]
    if llm_calls:
        routing['avg_llm_calls'] = statistics.mean(llm_calls)
    if wall_times:
        routing['avg_wall_ms'] = statistics.mean(wall_times)
        routing['median_wall_ms'] = statistics.median(wall_times)

    return {
        'id': variant_id,
        'label': label,
        'overall': overall,
        'buckets': buckets,
        'routing': routing,
    }


def format_metric(value: Any, suffix: str = '') -> str:
    if value is None:
        return '—'
    if isinstance(value, float):
        return f'{value:.1f}{suffix}'
    return f'{value}{suffix}'


def render_report(
    *,
    timestamp: str,
    repo: Path,
    gt_file: Path,
    baseline_path: Path,
    single_call_path: Path,
    actual_context_length: int,
    current_fd_threshold: int,
    actual_runtime: dict[str, Any],
    variants: list[dict[str, Any]],
) -> str:
    lines = [
        '# Small-Commit Optimization Research — Qwen3 Next',
        '',
        f'**Date:** {timestamp}',
        f'**Repo:** `{repo}`',
        f'**GT:** `{gt_file}`',
        f'**Baseline replay artifact:** `{baseline_path.name}`',
        f'**Single-call artifact:** `{single_call_path.name}`',
        '',
        '## 1. Goal',
        '',
        'Find the smallest safe production change that materially improves small/normal commit estimation before demos, given the target rollout:',
        '',
        f'- small / normal commits: `{CURRENT_MODEL}`',
        f'- large / true overflow commits: `{LARGE_MODEL}`',
        '',
        '## 2. Audit Summary',
        '',
        f'- Current production defaults still assume a `32768` context window for the Python pipeline, which yields an FD threshold of about `{current_fd_threshold}` chars.',
        f'- OpenRouter reports `{CURRENT_MODEL}` context_length=`{actual_context_length}`, which pushes the pipeline FD threshold to `{actual_runtime["fd_threshold"]}` chars (capped).',
        '- On the 20-case revised-GT set, the current exact replay quality problem is concentrated in 5 medium-overflow commits that are routed to legacy FD.',
        '- Post-rules are not the main culprit: they only materially changed 2 cases in the earlier replay and both changes hurt accuracy.',
        '',
        '## 3. Variants',
        '',
        '| Variant | What changes |',
        '|--------|---------------|',
        '| Current exact replay | Existing production small path with Qwen3 Next and default context assumptions |',
        '| Current non-FD + FD on Coder+ | Tests whether simply swapping the FD model helps the overflow cases |',
        '| Current non-FD + overflow single-call | Keep current routing for safe cases, replace only current overflow cases with calibrated single-call Qwen3 Next |',
        '| Actual-context exact replay | Run the real pipeline with Qwen3 Next but using its true OpenRouter context length |',
        '| Actual-context raw | Same as above, but evaluate raw estimate before rules and guards |',
        '| Actual-context post-rules only | Same as above, but remove only the complexity guard from the final score |',
        '| Single-call all commits | Historical upper bound from the calibrated single-call prompt on all 20 commits |',
        '',
        '## 4. Overall Results',
        '',
        '| Variant | MAPE | In-range | MAE | Bias | Current overflow/FD | Fallback 5h |',
        '|--------|-----:|---------:|----:|-----:|--------------------:|-----------:|',
    ]

    for variant in variants:
        overall = variant['overall']
        routing = variant['routing']
        lines.append(
            '| {label} | {mape} | {in_range}/{count} | {mae}h | {bias} | {fd_count} | {fallbacks} |'.format(
                label=variant['label'],
                mape=format_metric(overall.get('mape'), '%'),
                in_range=overall.get('in_range', '—'),
                count=overall.get('count', '—'),
                mae=format_metric(overall.get('mae')),
                bias=format_metric(overall.get('bias'), '%'),
                fd_count=routing.get('fd_count', '—'),
                fallbacks=routing.get('fallback_5h_count', '—'),
            )
        )

    lines += [
        '',
        '## 5. Bucket Results',
        '',
    ]

    bucket_names = [
        'Small (3-7 files)',
        'Medium (8-15 files)',
        'Large (16-30 files)',
        'Current non-FD',
        'Current overflow/FD',
    ]
    for bucket_name in bucket_names:
        lines += [
            f'### {bucket_name}',
            '',
            '| Variant | MAPE | In-range | MAE |',
            '|--------|-----:|---------:|----:|',
        ]
        for variant in variants:
            bucket = variant['buckets'][bucket_name]
            lines.append(
                '| {label} | {mape} | {in_range}/{count} | {mae}h |'.format(
                    label=variant['label'],
                    mape=format_metric(bucket.get('mape'), '%'),
                    in_range=bucket.get('in_range', '—'),
                    count=bucket.get('count', '—'),
                    mae=format_metric(bucket.get('mae')),
                )
            )
        lines.append('')

    lines += [
        '## 6. Interpretation',
        '',
        '- If `Actual-context exact replay` materially beats `Current exact replay`, the first production fix should be context-aware routing, not prompt tuning.',
        '- If `Current non-FD + overflow single-call` is best or near-best, the highest-leverage targeted patch is to bypass legacy FD for medium-overflow commits that still fit the real Qwen3 Next context.',
        '- If `Actual-context raw` beats `Actual-context exact replay`, the next patch should target correction rules / guards, not model quality.',
        '- `Current non-FD + FD on Coder+` is a negative control: if it stays weak, the issue is the legacy FD method itself, not just the model behind it.',
        '',
        '## 7. Recommended Production Order',
        '',
        '1. Ship the model split explicitly: `Qwen3 Next` for diff-based commits, `Qwen3 Coder+` for large / holistic path.',
        '2. Propagate actual model context length into the normal production pipeline so medium-overflow commits stop falling into legacy FD prematurely.',
        '3. If overflow quality still lags, replace legacy FD for "fits-real-context but exceeds old threshold" commits with calibrated single-call Qwen3 Next.',
        '4. Only after that re-evaluate whether correction rules / complexity guard still help on the new path.',
        '',
    ]

    return '\n'.join(lines)


def main() -> None:
    args = parse_args()
    repo = Path(args.repo).resolve()
    gt_file = Path(args.gt_file).resolve()
    results_dir = Path(args.results_dir).resolve()

    if not repo.exists():
        raise SystemExit(f'Repo not found: {repo}')
    if not gt_file.exists():
        raise SystemExit(f'GT file not found: {gt_file}')

    baseline_path = Path(args.baseline_replay).resolve() if args.baseline_replay else find_latest_json(
        results_dir,
        'production_pipeline_replay',
        lambda data: isinstance(data, dict)
        and isinstance(data.get('cases'), list)
        and any(
            case.get('model_results', {}).get('qwen_qwen3_coder_next') is not None
            for case in data.get('cases', [])
        )
        and any(
            case.get('model_results', {}).get('qwen_qwen3_coder_plus') is not None
            for case in data.get('cases', [])
        ),
    )
    single_call_path = Path(args.single_call_results).resolve() if args.single_call_results else find_latest_json(
        results_dir,
        'model_comparison_small',
        lambda data: isinstance(data, dict)
        and isinstance(data.get('results'), list)
        and any('est_qwen_qwen3_coder_next' in row for row in data.get('results', [])),
    )

    baseline = load_baseline_replay(baseline_path)
    single_call = load_single_call_results(single_call_path)

    gt_cases = load_gt_cases(gt_file)
    prepared_cases = prepare_cases(repo, f'{args.repo_slug}-prep', gt_cases)

    baseline_next = build_predictions_from_replay(baseline, 'qwen_qwen3_coder_next')
    baseline_plus = build_predictions_from_replay(baseline, 'qwen_qwen3_coder_plus')
    single_call_next = build_predictions_from_single_call(single_call, 'est_qwen_qwen3_coder_next')

    for case in prepared_cases:
        current = baseline_next.get(case['sha'])
        case['current_route_hint'] = 'fd' if current and str(current.get('method', '')).lower().startswith('fd') else 'cascading'

    api_key = load_openrouter_key()
    if not api_key and not args.dry_run:
        raise SystemExit('OPENROUTER_API_KEY not found in env or .env files')
    actual_context_length = fetch_model_context_length(CURRENT_MODEL, api_key) if api_key else 262144

    current_fd_threshold = int(baseline['runtime_by_model']['qwen_qwen3_coder_next']['fd_threshold'])
    actual_runtime, actual_ctx_results = run_actual_ctx_variant(
        repo,
        f'{args.repo_slug}-actualctx',
        args.language,
        prepared_cases,
        context_length=actual_context_length,
        dry_run=args.dry_run,
        no_cache=args.no_cache,
        no_llm_cache=args.no_llm_cache,
        cache_namespace=args.cache_namespace,
    )

    current_exact = baseline_next

    plus_fd_hybrid: dict[str, dict[str, Any]] = {}
    single_overflow_hybrid: dict[str, dict[str, Any]] = {}
    actual_ctx_raw: dict[str, dict[str, Any]] = {}
    actual_ctx_post_rules: dict[str, dict[str, Any]] = {}
    for case in prepared_cases:
        sha = case['sha']
        current_payload = current_exact[sha]
        current_is_fd = str(current_payload.get('method', '')).lower().startswith('fd')

        if current_is_fd:
            plus_fd_hybrid[sha] = dict(baseline_plus[sha])
            single_overflow_hybrid[sha] = {
                'estimated_hours': single_call_next[sha]['estimated_hours'],
                'method': 'single_call_overflow_patch',
                'llm_calls': [],
            }
        else:
            plus_fd_hybrid[sha] = dict(current_payload)
            single_overflow_hybrid[sha] = dict(current_payload)

        actual = actual_ctx_results[sha]
        actual_ctx_raw[sha] = {
            **actual,
            'estimated_hours': actual.get('raw_estimate'),
            'method': f"{actual.get('method', '?')}_raw",
        }
        actual_ctx_post_rules[sha] = {
            **actual,
            'estimated_hours': actual.get('post_rules'),
            'method': f"{actual.get('method', '?')}_post_rules",
        }

    variants = [
        summarize_variant('current_exact_next', 'Current exact replay', prepared_cases, current_exact),
        summarize_variant('current_next_plus_fd', 'Current non-FD + FD on Coder+', prepared_cases, plus_fd_hybrid),
        summarize_variant(
            'current_next_single_overflow',
            'Current non-FD + overflow single-call',
            prepared_cases,
            single_overflow_hybrid,
        ),
        summarize_variant('actual_ctx_exact_next', 'Actual-context exact replay', prepared_cases, actual_ctx_results),
        summarize_variant('actual_ctx_raw_next', 'Actual-context raw', prepared_cases, actual_ctx_raw),
        summarize_variant(
            'actual_ctx_post_rules_next',
            'Actual-context post-rules only',
            prepared_cases,
            actual_ctx_post_rules,
        ),
        summarize_variant('single_call_all_next', 'Single-call all commits', prepared_cases, single_call_next),
    ]

    timestamp = datetime.now().strftime('%Y-%m-%d_%H%M%S')
    output_json = results_dir / f'small_commit_optimization_{timestamp}.json'
    output_md = results_dir / f'small_commit_optimization_{timestamp}.md'

    payload = {
        'timestamp': timestamp,
        'repo': str(repo),
        'gt_file': str(gt_file),
        'baseline_replay': str(baseline_path),
        'single_call_results': str(single_call_path),
        'current_model': CURRENT_MODEL,
        'large_model': LARGE_MODEL,
        'actual_context_length': actual_context_length,
        'current_fd_threshold': current_fd_threshold,
        'actual_ctx_runtime': actual_runtime,
        'cases': prepared_cases,
        'variants': variants,
        'actual_ctx_results': actual_ctx_results,
    }
    output_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    output_md.write_text(
        render_report(
            timestamp=timestamp,
            repo=repo,
            gt_file=gt_file,
            baseline_path=baseline_path,
            single_call_path=single_call_path,
            actual_context_length=actual_context_length,
            current_fd_threshold=current_fd_threshold,
            actual_runtime=actual_runtime,
            variants=variants,
        ),
        encoding='utf-8',
    )

    print(f"\nSaved JSON: {output_json}")
    print(f"Saved MD:   {output_md}")


if __name__ == '__main__':
    main()
