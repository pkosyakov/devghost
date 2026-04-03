"""
Tests for Phase 0 git fixture suite.

Validates that each fixture generator produces a valid git repo with
the expected commit count, date range, and traits.

Run: python -m pytest test_phase0_fixtures.py -v
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

import pytest

from fixtures import (
    create_narrow_scope,
    create_wide_scope,
    create_rename_heavy,
    create_generated_file_heavy,
    create_cache_scenario,
    create_fixture_by_name,
    ALL_FIXTURES,
    FixtureRepo,
)


@pytest.fixture
def tmp_dir():
    with tempfile.TemporaryDirectory(prefix='fixture_test_') as d:
        yield Path(d)


def _git_log_count(repo: Path) -> int:
    """Count commits via git log."""
    result = subprocess.run(
        ['git', '-C', str(repo), 'log', '--oneline', '--no-merges'],
        capture_output=True, text=True, encoding='utf-8',
    )
    return len(result.stdout.strip().splitlines()) if result.stdout.strip() else 0


def _git_log_dates(repo: Path) -> list[str]:
    """Get commit dates in ISO format."""
    result = subprocess.run(
        ['git', '-C', str(repo), 'log', '--format=%aI', '--no-merges'],
        capture_output=True, text=True, encoding='utf-8',
    )
    return [line.strip() for line in result.stdout.strip().splitlines() if line.strip()]


def _git_diff_renames(repo: Path) -> int:
    """Count rename-type changes across all commits."""
    result = subprocess.run(
        ['git', '-C', str(repo), 'log', '--diff-filter=R', '--summary', '--no-merges'],
        capture_output=True, text=True, encoding='utf-8',
    )
    return result.stdout.count('rename ')


# ---------------------------------------------------------------------------
# Narrow scope
# ---------------------------------------------------------------------------

class TestNarrowScope:
    def test_creates_valid_repo(self, tmp_dir: Path):
        fixture = create_narrow_scope(tmp_dir)
        assert isinstance(fixture, FixtureRepo)
        assert (fixture.path / '.git').is_dir()

    def test_commit_count(self, tmp_dir: Path):
        fixture = create_narrow_scope(tmp_dir)
        actual = _git_log_count(fixture.path)
        assert actual == fixture.commit_count == 15

    def test_date_range_within_2_weeks(self, tmp_dir: Path):
        fixture = create_narrow_scope(tmp_dir)
        dates = _git_log_dates(fixture.path)
        assert len(dates) == 15
        # Dates span at most 14 days
        first = dates[-1][:10]  # oldest
        last = dates[0][:10]    # newest
        from datetime import date as D
        d_first = D.fromisoformat(first)
        d_last = D.fromisoformat(last)
        assert (d_last - d_first).days <= 14

    def test_traits(self, tmp_dir: Path):
        fixture = create_narrow_scope(tmp_dir)
        assert 'narrow_scope' in fixture.traits


# ---------------------------------------------------------------------------
# Wide scope
# ---------------------------------------------------------------------------

class TestWideScope:
    def test_creates_valid_repo(self, tmp_dir: Path):
        fixture = create_wide_scope(tmp_dir)
        assert (fixture.path / '.git').is_dir()

    def test_commit_count(self, tmp_dir: Path):
        fixture = create_wide_scope(tmp_dir)
        actual = _git_log_count(fixture.path)
        assert actual == fixture.commit_count == 120

    def test_spans_over_a_year(self, tmp_dir: Path):
        fixture = create_wide_scope(tmp_dir)
        dates = _git_log_dates(fixture.path)
        from datetime import date as D
        first = D.fromisoformat(dates[-1][:10])
        last = D.fromisoformat(dates[0][:10])
        assert (last - first).days > 365

    def test_traits(self, tmp_dir: Path):
        fixture = create_wide_scope(tmp_dir)
        assert 'wide_scope' in fixture.traits


# ---------------------------------------------------------------------------
# Rename heavy
# ---------------------------------------------------------------------------

class TestRenameHeavy:
    def test_creates_valid_repo(self, tmp_dir: Path):
        fixture = create_rename_heavy(tmp_dir)
        assert (fixture.path / '.git').is_dir()

    def test_commit_count_matches(self, tmp_dir: Path):
        fixture = create_rename_heavy(tmp_dir)
        actual = _git_log_count(fixture.path)
        assert actual == fixture.commit_count

    def test_has_renames(self, tmp_dir: Path):
        fixture = create_rename_heavy(tmp_dir)
        rename_count = _git_diff_renames(fixture.path)
        total = fixture.commit_count
        # At least 50% of commits involve renames
        assert rename_count >= total * 0.5, f'Only {rename_count} renames in {total} commits'

    def test_traits(self, tmp_dir: Path):
        fixture = create_rename_heavy(tmp_dir)
        assert 'rename_heavy' in fixture.traits


# ---------------------------------------------------------------------------
# Generated file heavy
# ---------------------------------------------------------------------------

class TestGeneratedFileHeavy:
    def test_creates_valid_repo(self, tmp_dir: Path):
        fixture = create_generated_file_heavy(tmp_dir)
        assert (fixture.path / '.git').is_dir()

    def test_commit_count(self, tmp_dir: Path):
        fixture = create_generated_file_heavy(tmp_dir)
        actual = _git_log_count(fixture.path)
        assert actual == fixture.commit_count == 15

    def test_has_generated_files(self, tmp_dir: Path):
        fixture = create_generated_file_heavy(tmp_dir)
        result = subprocess.run(
            ['git', '-C', str(fixture.path), 'log', '--name-only', '--oneline'],
            capture_output=True, text=True, encoding='utf-8',
        )
        output = result.stdout
        assert 'package-lock.json' in output or 'dist/bundle.js' in output

    def test_traits(self, tmp_dir: Path):
        fixture = create_generated_file_heavy(tmp_dir)
        assert 'generated_file_heavy' in fixture.traits


# ---------------------------------------------------------------------------
# Cache scenario
# ---------------------------------------------------------------------------

class TestCacheScenario:
    def test_returns_configs(self, tmp_dir: Path):
        fixture, cold, warm = create_cache_scenario(tmp_dir)
        assert isinstance(fixture, FixtureRepo)
        assert cold['cache_mode'] == 'off'
        assert warm['cache_mode'] == 'any'
        assert cold['repos'] == warm['repos']


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

class TestRegistry:
    def test_all_fixtures_registered(self):
        assert set(ALL_FIXTURES.keys()) == {
            'narrow_scope', 'wide_scope', 'rename_heavy', 'generated_file_heavy',
        }

    def test_create_by_name(self, tmp_dir: Path):
        fixture = create_fixture_by_name('narrow_scope', tmp_dir)
        assert fixture.name == 'narrow_scope'

    def test_unknown_fixture_raises(self, tmp_dir: Path):
        with pytest.raises(KeyError, match='nonexistent'):
            create_fixture_by_name('nonexistent', tmp_dir)
