"""
End-to-end production pipeline replay for the 20 small-commit cases.

This script measures the real output of run_v16_pipeline.run_commit() under
different model overrides. Unlike experiment_production_prompts.py, it:

- reuses the exact production routing logic (FD threshold + cascading path)
- applies correction rules and complexity guard
- records final estimated_hours, not the raw pass-2 estimate
- can run against revised GT labels by default

Usage:
    python experiment_production_pipeline_replay.py --repo C:\\Projects\\_tmp_devghost_audit\\artisan-private
    python experiment_production_pipeline_replay.py --repo ... --dry-run
    python experiment_production_pipeline_replay.py --repo ... --commit cba942fb
    python experiment_production_pipeline_replay.py --repo ... --validation-routing
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

sys.stdout.reconfigure(encoding='utf-8')
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[3]
sys.path.insert(0, str(SCRIPT_DIR))

import run_v16_pipeline as pipeline


DEFAULT_GT_FILE = REPO_ROOT / 'docs' / 'revised-small-commit-ground-truth.json'
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / 'experiment_v3_results'

MODELS: list[dict[str, str]] = [
    {'provider': 'ollama', 'model': 'qwen3-coder:30b', 'label': 'Ollama qwen3-coder:30b'},
    {'provider': 'openrouter', 'model': 'qwen/qwen3-coder', 'label': 'Qwen3 Coder'},
    {'provider': 'openrouter', 'model': 'qwen/qwen3-coder-next', 'label': 'Qwen3 Next'},
    {'provider': 'openrouter', 'model': 'openai/gpt-5.1-codex-mini', 'label': 'GPT-5.1 Codex Mini'},
    {'provider': 'openrouter', 'model': 'qwen/qwen3-coder-flash', 'label': 'Qwen3 Flash'},
    {'provider': 'openrouter', 'model': 'qwen/qwen3-coder-plus', 'label': 'Qwen3 Coder+'},
]


ENV_KEYS = [
    'LLM_PROVIDER',
    'OPENROUTER_MODEL',
    'OLLAMA_MODEL',
    'OPENROUTER_API_KEY',
    'OPENROUTER_PROVIDER_ORDER',
    'OPENROUTER_PROVIDER_IGNORE',
    'OPENROUTER_ALLOW_FALLBACKS',
    'OPENROUTER_REQUIRE_PARAMETERS',
    'NO_CACHE',
    'NO_LLM_CACHE',
    'PIPELINE_CACHE_NAMESPACE',
]

MISSING = object()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Replay the real production pipeline with model overrides')
    parser.add_argument('--repo', required=True, help='Path to git repo with the evaluated commits')
    parser.add_argument('--repo-slug', default='artisan-private-small-replay')
    parser.add_argument('--language', default='TypeScript')
    parser.add_argument('--gt-file', default=str(DEFAULT_GT_FILE))
    parser.add_argument('--output-dir', default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument('--commit', help='Optional commit SHA prefix filter')
    parser.add_argument('--models', help='Comma-separated model labels or model ids to run')
    parser.add_argument('--dry-run', action='store_true', help='Do not call models; only collect commit metadata')
    parser.add_argument('--no-llm-cache', action='store_true')
    parser.add_argument('--no-cache', action='store_true')
    parser.add_argument('--cache-namespace', default='small_commit_replay_e2e')
    parser.add_argument(
        '--validation-routing',
        action='store_true',
        help='Relax OpenRouter provider restrictions for cross-model validation',
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


def slugify(text: str) -> str:
    return text.replace('/', '_').replace('-', '_').replace('.', '_').replace(':', '_')


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
        gt_low = item.get('revised_gt_low', item.get('gt_low'))
        gt_high = item.get('revised_gt_high', item.get('gt_high'))
        if gt_low is None or gt_high is None:
            raise ValueError(f'Missing GT range in {gt_file} for {item.get("sha")}')
        cases.append(
            {
                'sha': item['sha'],
                'gt_low': gt_low,
                'gt_high': gt_high,
                'original_gt_low': item.get('original_gt_low'),
                'original_gt_high': item.get('original_gt_high'),
                'rationale': item.get('rationale', ''),
            }
        )
    return cases


def filter_cases(cases: list[dict[str, Any]], commit_prefix: str | None) -> list[dict[str, Any]]:
    if not commit_prefix:
        return cases
    filtered = [case for case in cases if case['sha'].startswith(commit_prefix)]
    if not filtered:
        raise ValueError(f'Commit {commit_prefix} not found in GT cases')
    return filtered


def select_models(models_arg: str | None) -> list[dict[str, str]]:
    if not models_arg:
        return MODELS
    wanted = {token.strip().lower() for token in models_arg.split(',') if token.strip()}
    selected = [
        model
        for model in MODELS
        if model['label'].lower() in wanted or model['model'].lower() in wanted
    ]
    if not selected:
        raise ValueError(f'No models matched --models={models_arg}')
    return selected


def prepare_cases(repo: Path, repo_slug: str, cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pipeline.reload_config()
    prepared: list[dict[str, Any]] = []
    for case in cases:
        sha = case['sha']
        message = git_subject(repo, sha)
        diff, fc, la, ld, _ = pipeline.get_commit_diff(str(repo), sha, repo_slug=repo_slug)
        prepared.append(
            {
                **case,
                'message': message,
                'label': f'{message} ({fc}f, +{la}/-{ld})',
                'fc': fc,
                'la': la,
                'ld': ld,
                'diff_chars': len(diff),
                'route_hint': 'fd' if len(diff) > pipeline.FD_THRESHOLD else 'cascading',
                'model_results': {},
            }
        )
    return prepared


def gt_midpoint(case: dict[str, Any]) -> float:
    return (case['gt_low'] + case['gt_high']) / 2


def is_in_range(estimate: float, case: dict[str, Any]) -> bool:
    return case['gt_low'] <= estimate <= case['gt_high']


def compute_aggregate(cases: list[dict[str, Any]], model_slug: str) -> dict[str, Any]:
    valid: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for case in cases:
        result = case['model_results'].get(model_slug)
        if result and result.get('estimated_hours') is not None:
            valid.append((case, result))
    if not valid:
        return {'count': 0}

    apes: list[float] = []
    signed_errors: list[float] = []
    maes: list[float] = []
    in_range_count = 0
    fd_count = 0

    for case, result in valid:
        est = result['estimated_hours']
        mid = gt_midpoint(case)
        ape = abs(est - mid) / mid if mid > 0 else 0
        apes.append(ape)
        signed_errors.append((est - mid) / mid if mid > 0 else 0)
        maes.append(abs(est - mid))
        if is_in_range(est, case):
            in_range_count += 1
        if str(result.get('method', '')).lower().startswith('fd'):
            fd_count += 1

    return {
        'count': len(valid),
        'mape': statistics.mean(apes) * 100,
        'median_ape': statistics.median(apes) * 100,
        'mae': statistics.mean(maes),
        'in_range': in_range_count,
        'in_range_pct': in_range_count / len(valid) * 100,
        'bias': statistics.mean(signed_errors) * 100,
        'fd_count': fd_count,
    }


def bucket_cases(cases: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    return {
        'Small (3-7 files)': [case for case in cases if case['fc'] <= 7],
        'Medium (8-15 files)': [case for case in cases if 8 <= case['fc'] <= 15],
        'Large (16-30 files)': [case for case in cases if case['fc'] >= 16],
    }


@contextmanager
def model_runtime(
    spec: dict[str, str],
    *,
    no_cache: bool,
    no_llm_cache: bool,
    cache_namespace: str,
    validation_routing: bool,
) -> Any:
    saved = {key: os.environ.get(key, MISSING) for key in ENV_KEYS}
    try:
        os.environ['LLM_PROVIDER'] = spec['provider']
        os.environ['PIPELINE_CACHE_NAMESPACE'] = cache_namespace

        if no_cache:
            os.environ['NO_CACHE'] = 'true'
        else:
            os.environ.pop('NO_CACHE', None)

        if no_llm_cache:
            os.environ['NO_LLM_CACHE'] = 'true'
        else:
            os.environ.pop('NO_LLM_CACHE', None)

        if spec['provider'] == 'openrouter':
            key = load_openrouter_key()
            if not key:
                raise RuntimeError('OPENROUTER_API_KEY not found in env or .env files')
            os.environ['OPENROUTER_MODEL'] = spec['model']
            if validation_routing:
                os.environ['OPENROUTER_PROVIDER_ORDER'] = ''
                os.environ['OPENROUTER_PROVIDER_IGNORE'] = ''
                os.environ['OPENROUTER_ALLOW_FALLBACKS'] = 'true'
                os.environ['OPENROUTER_REQUIRE_PARAMETERS'] = 'false'
        else:
            os.environ['OLLAMA_MODEL'] = spec['model']

        pipeline.reload_config()
        runtime = {
            'llm_provider': pipeline.LLM_PROVIDER,
            'openrouter_model': pipeline.OPENROUTER_MODEL,
            'ollama_model': os.environ.get('OLLAMA_MODEL', ''),
            'provider_order': list(pipeline.OPENROUTER_PROVIDER_ORDER),
            'provider_ignore': list(pipeline.OPENROUTER_PROVIDER_IGNORE),
            'allow_fallbacks': pipeline.OPENROUTER_ALLOW_FALLBACKS,
            'require_parameters': pipeline.OPENROUTER_REQUIRE_PARAMETERS,
            'fd_threshold': pipeline.FD_THRESHOLD,
            'fd_large_model': pipeline.FD_LARGE_LLM_MODEL,
            'cache_namespace': os.environ.get('PIPELINE_CACHE_NAMESPACE', ''),
            'no_cache': os.environ.get('NO_CACHE', '').lower() in ('1', 'true', 'yes'),
            'no_llm_cache': os.environ.get('NO_LLM_CACHE', '').lower() in ('1', 'true', 'yes'),
        }
        yield runtime
    finally:
        for key, value in saved.items():
            if value is MISSING:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        pipeline.reload_config()


def run_replay(
    repo: Path,
    repo_slug: str,
    language: str,
    cases: list[dict[str, Any]],
    models: list[dict[str, str]],
    *,
    dry_run: bool,
    no_cache: bool,
    no_llm_cache: bool,
    cache_namespace: str,
    validation_routing: bool,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    runtime_by_model: dict[str, dict[str, Any]] = {}

    print(f"\n{'=' * 72}")
    print('PRODUCTION PIPELINE REPLAY (run_commit)')
    print(f'Repo: {repo}')
    print(f'Cases: {len(cases)}')
    print(f'Models: {len(models)}')
    print(f'Dry run: {dry_run}')
    print(f'Validation routing: {validation_routing}')
    print(f"{'=' * 72}\n")

    for spec in models:
        model_slug = slugify(spec['model'])
        print(f"[MODEL] {spec['label']} ({spec['provider']}::{spec['model']})")

        with model_runtime(
            spec,
            no_cache=no_cache,
            no_llm_cache=no_llm_cache,
            cache_namespace=cache_namespace,
            validation_routing=validation_routing,
        ) as runtime:
            runtime_by_model[model_slug] = {
                'label': spec['label'],
                'provider': spec['provider'],
                'model': spec['model'],
                **runtime,
            }

            for idx, case in enumerate(cases, 1):
                print(
                    f"  [{idx}/{len(cases)}] {case['sha'][:8]} {case['message'][:60]}...",
                    end='',
                    flush=True,
                )

                if dry_run:
                    case['model_results'][model_slug] = {
                        'estimated_hours': None,
                        'raw_estimate': None,
                        'post_rules': None,
                        'method': None,
                        'routed_to': case['route_hint'],
                        'rule_applied': None,
                        'complexity_guard': None,
                        'analysis': None,
                        'llm_calls': [],
                        'dry_run': True,
                    }
                    print(f" route_hint={case['route_hint']} diff_chars={case['diff_chars']}")
                    continue

                started = time.time()
                result = pipeline.run_commit(
                    str(repo),
                    language,
                    case['sha'],
                    case['message'],
                    repo_slug=repo_slug,
                )
                elapsed = time.time() - started

                est = result.get('estimated_hours')
                raw = result.get('raw_estimate')
                method = result.get('method')
                rule = result.get('rule_applied')
                guard = result.get('complexity_guard')
                calls = result.get('llm_calls', [])
                cache_hits = sum(1 for call in calls if call.get('cache_hit'))
                route = result.get('routed_to', '?')

                case['model_results'][model_slug] = {
                    'estimated_hours': est,
                    'raw_estimate': raw,
                    'post_rules': result.get('post_rules'),
                    'method': method,
                    'routed_to': route,
                    'rule_applied': rule,
                    'complexity_guard': guard,
                    'analysis': result.get('analysis'),
                    'llm_calls': calls,
                    'elapsed_sec': round(elapsed, 3),
                }

                est_str = f'{est:.1f}h' if isinstance(est, (int, float)) else 'ERR'
                extra = []
                if raw is not None and raw != est:
                    extra.append(f'raw={raw:.1f}')
                if rule:
                    extra.append(rule)
                if guard:
                    extra.append(guard)
                if calls:
                    extra.append(f'calls={len(calls)} cache={cache_hits}/{len(calls)}')
                detail = f" [{'; '.join(extra)}]" if extra else ''
                print(f" {est_str} method={method} route={route}{detail}")

        print('')

    return cases, runtime_by_model


def build_markdown(
    cases: list[dict[str, Any]],
    models: list[dict[str, str]],
    runtime_by_model: dict[str, dict[str, Any]],
    gt_file: Path,
    repo: Path,
    dry_run: bool,
    validation_routing: bool,
) -> str:
    lines: list[str] = []
    lines.append('# Production Pipeline Replay — Small Commits')
    lines.append('')
    lines.append(f"**Date**: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append(f'**Method**: exact `run_commit()` replay from `run_v16_pipeline.py` with model overrides.')
    lines.append(f'**Repo**: `{repo}`')
    lines.append(f'**GT file**: `{gt_file}`')
    lines.append(f'**Dry run**: `{dry_run}`')
    lines.append(f'**Validation routing**: `{validation_routing}`')
    lines.append('')
    lines.append('## Methodology')
    lines.append('')
    lines.append('- This replay uses the real pipeline route selection: FD path for large diffs and cascading classify+estimate for smaller diffs.')
    lines.append('- Metrics are computed from final `estimated_hours` after correction rules and complexity guard, not from the raw pass-2 estimate.')
    lines.append('- OpenRouter/Ollama runtime config is reloaded before each model run via `reload_config()` to avoid stale globals.')
    lines.append('')

    lines.append('## Runtime')
    lines.append('')
    lines.append('| Model | Provider | FD threshold | Provider order | Ignore | Fallbacks | Require params | FD large model |')
    lines.append('|-------|----------|-------------:|----------------|--------|-----------|----------------|----------------|')
    for spec in models:
        slug = slugify(spec['model'])
        runtime = runtime_by_model[slug]
        order = ','.join(runtime['provider_order']) or '-'
        ignore = ','.join(runtime['provider_ignore']) or '-'
        fd_large = runtime['fd_large_model'] or '-'
        lines.append(
            f"| {runtime['label']} | {runtime['llm_provider']} | {runtime['fd_threshold']} | "
            f"{order} | {ignore} | {runtime['allow_fallbacks']} | {runtime['require_parameters']} | {fd_large} |"
        )
    lines.append('')

    if not dry_run:
        aggregates = []
        for spec in models:
            slug = slugify(spec['model'])
            agg = compute_aggregate(cases, slug)
            aggregates.append((spec, agg))

        ranked = sorted(
            [(spec, agg) for spec, agg in aggregates if agg.get('count', 0) > 0],
            key=lambda item: item[1]['mape'],
        )

        lines.append('## Rankings')
        lines.append('')
        lines.append('| # | Model | MAPE | Median APE | MAE | In-range | Bias | FD routed | Success |')
        lines.append('|---|-------|-----:|-----------:|----:|---------:|-----:|----------:|--------:|')
        for idx, (spec, agg) in enumerate(ranked, 1):
            lines.append(
                f"| {idx} | {spec['label']} | {agg['mape']:.1f}% | {agg['median_ape']:.1f}% | {agg['mae']:.2f} | "
                f"{agg['in_range']}/{agg['count']} ({agg['in_range_pct']:.0f}%) | {agg['bias']:+.1f}% | "
                f"{agg['fd_count']}/{agg['count']} | {agg['count']}/{len(cases)} |"
            )
        lines.append('')

        lines.append('## Size Breakdown')
        lines.append('')
        for bucket_name, bucket in bucket_cases(cases).items():
            if not bucket:
                continue
            lines.append(f'### {bucket_name} ({len(bucket)} commits)')
            lines.append('')
            lines.append('| Model | MAPE | In-range | MAE |')
            lines.append('|-------|-----:|---------:|----:|')
            bucket_ranked = []
            for spec in models:
                slug = slugify(spec['model'])
                agg = compute_aggregate(bucket, slug)
                if agg.get('count', 0) > 0:
                    bucket_ranked.append((spec, agg))
            bucket_ranked.sort(key=lambda item: item[1]['mape'])
            for spec, agg in bucket_ranked:
                lines.append(
                    f"| {spec['label']} | {agg['mape']:.1f}% | {agg['in_range']}/{agg['count']} | {agg['mae']:.2f} |"
                )
            lines.append('')

        lines.append('## Per-Commit Final Estimates')
        lines.append('')
        header = '| SHA | FC | Route hint | GT |'
        sep = '|-----|---:|------------|---:|'
        for spec in models:
            header += f" {spec['label'][:14]} |"
            sep += '--------------:|'
        lines.append(header)
        lines.append(sep)
        for case in cases:
            row = f"| {case['sha'][:8]} | {case['fc']} | {case['route_hint']} | {case['gt_low']}-{case['gt_high']} |"
            for spec in models:
                slug = slugify(spec['model'])
                result = case['model_results'].get(slug, {})
                est = result.get('estimated_hours')
                if isinstance(est, (int, float)):
                    bold = '**' if is_in_range(est, case) else ''
                    cell = f"{bold}{est:.1f}{bold}"
                else:
                    cell = '-'
                row += f' {cell} |'
            lines.append(row)
        lines.append('')
        lines.append('*Bold* = within GT range.')
        lines.append('')
    else:
        lines.append('## Dry Run')
        lines.append('')
        lines.append('| SHA | FC | +LA/-LD | Diff chars | Route hint |')
        lines.append('|-----|---:|--------:|-----------:|------------|')
        for case in cases:
            lines.append(
                f"| {case['sha'][:8]} | {case['fc']} | +{case['la']}/-{case['ld']} | {case['diff_chars']} | {case['route_hint']} |"
            )
        lines.append('')

    return '\n'.join(lines)


def save_outputs(
    cases: list[dict[str, Any]],
    models: list[dict[str, str]],
    runtime_by_model: dict[str, dict[str, Any]],
    output_dir: Path,
    gt_file: Path,
    repo: Path,
    dry_run: bool,
    validation_routing: bool,
) -> tuple[Path, Path]:
    ts = datetime.now().strftime('%Y-%m-%d_%H%M%S')
    output_dir.mkdir(parents=True, exist_ok=True)

    aggregates = {}
    for spec in models:
        slug = slugify(spec['model'])
        aggregates[slug] = {
            'label': spec['label'],
            'provider': spec['provider'],
            'model': spec['model'],
            **compute_aggregate(cases, slug),
        }

    payload = {
        'timestamp': ts,
        'design': 'Exact run_commit replay with model-specific env overrides',
        'repo': str(repo),
        'gt_file': str(gt_file),
        'dry_run': dry_run,
        'validation_routing': validation_routing,
        'runtime_by_model': runtime_by_model,
        'aggregates': aggregates,
        'cases': cases,
    }

    md = build_markdown(
        cases,
        models,
        runtime_by_model,
        gt_file,
        repo,
        dry_run,
        validation_routing,
    )

    md_path = output_dir / f'production_pipeline_replay_{ts}.md'
    json_path = output_dir / f'production_pipeline_replay_{ts}.json'
    md_path.write_text(md, encoding='utf-8')
    json_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding='utf-8')
    return md_path, json_path


def main() -> None:
    args = parse_args()
    repo = Path(args.repo).resolve()
    gt_file = Path(args.gt_file).resolve()
    output_dir = Path(args.output_dir).resolve()

    cases = load_gt_cases(gt_file)
    cases = filter_cases(cases, args.commit)
    models = select_models(args.models)
    prepared = prepare_cases(repo, args.repo_slug, cases)

    replayed, runtime_by_model = run_replay(
        repo,
        args.repo_slug,
        args.language,
        prepared,
        models,
        dry_run=args.dry_run,
        no_cache=args.no_cache,
        no_llm_cache=args.no_llm_cache,
        cache_namespace=args.cache_namespace,
        validation_routing=args.validation_routing,
    )

    md_path, json_path = save_outputs(
        replayed,
        models,
        runtime_by_model,
        output_dir,
        gt_file,
        repo,
        args.dry_run,
        args.validation_routing,
    )

    print(f'\nMarkdown: {md_path}')
    print(f'JSON: {json_path}')


if __name__ == '__main__':
    main()
