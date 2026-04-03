"""
Baseline sample-size validator for benchmark reports.

Validates that an aggregate benchmark report meets the sample-size contract:
- N >= 50 per required metric gate
- All required metrics present
- Reports pass/fail per metric with reasons

Exit codes:
    0 — all checks pass
    1 — one or more checks fail

Usage:
    python baseline_validator.py --report aggregate.json
    python baseline_validator.py --report aggregate.json --min-samples 100
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


DEFAULT_MIN_SAMPLES = 50

REQUIRED_METRICS = [
    'clone_duration_ms',
    'extract_duration_ms',
    'git_command_count',
]

# Resource metrics are validated when present in the report (benchmark mode).
# They are not required for non-benchmark replays.
RESOURCE_METRICS = [
    'peak_memory_mb',
    'disk_usage_mb',
]


def validate_baseline(report: dict, min_samples: int = DEFAULT_MIN_SAMPLES) -> dict:
    """
    Validate a benchmark report against the baseline contract.

    Accepts both aggregate format (metric_summaries) and raw replay format (samples).
    Returns a validation result dict with pass/fail per metric.

    Required metrics must always be present and meet the sample-size threshold.
    Resource metrics (peak_memory_mb, disk_usage_mb) are validated when present.
    Unique replay count is validated when the report includes replay_ids.
    """
    metric_summaries = report.get('metric_summaries', {})

    # Also accept raw replay format: convert samples to metric_summaries
    if not metric_summaries and 'samples' in report:
        for sample in report['samples']:
            name = sample.get('metric', '')
            values = sample.get('values', [])
            count = sample.get('count', len(values))
            summary: dict[str, Any] = {'count': count}
            if values:
                summary['mean'] = round(sum(values) / len(values), 2)
                summary['min'] = round(min(values), 2)
                summary['max'] = round(max(values), 2)
            metric_summaries[name] = summary

    results: list[dict[str, Any]] = []
    all_pass = True

    # Check required metrics
    for metric in REQUIRED_METRICS:
        check = _check_metric(metric, metric_summaries, min_samples, required=True)
        results.append(check)
        if not check['passed']:
            all_pass = False

    # Check resource metrics when present
    for metric in RESOURCE_METRICS:
        if metric in metric_summaries:
            check = _check_metric(metric, metric_summaries, min_samples, required=False)
            results.append(check)
            if not check['passed']:
                all_pass = False

    # Check unique replay count to reject duplicate-only baselines
    unique_replays = report.get('unique_replay_count')
    if unique_replays is not None:
        if unique_replays < min_samples:
            results.append({
                'metric': 'unique_replay_count',
                'passed': False,
                'reason': f'unique_replays={unique_replays} < {min_samples} (duplicate reports detected)',
                'count': unique_replays,
                'required': min_samples,
            })
            all_pass = False
        else:
            results.append({
                'metric': 'unique_replay_count',
                'passed': True,
                'reason': f'unique_replays={unique_replays} >= {min_samples}',
                'count': unique_replays,
                'required': min_samples,
            })

    return {
        'valid': all_pass,
        'min_samples': min_samples,
        'checks': results,
    }


def _check_metric(
    metric: str,
    summaries: dict,
    min_samples: int,
    *,
    required: bool,
) -> dict[str, Any]:
    """Check a single metric against the sample-size threshold."""
    summary = summaries.get(metric)

    if summary is None:
        return {
            'metric': metric,
            'passed': not required,
            'reason': 'metric not found in report' if required else 'metric not present (optional)',
            'count': 0,
            'required': min_samples,
        }

    count = summary.get('count', 0)
    if count < min_samples:
        return {
            'metric': metric,
            'passed': False,
            'reason': f'count={count} < {min_samples}',
            'count': count,
            'required': min_samples,
        }

    return {
        'metric': metric,
        'passed': True,
        'reason': f'count={count} >= {min_samples}',
        'count': count,
        'required': min_samples,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Validate baseline sample-size contract',
    )
    parser.add_argument('--report', type=Path, required=True, help='Path to aggregate benchmark JSON')
    parser.add_argument('--min-samples', type=int, default=DEFAULT_MIN_SAMPLES,
                        help=f'Minimum sample count per metric (default: {DEFAULT_MIN_SAMPLES})')
    parser.add_argument('--output', '-o', type=Path, help='Output validation result JSON (default: stdout)')
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    try:
        report = json.loads(args.report.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError) as exc:
        print(f'Error reading report: {exc}', file=sys.stderr)
        sys.exit(1)

    result = validate_baseline(report, min_samples=args.min_samples)
    output = json.dumps(result, indent=2, ensure_ascii=False)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding='utf-8')
    else:
        print(output)

    # Print summary to stderr
    for check in result['checks']:
        status = 'PASS' if check['passed'] else 'FAIL'
        print(f'  [{status}] {check["metric"]}: {check["reason"]}', file=sys.stderr)

    if result['valid']:
        print('\nBaseline contract: PASSED', file=sys.stderr)
        sys.exit(0)
    else:
        print('\nBaseline contract: FAILED', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
