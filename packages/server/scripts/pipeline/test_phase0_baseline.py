"""
Tests for Phase 0 baseline sample-size validator.

Validates that the validator correctly accepts/rejects reports
based on sample counts, resource metrics, and replay uniqueness.

Run: python -m pytest test_phase0_baseline.py -v
"""

from __future__ import annotations

import uuid

import pytest

from baseline_validator import (
    validate_baseline,
    REQUIRED_METRICS,
    RESOURCE_METRICS,
    DEFAULT_MIN_SAMPLES,
)
from analysis_benchmark import aggregate_reports, compute_summary, percentile


# ---------------------------------------------------------------------------
# Baseline validator — required metrics
# ---------------------------------------------------------------------------

class TestValidateBaseline:
    def test_passes_when_all_metrics_above_threshold(self):
        report = {
            'metric_summaries': {
                'clone_duration_ms': {'count': 60, 'mean': 1000},
                'extract_duration_ms': {'count': 55, 'mean': 3000},
                'git_command_count': {'count': 50, 'mean': 5},
            },
        }
        result = validate_baseline(report)
        assert result['valid'] is True
        assert all(c['passed'] for c in result['checks'])

    def test_fails_when_count_below_threshold(self):
        report = {
            'metric_summaries': {
                'clone_duration_ms': {'count': 10, 'mean': 1000},
                'extract_duration_ms': {'count': 50, 'mean': 3000},
                'git_command_count': {'count': 50, 'mean': 5},
            },
        }
        result = validate_baseline(report)
        assert result['valid'] is False
        clone_check = next(c for c in result['checks'] if c['metric'] == 'clone_duration_ms')
        assert clone_check['passed'] is False
        assert 'count=10' in clone_check['reason']

    def test_fails_when_metric_missing(self):
        report = {
            'metric_summaries': {
                'clone_duration_ms': {'count': 50},
                # extract_duration_ms missing
                'git_command_count': {'count': 50},
            },
        }
        result = validate_baseline(report)
        assert result['valid'] is False
        missing_check = next(c for c in result['checks'] if c['metric'] == 'extract_duration_ms')
        assert missing_check['passed'] is False
        assert 'not found' in missing_check['reason']

    def test_fails_when_all_metrics_missing(self):
        report = {'metric_summaries': {}}
        result = validate_baseline(report)
        assert result['valid'] is False
        assert all(not c['passed'] for c in result['checks'])

    def test_custom_min_samples(self):
        report = {
            'metric_summaries': {
                'clone_duration_ms': {'count': 30},
                'extract_duration_ms': {'count': 30},
                'git_command_count': {'count': 30},
            },
        }
        # Fails at default 50
        result = validate_baseline(report, min_samples=50)
        assert result['valid'] is False

        # Passes at 25
        result = validate_baseline(report, min_samples=25)
        assert result['valid'] is True

    def test_reports_correct_required_count(self):
        report = {
            'metric_summaries': {
                'clone_duration_ms': {'count': 5},
                'extract_duration_ms': {'count': 5},
                'git_command_count': {'count': 5},
            },
        }
        result = validate_baseline(report, min_samples=10)
        for check in result['checks']:
            assert check['required'] == 10

    def test_exactly_at_threshold_passes(self):
        report = {
            'metric_summaries': {
                'clone_duration_ms': {'count': 50},
                'extract_duration_ms': {'count': 50},
                'git_command_count': {'count': 50},
            },
        }
        result = validate_baseline(report, min_samples=50)
        assert result['valid'] is True

    def test_checks_contain_all_required_metrics(self):
        report = {'metric_summaries': {}}
        result = validate_baseline(report)
        checked_metrics = {c['metric'] for c in result['checks']}
        assert set(REQUIRED_METRICS).issubset(checked_metrics)


# ---------------------------------------------------------------------------
# Resource metric gating
# ---------------------------------------------------------------------------

class TestResourceMetricGating:
    def test_resource_metrics_validated_when_present(self):
        """Resource metrics present but below threshold must fail."""
        report = {
            'metric_summaries': {
                'clone_duration_ms': {'count': 50},
                'extract_duration_ms': {'count': 50},
                'git_command_count': {'count': 50},
                'peak_memory_mb': {'count': 10},  # below threshold
                'disk_usage_mb': {'count': 50},
            },
        }
        result = validate_baseline(report)
        assert result['valid'] is False
        mem_check = next(c for c in result['checks'] if c['metric'] == 'peak_memory_mb')
        assert mem_check['passed'] is False

    def test_resource_metrics_pass_when_above_threshold(self):
        report = {
            'metric_summaries': {
                'clone_duration_ms': {'count': 50},
                'extract_duration_ms': {'count': 50},
                'git_command_count': {'count': 50},
                'peak_memory_mb': {'count': 50},
                'disk_usage_mb': {'count': 50},
            },
        }
        result = validate_baseline(report)
        assert result['valid'] is True
        resource_checks = [c for c in result['checks'] if c['metric'] in RESOURCE_METRICS]
        assert len(resource_checks) == 2
        assert all(c['passed'] for c in resource_checks)

    def test_resource_metrics_skipped_when_absent(self):
        """Non-benchmark reports without resource metrics should still pass."""
        report = {
            'metric_summaries': {
                'clone_duration_ms': {'count': 50},
                'extract_duration_ms': {'count': 50},
                'git_command_count': {'count': 50},
            },
        }
        result = validate_baseline(report)
        assert result['valid'] is True
        resource_checks = [c for c in result['checks'] if c['metric'] in RESOURCE_METRICS]
        assert len(resource_checks) == 0


# ---------------------------------------------------------------------------
# Duplicate report detection
# ---------------------------------------------------------------------------

class TestDuplicateDetection:
    def test_duplicate_reports_rejected_by_validator(self):
        """50 copies of the same report must fail the unique replay gate."""
        report = {
            'replay_id': 'abc123',
            'samples': [
                {'metric': 'clone_duration_ms', 'values': [100], 'count': 1},
                {'metric': 'extract_duration_ms', 'values': [200], 'count': 1},
                {'metric': 'git_command_count', 'values': [3], 'count': 1},
            ],
            'summary': {'timeout_count': 0, 'error_count': 0},
        }
        agg = aggregate_reports([report] * 50)
        assert agg['unique_replay_count'] == 1

        result = validate_baseline(agg)
        assert result['valid'] is False
        dup_check = next(c for c in result['checks'] if c['metric'] == 'unique_replay_count')
        assert dup_check['passed'] is False
        assert 'duplicate' in dup_check['reason']

    def test_unique_reports_pass_dedup_gate(self):
        """50 reports with distinct replay_ids pass."""
        reports = []
        for i in range(50):
            reports.append({
                'replay_id': str(uuid.uuid4())[:8],
                'samples': [
                    {'metric': 'clone_duration_ms', 'values': [100 + i], 'count': 1},
                    {'metric': 'extract_duration_ms', 'values': [200 + i], 'count': 1},
                    {'metric': 'git_command_count', 'values': [3], 'count': 1},
                ],
                'summary': {'timeout_count': 0, 'error_count': 0},
            })
        agg = aggregate_reports(reports)
        assert agg['unique_replay_count'] == 50

        result = validate_baseline(agg)
        assert result['valid'] is True

    def test_aggregate_surfaces_unique_count(self):
        """aggregate_reports must include unique_replay_count in output."""
        reports = [
            {'replay_id': 'aaa', 'samples': [], 'summary': {'timeout_count': 0, 'error_count': 0}},
            {'replay_id': 'bbb', 'samples': [], 'summary': {'timeout_count': 0, 'error_count': 0}},
            {'replay_id': 'aaa', 'samples': [], 'summary': {'timeout_count': 0, 'error_count': 0}},
        ]
        agg = aggregate_reports(reports)
        assert agg['unique_replay_count'] == 2


# ---------------------------------------------------------------------------
# Benchmark aggregation
# ---------------------------------------------------------------------------

class TestAggregation:
    def _make_report(self, clone_ms: float, extract_ms: float, cmd_count: int,
                     replay_id: str | None = None) -> dict:
        return {
            'replay_id': replay_id or str(uuid.uuid4())[:8],
            'samples': [
                {'metric': 'clone_duration_ms', 'values': [clone_ms], 'count': 1},
                {'metric': 'extract_duration_ms', 'values': [extract_ms], 'count': 1},
                {'metric': 'git_command_count', 'values': [cmd_count], 'count': 1},
            ],
            'summary': {'timeout_count': 0, 'error_count': 0},
        }

    def test_aggregates_multiple_reports(self):
        reports = [self._make_report(100, 200, 3) for _ in range(60)]
        agg = aggregate_reports(reports)
        assert agg['report_count'] == 60
        assert agg['metric_summaries']['clone_duration_ms']['count'] == 60
        assert 'baseline_valid' not in agg
        assert agg['unique_replay_count'] == 60

    def test_aggregation_with_few_reports(self):
        reports = [self._make_report(100, 200, 3) for _ in range(10)]
        agg = aggregate_reports(reports)
        assert agg['metric_summaries']['clone_duration_ms']['count'] == 10

    def test_percentile_calculations(self):
        reports = [self._make_report(i * 10, i * 20, i) for i in range(1, 101)]
        agg = aggregate_reports(reports)
        clone_summary = agg['metric_summaries']['clone_duration_ms']
        assert clone_summary['count'] == 100
        assert clone_summary['p50'] > 0
        assert clone_summary['p95'] > clone_summary['p50']
        assert clone_summary['p99'] >= clone_summary['p95']


class TestPercentile:
    def test_single_value(self):
        assert percentile([42.0], 50) == 42.0

    def test_two_values(self):
        assert percentile([10.0, 20.0], 50) == 15.0

    def test_p0_is_min(self):
        assert percentile([1.0, 2.0, 3.0], 0) == 1.0

    def test_p100_is_max(self):
        assert percentile([1.0, 2.0, 3.0], 100) == 3.0

    def test_empty_returns_zero(self):
        assert percentile([], 50) == 0.0


class TestComputeSummary:
    def test_basic(self):
        s = compute_summary([1.0, 2.0, 3.0, 4.0, 5.0])
        assert s['count'] == 5
        assert s['mean'] == 3.0
        assert s['min'] == 1.0
        assert s['max'] == 5.0

    def test_empty(self):
        s = compute_summary([])
        assert s['count'] == 0
