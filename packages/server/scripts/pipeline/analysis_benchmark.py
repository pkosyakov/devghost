"""
Benchmark aggregator for analysis replay reports.

Combines multiple replay JSON reports into an aggregate summary with
percentile statistics. Used together with baseline_validator.py for
CI assertions.

Usage:
    python analysis_benchmark.py --reports "replay_*.json" --output aggregate.json
    python analysis_benchmark.py --reports-dir ./reports --output aggregate.json
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Statistics helpers
# ---------------------------------------------------------------------------

def percentile(values: list[float], p: float) -> float:
    """Compute the p-th percentile (0-100) using linear interpolation."""
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    if n == 1:
        return sorted_vals[0]
    k = (p / 100) * (n - 1)
    f = math.floor(k)
    c = math.ceil(k)
    if f == c:
        return sorted_vals[int(k)]
    return sorted_vals[f] * (c - k) + sorted_vals[c] * (k - f)


def compute_summary(values: list[float]) -> dict[str, Any]:
    """Compute aggregate statistics for a list of values."""
    if not values:
        return {'count': 0, 'mean': 0, 'p50': 0, 'p95': 0, 'p99': 0, 'min': 0, 'max': 0}
    return {
        'count': len(values),
        'mean': round(sum(values) / len(values), 2),
        'p50': round(percentile(values, 50), 2),
        'p95': round(percentile(values, 95), 2),
        'p99': round(percentile(values, 99), 2),
        'min': round(min(values), 2),
        'max': round(max(values), 2),
    }


# ---------------------------------------------------------------------------
# Report aggregation
# ---------------------------------------------------------------------------

def load_reports(paths: list[Path]) -> list[dict]:
    """Load replay JSON reports from file paths."""
    reports = []
    for path in paths:
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            reports.append(data)
        except (json.JSONDecodeError, OSError) as exc:
            print(f'Warning: skipping {path}: {exc}', file=sys.stderr)
    return reports


def aggregate_reports(reports: list[dict]) -> dict:
    """Aggregate multiple replay reports into a benchmark summary."""
    # Collect all sample values by metric
    metric_values: dict[str, list[float]] = {}
    for report in reports:
        for sample in report.get('samples', []):
            metric = sample['metric']
            if metric not in metric_values:
                metric_values[metric] = []
            metric_values[metric].extend(sample.get('values', []))

    # Compute summaries
    metric_summaries = {
        metric: compute_summary(values)
        for metric, values in metric_values.items()
    }

    # Aggregate totals
    total_timeout_count = sum(
        report.get('summary', {}).get('timeout_count', 0)
        for report in reports
    )
    total_error_count = sum(
        report.get('summary', {}).get('error_count', 0)
        for report in reports
    )

    # Track unique replay IDs to detect duplicate-report baselines
    replay_ids = {r.get('replay_id') for r in reports if r.get('replay_id')}
    unique_replay_count = len(replay_ids)

    return {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'report_count': len(reports),
        'unique_replay_count': unique_replay_count,
        'metric_summaries': metric_summaries,
        'total_timeout_count': total_timeout_count,
        'total_error_count': total_error_count,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Aggregate replay reports into benchmark summary',
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--reports', help='Glob pattern for replay JSON files')
    group.add_argument('--reports-dir', type=Path, help='Directory containing replay JSON files')
    parser.add_argument('--output', '-o', type=Path, help='Output JSON path (default: stdout)')
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.reports:
        paths = sorted(Path(p) for p in glob.glob(args.reports))
    else:
        paths = sorted(args.reports_dir.glob('*.json'))

    if not paths:
        print('Error: no report files found', file=sys.stderr)
        sys.exit(1)

    reports = load_reports(paths)
    if not reports:
        print('Error: no valid reports loaded', file=sys.stderr)
        sys.exit(1)

    aggregate = aggregate_reports(reports)
    output = json.dumps(aggregate, indent=2, ensure_ascii=False)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding='utf-8')
        print(f'Aggregate written to {args.output} ({len(reports)} reports)', file=sys.stderr)
    else:
        print(output)


if __name__ == '__main__':
    main()
