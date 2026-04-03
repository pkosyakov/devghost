"""
Tests for Phase 0 analysis replay harness.

Validates that the replay tool produces valid structured JSON with
required fields, sanitizes secrets and paths, exercises real git clone,
and supports multi-repo configs.

Run: python -m pytest test_phase0_replay.py -v
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from analysis_replay import (
    GitRecorder,
    sanitize_config,
    sanitize_command,
    replay_fixture,
    replay_config,
    _run_replay,
    build_report,
    StageRecord,
    get_disk_usage_mb,
    _is_local_repo,
    _sanitize_path,
)


@pytest.fixture
def tmp_dir():
    with tempfile.TemporaryDirectory(prefix='replay_test_') as d:
        yield Path(d)


# ---------------------------------------------------------------------------
# Sanitization
# ---------------------------------------------------------------------------

class TestSanitization:
    def test_strips_secret_keys(self):
        config = {
            'api_key': 'sk-abc123',
            'webhook_secret': 'whsec_xyz',
            'auth_token': 'ghp_123456',
            'name': 'safe-value',
        }
        result = sanitize_config(config)
        assert result['api_key'] == '***REDACTED***'
        assert result['webhook_secret'] == '***REDACTED***'
        assert result['auth_token'] == '***REDACTED***'
        assert result['name'] == 'safe-value'

    def test_strips_nested_secrets(self):
        config = {
            'llm': {
                'openrouter_api_key': 'sk-abc',
                'model': 'gpt-4',
            },
        }
        result = sanitize_config(config)
        assert result['llm']['openrouter_api_key'] == '***REDACTED***'
        assert result['llm']['model'] == 'gpt-4'

    def test_strips_url_credentials(self):
        config = {
            'url': 'https://user:pass123@github.com/owner/repo.git',
        }
        result = sanitize_config(config)
        assert 'pass123' not in result['url']
        assert 'user' not in result['url']
        assert 'github.com/owner/repo.git' in result['url']

    def test_sanitize_command_strips_urls(self):
        argv = ['git', 'clone', 'https://token@github.com/org/repo.git']
        result = sanitize_command(argv)
        assert 'token' not in result[2]
        assert 'github.com/org/repo.git' in result[2]

    def test_preserves_safe_values(self):
        config = {
            'fixture': 'narrow_scope',
            'scope': {'mode': 'ALL_TIME'},
            'repos': [{'slug': 'owner/repo', 'branch': 'main'}],
        }
        result = sanitize_config(config)
        assert result == config

    def test_handles_list_values(self):
        config = {
            'urls': ['https://tok@github.com/a/b.git', 'safe-value'],
        }
        result = sanitize_config(config)
        assert 'tok' not in result['urls'][0]
        assert result['urls'][1] == 'safe-value'

    def test_strips_windows_temp_paths(self):
        path = r'C:\Users\pkosy\AppData\Local\Temp\replay_abc123\repo'
        result = _sanitize_path(path)
        assert 'pkosy' not in result
        assert '<tmpdir>' in result

    def test_strips_windows_home_paths(self):
        path = r'C:\Users\pkosy\Projects\devghost'
        result = _sanitize_path(path)
        assert 'pkosy' not in result
        assert '<tmpdir>' in result

    def test_strips_unix_temp_paths(self):
        path = '/tmp/replay_abc123/repo'
        result = _sanitize_path(path)
        assert '<tmpdir>' in result

    def test_strips_unix_home_paths(self):
        path = '/home/developer/projects/repo'
        result = _sanitize_path(path)
        assert 'developer' not in result
        assert '<tmpdir>' in result

    def test_sanitize_config_strips_paths(self):
        config = {
            'repos': [{'url': r'C:\Users\pkosy\AppData\Local\Temp\replay_x\src\narrow'}],
        }
        result = sanitize_config(config)
        assert 'pkosy' not in json.dumps(result)


# ---------------------------------------------------------------------------
# GitRecorder
# ---------------------------------------------------------------------------

class TestGitRecorder:
    def test_records_successful_command(self, tmp_dir: Path):
        recorder = GitRecorder()
        result = recorder.run(
            ['git', 'version'],
            cwd=tmp_dir,
            command_type='version',
        )
        assert result.returncode == 0
        assert len(recorder.records) == 1
        rec = recorder.records[0]
        assert rec.command_type == 'version'
        assert rec.exit_code == 0
        assert rec.timed_out is False
        assert rec.duration_ms > 0
        assert rec.stdout_bytes > 0

    def test_records_failed_command(self, tmp_dir: Path):
        recorder = GitRecorder()
        result = recorder.run(
            ['git', 'log'],  # will fail — not a git repo
            cwd=tmp_dir,
            command_type='log',
        )
        assert result.returncode != 0
        rec = recorder.records[0]
        assert rec.exit_code != 0
        assert rec.error is not None

    def test_records_timeout(self, tmp_dir: Path):
        recorder = GitRecorder()
        result = recorder.run(
            ['python', '-c', 'import time; time.sleep(10)'],
            cwd=tmp_dir,
            timeout=0.5,
            command_type='slow',
        )
        rec = recorder.records[0]
        assert rec.timed_out is True
        assert rec.error is not None
        assert 'timeout' in rec.error.lower()


# ---------------------------------------------------------------------------
# Replay with fixtures — exercises real git clone
# ---------------------------------------------------------------------------

class TestReplayFixture:
    def test_narrow_scope_replay(self):
        report = replay_fixture('narrow_scope')
        assert 'replay_id' in report
        assert 'timestamp' in report
        assert 'config' in report
        assert 'stages' in report
        assert 'summary' in report
        assert 'samples' in report

    def test_has_clone_and_extract_stages(self):
        report = replay_fixture('narrow_scope')
        stage_names = [s['name'] for s in report['stages']]
        assert 'clone' in stage_names
        assert 'extract' in stage_names

    def test_clone_stage_exercises_real_git_clone(self):
        """P1 fix: clone stage must run real git clone, not synthesize zeros."""
        report = replay_fixture('narrow_scope')
        clone = next(s for s in report['stages'] if s['name'] == 'clone')
        assert clone['duration_ms'] > 0, 'clone must have non-zero duration'
        assert len(clone['git_commands']) > 0, 'clone must record git commands'
        assert any(
            cmd['command_type'] == 'clone' for cmd in clone['git_commands']
        ), 'clone stage must contain a git clone command'

    def test_extract_finds_commits(self):
        report = replay_fixture('narrow_scope')
        extract = next(s for s in report['stages'] if s['name'] == 'extract')
        assert extract['commit_count'] > 0

    def test_summary_has_required_fields(self):
        report = replay_fixture('narrow_scope')
        summary = report['summary']
        assert 'total_duration_ms' in summary
        assert 'git_command_count' in summary
        assert 'timeout_count' in summary
        assert summary['total_duration_ms'] > 0
        assert summary['timeout_count'] == 0

    def test_samples_have_required_metrics(self):
        report = replay_fixture('narrow_scope')
        metrics = {s['metric'] for s in report['samples']}
        assert 'clone_duration_ms' in metrics
        assert 'extract_duration_ms' in metrics
        assert 'git_command_count' in metrics

    def test_clone_duration_sample_is_nonzero(self):
        """P1 fix: clone_duration_ms sample must reflect real clone time."""
        report = replay_fixture('narrow_scope')
        clone_sample = next(s for s in report['samples'] if s['metric'] == 'clone_duration_ms')
        assert clone_sample['values'][0] > 0, 'clone_duration_ms must not be zero'

    def test_sample_counts_are_positive(self):
        report = replay_fixture('narrow_scope')
        for sample in report['samples']:
            assert sample['count'] >= 1
            assert len(sample['values']) >= 1

    def test_report_is_valid_json(self):
        report = replay_fixture('narrow_scope')
        output = json.dumps(report, indent=2, ensure_ascii=False)
        parsed = json.loads(output)
        assert parsed['replay_id'] == report['replay_id']

    def test_benchmark_mode_adds_summary_fields(self):
        report = replay_fixture('narrow_scope', benchmark=True)
        summary = report['summary']
        assert 'peak_memory_mb' in summary
        assert 'disk_usage_mb' in summary

    def test_benchmark_mode_adds_resource_samples(self):
        """P2 fix: resource metrics must become samples for aggregation/gating."""
        report = replay_fixture('narrow_scope', benchmark=True)
        metrics = {s['metric'] for s in report['samples']}
        assert 'peak_memory_mb' in metrics
        assert 'disk_usage_mb' in metrics

    def test_git_commands_have_structure(self):
        report = replay_fixture('narrow_scope')
        extract = next(s for s in report['stages'] if s['name'] == 'extract')
        for cmd in extract['git_commands']:
            assert 'command_type' in cmd
            assert 'argv' in cmd
            assert 'duration_ms' in cmd
            assert 'exit_code' in cmd
            assert 'timed_out' in cmd

    def test_timing_values_are_positive(self):
        report = replay_fixture('narrow_scope')
        for stage in report['stages']:
            assert stage['duration_ms'] >= 0
            for cmd in stage.get('git_commands', []):
                assert cmd['duration_ms'] >= 0

    def test_artifacts_do_not_contain_local_paths(self):
        """P2 fix: replay artifacts must not leak filesystem paths or usernames."""
        report = replay_fixture('narrow_scope')
        artifact = json.dumps(report)
        # Must not contain Windows user paths or temp dirs
        import os
        username = os.environ.get('USERNAME') or os.environ.get('USER', '')
        if username:
            assert username not in artifact, f'artifact leaks username {username!r}'

    def test_wide_scope_replay(self):
        report = replay_fixture('wide_scope')
        extract = next(s for s in report['stages'] if s['name'] == 'extract')
        assert extract['commit_count'] > 50

    def test_rename_heavy_replay(self):
        report = replay_fixture('rename_heavy')
        assert report['summary']['git_command_count'] >= 1

    def test_generated_file_heavy_replay(self):
        report = replay_fixture('generated_file_heavy')
        extract = next(s for s in report['stages'] if s['name'] == 'extract')
        assert extract['commit_count'] == 15


# ---------------------------------------------------------------------------
# Replay from config file
# ---------------------------------------------------------------------------

class TestReplayConfig:
    def test_replay_from_config_json(self, tmp_dir: Path):
        from fixtures import create_narrow_scope
        fixture = create_narrow_scope(tmp_dir / 'repo')

        config = {
            'repos': [{'url': str(fixture.path), 'branch': 'main', 'slug': 'test/config-replay'}],
            'scope': {'mode': 'ALL_TIME'},
            'llm': {'provider': 'none', 'model': 'none'},
            'dry_run_llm': True,
        }

        config_path = tmp_dir / 'config.json'
        config_path.write_text(json.dumps(config), encoding='utf-8')

        report = replay_config(config_path)
        assert 'replay_id' in report
        assert 'stages' in report
        extract = next(s for s in report['stages'] if s['name'] == 'extract')
        assert extract['commit_count'] == 15

    def test_config_sanitizes_secrets(self, tmp_dir: Path):
        from fixtures import create_narrow_scope
        fixture = create_narrow_scope(tmp_dir / 'repo')

        config = {
            'repos': [{'url': str(fixture.path), 'branch': 'main', 'slug': 'test/secrets'}],
            'scope': {'mode': 'ALL_TIME'},
            'llm': {'provider': 'openrouter', 'model': 'gpt-4', 'api_key': 'sk-secret-123'},
            'dry_run_llm': True,
        }

        config_path = tmp_dir / 'config.json'
        config_path.write_text(json.dumps(config), encoding='utf-8')

        report = replay_config(config_path)
        config_str = json.dumps(report['config'])
        assert 'sk-secret-123' not in config_str
        assert 'REDACTED' in config_str

    def test_multi_repo_config(self, tmp_dir: Path):
        """P1 fix: replay must exercise all repos, not just repos[0]."""
        from fixtures import create_narrow_scope, create_rename_heavy
        repo1 = create_narrow_scope(tmp_dir / 'repo1')
        repo2 = create_rename_heavy(tmp_dir / 'repo2')

        config = {
            'repos': [
                {'url': str(repo1.path), 'branch': 'main', 'slug': 'test/repo1'},
                {'url': str(repo2.path), 'branch': 'main', 'slug': 'test/repo2'},
            ],
            'scope': {'mode': 'ALL_TIME'},
            'llm': {'provider': 'none', 'model': 'none'},
            'dry_run_llm': True,
        }

        config_path = tmp_dir / 'config.json'
        config_path.write_text(json.dumps(config), encoding='utf-8')

        report = replay_config(config_path)

        clone_stages = [s for s in report['stages'] if s['name'] == 'clone']
        extract_stages = [s for s in report['stages'] if s['name'] == 'extract']
        assert len(clone_stages) == 2, 'must have clone stage per repo'
        assert len(extract_stages) == 2, 'must have extract stage per repo'

        total_commits = sum(s['commit_count'] for s in extract_stages)
        assert total_commits == repo1.commit_count + repo2.commit_count

    def test_multi_repo_clone_duration_samples(self, tmp_dir: Path):
        """Multi-repo replay accumulates per-repo clone_duration_ms samples."""
        from fixtures import create_narrow_scope
        repo1 = create_narrow_scope(tmp_dir / 'repo1')
        repo2 = create_narrow_scope(tmp_dir / 'repo2')

        config = {
            'repos': [
                {'url': str(repo1.path), 'branch': 'main', 'slug': 'test/r1'},
                {'url': str(repo2.path), 'branch': 'main', 'slug': 'test/r2'},
            ],
            'scope': {'mode': 'ALL_TIME'},
            'llm': {'provider': 'none', 'model': 'none'},
            'dry_run_llm': True,
        }

        config_path = tmp_dir / 'config.json'
        config_path.write_text(json.dumps(config), encoding='utf-8')

        report = replay_config(config_path)
        clone_sample = next(s for s in report['samples'] if s['metric'] == 'clone_duration_ms')
        assert clone_sample['count'] == 2
        assert len(clone_sample['values']) == 2
        assert all(v > 0 for v in clone_sample['values'])

    def test_clone_failure_skips_extract(self, tmp_dir: Path):
        """Clone failure must not produce a fabricated extract error."""
        config = {
            'repos': [{'url': '/nonexistent/repo/path', 'branch': 'main', 'slug': 'bad/repo'}],
            'scope': {'mode': 'ALL_TIME'},
            'dry_run_llm': True,
        }

        clone_base = tmp_dir / 'clones'
        clone_base.mkdir()
        report = _run_replay(config, clone_base)

        clone_stages = [s for s in report['stages'] if s['name'] == 'clone']
        extract_stages = [s for s in report['stages'] if s['name'] == 'extract']

        assert len(clone_stages) == 1
        assert len(clone_stages[0]['errors']) > 0, 'clone must report an error'
        assert len(extract_stages) == 0, 'extract must be skipped after clone failure'
        assert report['summary']['error_count'] >= 1


# ---------------------------------------------------------------------------
# Local repo detection
# ---------------------------------------------------------------------------

class TestIsLocalRepo:
    def test_url_is_not_local(self):
        assert _is_local_repo('https://github.com/org/repo.git') is False
        assert _is_local_repo('git@github.com:org/repo.git') is False
        assert _is_local_repo('ssh://git@host/repo.git') is False

    def test_existing_repo_is_local(self, tmp_dir: Path):
        from fixtures import create_narrow_scope
        fixture = create_narrow_scope(tmp_dir / 'repo')
        assert _is_local_repo(str(fixture.path)) is True

    def test_nonexistent_path_is_not_local(self):
        assert _is_local_repo('/nonexistent/path/repo') is False

    def test_existing_dir_without_git_is_not_local(self, tmp_dir: Path):
        assert _is_local_repo(str(tmp_dir)) is False
