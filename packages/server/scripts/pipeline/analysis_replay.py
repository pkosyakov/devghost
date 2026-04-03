"""
Analysis pipeline replay harness with instrumentation.

Replays a job config through pipeline stages (clone, extract, optionally LLM)
and produces a structured JSON report with timing breakdowns, git command
counts, and resource usage.

This tool measures infrastructure behavior, not LLM accuracy. For LLM accuracy
replay, see experiment_production_pipeline_replay.py.

Usage:
    # Replay from a fixture
    python analysis_replay.py --fixture narrow_scope --output report.json

    # Replay from a saved config
    python analysis_replay.py --config job_config.json --output report.json

    # With benchmark metrics (memory, disk)
    python analysis_replay.py --fixture narrow_scope --benchmark --output report.json
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent

_HEX_CHARS = set('0123456789abcdefABCDEF')


# ---------------------------------------------------------------------------
# Git command recording
# ---------------------------------------------------------------------------

@dataclass
class GitCommandRecord:
    command_type: str  # clone, fetch, log, diff, etc.
    argv: list[str]
    started_at: str
    duration_ms: float
    exit_code: int
    stdout_bytes: int
    stderr_bytes: int
    timed_out: bool
    timeout_sec: float | None = None
    error: str | None = None


@dataclass
class StageRecord:
    name: str
    repo: str
    started_at: str
    duration_ms: float
    git_commands: list[dict] = field(default_factory=list)
    commit_count: int = 0
    errors: list[str] = field(default_factory=list)


@dataclass
class ReplaySummary:
    total_duration_ms: float
    git_command_count: int
    timeout_count: int
    error_count: int
    peak_memory_mb: float | None = None
    disk_usage_mb: float | None = None
    git_commands_by_type: dict[str, int] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Sanitization
# ---------------------------------------------------------------------------

_SECRET_PATTERNS = re.compile(
    r'(key|secret|token|password|credential|auth)',
    re.IGNORECASE,
)

_URL_CREDENTIAL_RE = re.compile(
    r'(https?://)([^@]+)@',
)

# Matches OS temp dirs and user home paths that leak identifying info.
# Covers: /tmp/..., /var/folders/..., C:\Users\<name>\AppData\Local\Temp\...,
#          C:\Users\<name>\..., /home/<name>/...
_LOCAL_PATH_PATTERNS = [
    # Windows temp: C:\Users\<user>\AppData\Local\Temp\<prefix>...
    re.compile(r'[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\Temp\\[^\\]*'),
    # Windows home: C:\Users\<user>\...
    re.compile(r'[A-Za-z]:\\Users\\[^\\]+'),
    # Unix temp
    re.compile(r'/tmp/[^/]*'),
    # macOS temp
    re.compile(r'/var/folders/[^/]+/[^/]+/[^/]+/[^/]*'),
    # Unix home
    re.compile(r'/home/[^/]+'),
]


def _sanitize_path(value: str) -> str:
    """Replace local filesystem paths with normalized placeholders."""
    result = value
    for pattern in _LOCAL_PATH_PATTERNS:
        result = pattern.sub('<tmpdir>', result)
    return result


def sanitize_config(config: dict) -> dict:
    """Remove secrets, credentials, and local paths from a config dict (deep copy)."""
    return _sanitize_value(config)


def _sanitize_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _sanitize_dict_entry(k, v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_value(item) for item in value]
    if isinstance(value, str):
        return _sanitize_string(value)
    return value


def _sanitize_dict_entry(key: str, value: Any) -> Any:
    if isinstance(key, str) and _SECRET_PATTERNS.search(key):
        return '***REDACTED***'
    return _sanitize_value(value)


def _sanitize_string(value: str) -> str:
    """Apply all string-level sanitizations: URLs, credentials, paths."""
    value = _URL_CREDENTIAL_RE.sub(r'\1***@', value)
    value = _sanitize_path(value)
    return value


def sanitize_command(argv: list[str]) -> list[str]:
    """Sanitize a git command's argv, stripping credentials and paths."""
    return [_sanitize_string(arg) for arg in argv]


# ---------------------------------------------------------------------------
# Instrumented git runner
# ---------------------------------------------------------------------------

class GitRecorder:
    """Records git subprocess calls with timing and byte counts."""

    def __init__(self) -> None:
        self.records: list[GitCommandRecord] = []

    def run(
        self,
        argv: list[str],
        *,
        cwd: str | Path,
        timeout: float | None = None,
        command_type: str = 'unknown',
    ) -> subprocess.CompletedProcess:
        started_at = datetime.now(timezone.utc).isoformat()
        start = time.perf_counter()
        timed_out = False
        exit_code = -1
        stdout_bytes = 0
        stderr_bytes = 0
        error = None

        try:
            result = subprocess.run(
                argv,
                cwd=str(cwd),
                capture_output=True,
                timeout=timeout,
            )
            exit_code = result.returncode
            stdout_bytes = len(result.stdout) if result.stdout else 0
            stderr_bytes = len(result.stderr) if result.stderr else 0
            if exit_code != 0:
                stderr_text = result.stderr.decode('utf-8', errors='replace')[:500] if result.stderr else ''
                error = f'exit {exit_code}: {stderr_text}'
        except subprocess.TimeoutExpired:
            timed_out = True
            error = f'timeout after {timeout}s'
            result = subprocess.CompletedProcess(argv, -1, b'', b'timeout')
        except Exception as exc:
            error = str(exc)[:500]
            result = subprocess.CompletedProcess(argv, -1, b'', str(exc).encode()[:500])

        duration_ms = (time.perf_counter() - start) * 1000

        record = GitCommandRecord(
            command_type=command_type,
            argv=sanitize_command(argv),
            started_at=started_at,
            duration_ms=round(duration_ms, 2),
            exit_code=exit_code,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            timed_out=timed_out,
            timeout_sec=timeout,
            error=error,
        )
        self.records.append(record)
        return result


# ---------------------------------------------------------------------------
# Pipeline stage runners
# ---------------------------------------------------------------------------


def run_clone_stage(
    recorder: GitRecorder,
    repo_url: str,
    clone_dir: Path,
    branch: str = 'main',
    scope: dict | None = None,
) -> StageRecord:
    """Clone or fetch a repository, recording all git commands."""
    started_at = datetime.now(timezone.utc).isoformat()
    start = time.perf_counter()
    errors: list[str] = []
    rec_start = len(recorder.records)

    clone_path = clone_dir / 'repo'

    if clone_path.exists() and (clone_path / '.git').exists():
        # Fetch
        result = recorder.run(
            ['git', 'fetch', '--prune', '--no-tags'],
            cwd=clone_path,
            timeout=600,
            command_type='fetch',
        )
        if result.returncode != 0:
            errors.append(f'fetch failed: exit {result.returncode}')
    else:
        # Clone
        clone_args = ['git', 'clone', '--single-branch', '--branch', branch]

        # Shallow clone if scope is narrow
        if scope and scope.get('mode') == 'DATE_RANGE' and scope.get('since'):
            clone_args.extend(['--shallow-since', scope['since']])

        clone_args.extend([str(repo_url), str(clone_path)])

        result = recorder.run(
            clone_args,
            cwd=str(clone_dir),
            timeout=1800,
            command_type='clone',
        )
        if result.returncode != 0:
            errors.append(f'clone failed: exit {result.returncode}')

    duration_ms = (time.perf_counter() - start) * 1000

    git_cmds = [asdict(r) for r in recorder.records[rec_start:]]
    return StageRecord(
        name='clone',
        repo=_sanitize_string(str(repo_url)),
        started_at=started_at,
        duration_ms=round(duration_ms, 2),
        git_commands=git_cmds,
        errors=errors,
    )


def run_extract_stage(
    recorder: GitRecorder,
    clone_dir: Path,
    scope: dict | None = None,
) -> StageRecord:
    """Extract commits via git log --numstat, recording commands."""
    started_at = datetime.now(timezone.utc).isoformat()
    start = time.perf_counter()
    errors: list[str] = []
    commit_count = 0
    rec_start = len(recorder.records)

    repo_path = clone_dir / 'repo'
    if not (repo_path / '.git').exists():
        repo_path = clone_dir  # fixture repos don't have nested 'repo' dir

    log_args = [
        'git', 'log',
        '--format=%H|%ae|%an|%aI|%s',
        '--numstat',
        '--no-merges',
    ]

    if scope:
        if scope.get('mode') == 'LAST_N_COMMITS' and scope.get('max_count'):
            log_args.extend(['--max-count', str(scope['max_count'])])
        if scope.get('since'):
            log_args.extend(['--since', scope['since']])
        if scope.get('until'):
            log_args.extend(['--until', scope['until']])

    result = recorder.run(
        log_args,
        cwd=repo_path,
        timeout=900,
        command_type='log',
    )

    if result.returncode == 0 and result.stdout:
        stdout_text = result.stdout.decode('utf-8', errors='replace')
        for line in stdout_text.splitlines():
            # Commit lines start with 40-char hex SHA followed by '|'
            if len(line) > 41 and line[40] == '|' and all(c in _HEX_CHARS for c in line[:40]):
                commit_count += 1
    elif result.returncode != 0:
        errors.append(f'git log failed: exit {result.returncode}')

    duration_ms = (time.perf_counter() - start) * 1000

    git_cmds = [asdict(r) for r in recorder.records[rec_start:]]
    return StageRecord(
        name='extract',
        repo=_sanitize_string(str(repo_path)),
        started_at=started_at,
        duration_ms=round(duration_ms, 2),
        git_commands=git_cmds,
        commit_count=commit_count,
        errors=errors,
    )


# ---------------------------------------------------------------------------
# Resource measurement
# ---------------------------------------------------------------------------

def get_peak_memory_mb() -> float | None:
    """Get peak RSS in MB. Returns None if unavailable."""
    try:
        if platform.system() != 'Windows':
            import resource
            # getrusage returns KB on Linux, bytes on macOS
            usage = resource.getrusage(resource.RUSAGE_SELF)
            if platform.system() == 'Darwin':
                return round(usage.ru_maxrss / (1024 * 1024), 2)
            return round(usage.ru_maxrss / 1024, 2)
        else:
            import psutil
            return round(psutil.Process().memory_info().peak_wset / (1024 * 1024), 2)
    except (ImportError, AttributeError):
        return None


def get_disk_usage_mb(path: Path) -> float | None:
    """Get disk usage of a directory in MB."""
    if not path.exists():
        return None
    total = 0
    try:
        for entry in path.rglob('*'):
            if entry.is_file():
                total += entry.stat().st_size
    except OSError:
        return None
    return round(total / (1024 * 1024), 2)


# ---------------------------------------------------------------------------
# Main replay logic
# ---------------------------------------------------------------------------

def build_report(
    replay_id: str,
    config: dict,
    stages: list[StageRecord],
    recorder: GitRecorder,
    total_duration_ms: float,
    benchmark: bool = False,
    clone_dir: Path | None = None,
) -> dict:
    """Build the structured replay report."""
    timeout_count = sum(1 for r in recorder.records if r.timed_out)
    error_count = sum(1 for r in recorder.records if r.error and not r.timed_out)

    cmd_by_type: dict[str, int] = {}
    for r in recorder.records:
        cmd_by_type[r.command_type] = cmd_by_type.get(r.command_type, 0) + 1

    summary = ReplaySummary(
        total_duration_ms=round(total_duration_ms, 2),
        git_command_count=len(recorder.records),
        timeout_count=timeout_count,
        error_count=error_count,
        git_commands_by_type=cmd_by_type,
    )

    if benchmark:
        summary.peak_memory_mb = get_peak_memory_mb()
        if clone_dir:
            summary.disk_usage_mb = get_disk_usage_mb(clone_dir)

    # Build samples for baseline validation
    samples: list[dict] = []
    for stage in stages:
        metric = f'{stage.name}_duration_ms'
        existing = next((s for s in samples if s['metric'] == metric), None)
        if existing:
            existing['values'].append(stage.duration_ms)
            existing['count'] += 1
        else:
            samples.append({
                'metric': metric,
                'values': [stage.duration_ms],
                'count': 1,
            })

    # Add git_command_count sample
    samples.append({
        'metric': 'git_command_count',
        'values': [len(recorder.records)],
        'count': 1,
    })

    # Add resource samples when benchmark mode is active
    if benchmark:
        if summary.peak_memory_mb is not None:
            samples.append({
                'metric': 'peak_memory_mb',
                'values': [summary.peak_memory_mb],
                'count': 1,
            })
        if summary.disk_usage_mb is not None:
            samples.append({
                'metric': 'disk_usage_mb',
                'values': [summary.disk_usage_mb],
                'count': 1,
            })

    return {
        'replay_id': replay_id,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'config': sanitize_config(config),
        'stages': [asdict(s) for s in stages],
        'summary': asdict(summary),
        'samples': samples,
    }


def replay_fixture(fixture_name: str, benchmark: bool = False) -> dict:
    """Replay a named fixture through the pipeline stages.

    The fixture repo is cloned via real ``git clone`` into a separate temp
    directory so that clone-stage timings are genuine, not synthesized zeros.
    """
    from fixtures import create_fixture_by_name

    with tempfile.TemporaryDirectory(prefix='replay_') as tmp:
        tmp_path = Path(tmp)
        fixture = create_fixture_by_name(fixture_name, tmp_path / 'src')

        config = {
            'fixture': fixture_name,
            'repos': [{'url': str(fixture.path), 'branch': 'main', 'slug': f'fixture/{fixture_name}'}],
            'scope': {'mode': 'ALL_TIME'},
            'llm': {'provider': 'none', 'model': 'none'},
            'dry_run_llm': True,
        }

        clone_base = tmp_path / 'clones'
        clone_base.mkdir()
        return _run_replay(config, clone_base, benchmark=benchmark)


def _is_local_repo(url: str) -> bool:
    """Check if a URL points to a local git repository."""
    if url.startswith(('http://', 'https://', 'git://', 'ssh://', 'git@')):
        return False
    path = Path(url)
    return path.exists() and (path / '.git').is_dir()


def replay_config(config_path: Path, benchmark: bool = False) -> dict:
    """Replay a saved job config through the pipeline stages."""
    config = json.loads(config_path.read_text(encoding='utf-8'))

    with tempfile.TemporaryDirectory(prefix='replay_') as tmp:
        clone_base = Path(tmp)
        return _run_replay(config, clone_base, benchmark=benchmark)


def _run_replay(
    config: dict,
    clone_base: Path,
    *,
    benchmark: bool = False,
) -> dict:
    """Core replay execution.

    Iterates all repos in config, running a real ``git clone`` + extract
    for each one.  ``clone_base`` is the parent directory where per-repo
    clone dirs are created.
    """
    replay_id = str(uuid.uuid4())[:8]
    recorder = GitRecorder()
    stages: list[StageRecord] = []
    total_start = time.perf_counter()

    scope = config.get('scope', {})
    repos = config.get('repos', [])

    for idx, repo_spec in enumerate(repos):
        repo_url = repo_spec.get('url', '')
        branch = repo_spec.get('branch', 'main')
        clone_dir = clone_base / f'repo_{idx}'
        clone_dir.mkdir(parents=True, exist_ok=True)

        clone_stage = run_clone_stage(recorder, repo_url, clone_dir, branch, scope)
        stages.append(clone_stage)

        # Skip extract if clone failed — matches real worker behavior
        if clone_stage.errors:
            continue

        extract_stage = run_extract_stage(recorder, clone_dir, scope)
        stages.append(extract_stage)

    total_duration_ms = (time.perf_counter() - total_start) * 1000

    return build_report(
        replay_id=replay_id,
        config=config,
        stages=stages,
        recorder=recorder,
        total_duration_ms=total_duration_ms,
        benchmark=benchmark,
        clone_dir=clone_base if benchmark else None,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Replay analysis pipeline stages with instrumentation',
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--fixture', choices=['narrow_scope', 'wide_scope', 'rename_heavy', 'generated_file_heavy'],
                       help='Name of fixture to replay')
    group.add_argument('--config', type=Path, help='Path to job config JSON')
    parser.add_argument('--output', '-o', type=Path, help='Output JSON path (default: stdout)')
    parser.add_argument('--benchmark', action='store_true', help='Include memory/disk metrics')
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.fixture:
        report = replay_fixture(args.fixture, benchmark=args.benchmark)
    else:
        report = replay_config(args.config, benchmark=args.benchmark)

    output = json.dumps(report, indent=2, ensure_ascii=False)

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding='utf-8')
        print(f'Report written to {args.output}', file=sys.stderr)
    else:
        print(output)


if __name__ == '__main__':
    main()
