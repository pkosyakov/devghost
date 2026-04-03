"""
Deterministic git fixture generators for Phase 0 reliability testing.

Each generator creates a small local git repo with known commit history
for replay/benchmark tooling. All dates, authors, and messages are fixed
for reproducibility.

Usage:
    from fixtures import create_narrow_scope, create_wide_scope
    repo = create_narrow_scope(tmp_path)
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable


@dataclass
class FixtureRepo:
    path: Path
    name: str
    commit_count: int
    date_range: tuple[str, str]  # ISO dates (first commit, last commit)
    traits: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

FIXTURE_AUTHOR_NAME = 'Fixture Dev'
FIXTURE_AUTHOR_EMAIL = 'fixture@devghost.test'


def _git(repo: Path, *args: str, env_extra: dict[str, str] | None = None) -> str:
    env = {**os.environ, **(env_extra or {})}
    result = subprocess.run(
        ['git', '-C', str(repo), *args],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        env=env,
        check=True,
    )
    return result.stdout.strip()


def _init_repo(base_dir: Path, name: str) -> Path:
    repo = base_dir / name
    repo.mkdir(parents=True, exist_ok=True)
    _git(repo, 'init', '--initial-branch', 'main')
    _git(repo, 'config', 'user.name', FIXTURE_AUTHOR_NAME)
    _git(repo, 'config', 'user.email', FIXTURE_AUTHOR_EMAIL)
    return repo


def _commit(
    repo: Path,
    message: str,
    date: datetime,
    author_name: str = FIXTURE_AUTHOR_NAME,
    author_email: str = FIXTURE_AUTHOR_EMAIL,
) -> str:
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    iso = date.isoformat()
    env = {
        'GIT_AUTHOR_DATE': iso,
        'GIT_COMMITTER_DATE': iso,
        'GIT_AUTHOR_NAME': author_name,
        'GIT_AUTHOR_EMAIL': author_email,
        'GIT_COMMITTER_NAME': author_name,
        'GIT_COMMITTER_EMAIL': author_email,
    }
    _git(repo, 'add', '-A', env_extra=env)
    _git(repo, 'commit', '-m', message, '--allow-empty', env_extra=env)
    return _git(repo, 'rev-parse', 'HEAD')


def _write_file(repo: Path, rel_path: str, content: str) -> None:
    full = repo / rel_path
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding='utf-8')


# ---------------------------------------------------------------------------
# Fixture: narrow_scope — 15 commits in a 2-week window
# ---------------------------------------------------------------------------

def create_narrow_scope(base_dir: Path) -> FixtureRepo:
    """15 commits over 14 days. Simple TypeScript files, small changes."""
    repo = _init_repo(base_dir, 'narrow_scope')
    start = datetime(2025, 3, 1, 10, 0, 0, tzinfo=timezone.utc)

    _write_file(repo, 'src/index.ts', 'export const VERSION = "1.0.0";\n')
    _write_file(repo, 'src/utils.ts', 'export function add(a: number, b: number) { return a + b; }\n')
    _write_file(repo, 'package.json', '{"name": "fixture-narrow", "version": "1.0.0"}\n')
    _commit(repo, 'feat: initial project setup', start)

    files_content = [
        ('src/auth.ts', 'export function login(user: string) { return true; }\n'),
        ('src/db.ts', 'export function connect(url: string) { return {}; }\n'),
        ('src/api.ts', 'export function handler(req: any) { return { status: 200 }; }\n'),
        ('src/config.ts', 'export const CONFIG = { port: 3000, host: "localhost" };\n'),
        ('src/logger.ts', 'export function log(msg: string) { console.log(msg); }\n'),
    ]

    for i in range(1, 15):
        date = start + timedelta(days=i)
        file_path, content = files_content[i % len(files_content)]
        version = f'// v{i + 1}\n'
        _write_file(repo, file_path, version + content)
        _commit(repo, f'feat: update {file_path} iteration {i}', date)

    end = start + timedelta(days=14)
    return FixtureRepo(
        path=repo,
        name='narrow_scope',
        commit_count=15,
        date_range=(start.isoformat(), end.isoformat()),
        traits=['narrow_scope'],
    )


# ---------------------------------------------------------------------------
# Fixture: wide_scope — 120 commits spanning 2 years
# ---------------------------------------------------------------------------

def create_wide_scope(base_dir: Path) -> FixtureRepo:
    """120 commits spread over ~730 days. Simulates long-lived repo."""
    repo = _init_repo(base_dir, 'wide_scope')
    start = datetime(2023, 6, 1, 9, 0, 0, tzinfo=timezone.utc)
    interval = timedelta(days=6)  # ~120 commits over 720 days

    modules = ['auth', 'billing', 'api', 'db', 'config', 'utils', 'logger', 'middleware']

    _write_file(repo, 'package.json', '{"name": "fixture-wide", "version": "0.1.0"}\n')
    _write_file(repo, 'src/index.ts', 'export {};\n')
    _commit(repo, 'feat: init wide-scope project', start)

    for i in range(1, 120):
        date = start + interval * i
        mod = modules[i % len(modules)]
        content = f'// Module: {mod}, revision {i}\nexport const REV = {i};\n'
        _write_file(repo, f'src/{mod}.ts', content)
        if i % 10 == 0:
            _write_file(repo, f'tests/{mod}.test.ts', f'// test rev {i}\n')
        _commit(repo, f'feat({mod}): revision {i}', date)

    end = start + interval * 119
    return FixtureRepo(
        path=repo,
        name='wide_scope',
        commit_count=120,
        date_range=(start.isoformat(), end.isoformat()),
        traits=['wide_scope'],
    )


# ---------------------------------------------------------------------------
# Fixture: rename_heavy — 20 commits, 50%+ renames
# ---------------------------------------------------------------------------

def create_rename_heavy(base_dir: Path) -> FixtureRepo:
    """20 commits where >50% involve file renames or moves."""
    repo = _init_repo(base_dir, 'rename_heavy')
    start = datetime(2025, 2, 1, 10, 0, 0, tzinfo=timezone.utc)

    initial_files = [f'src/module_{i}.ts' for i in range(8)]
    for f in initial_files:
        _write_file(repo, f, f'// {f}\nexport const ID = "{f}";\n')
    _commit(repo, 'feat: initial 8 modules', start)

    commit_idx = 1
    # Renames: move files between directories
    renames = [
        ('src/module_0.ts', 'src/core/module_0.ts'),
        ('src/module_1.ts', 'src/core/module_1.ts'),
        ('src/module_2.ts', 'lib/module_2.ts'),
        ('src/module_3.ts', 'lib/helpers/module_3.ts'),
        ('src/module_4.ts', 'src/v2/module_4.ts'),
        ('src/core/module_0.ts', 'src/v2/core_module_0.ts'),
        ('src/core/module_1.ts', 'packages/shared/module_1.ts'),
        ('lib/module_2.ts', 'packages/lib/module_2.ts'),
        ('lib/helpers/module_3.ts', 'packages/lib/helpers/module_3.ts'),
        ('src/v2/module_4.ts', 'packages/v2/module_4.ts'),
    ]

    for old_path, new_path in renames:
        date = start + timedelta(days=commit_idx)
        src = repo / old_path
        if src.exists():
            dest = repo / new_path
            dest.parent.mkdir(parents=True, exist_ok=True)
            content = src.read_text(encoding='utf-8')
            content = f'// Moved from {old_path}\n' + content
            dest.write_text(content, encoding='utf-8')
            src.unlink()
            _commit(repo, f'refactor: move {old_path} -> {new_path}', date)
            commit_idx += 1

    # Non-rename commits (content changes)
    remaining_files = ['src/module_5.ts', 'src/module_6.ts', 'src/module_7.ts']
    for i, f in enumerate(remaining_files):
        for j in range(3):
            date = start + timedelta(days=commit_idx)
            _write_file(repo, f, f'// update {j + 1}\nexport const REV = {j + 1};\n')
            _commit(repo, f'feat: update {f} v{j + 1}', date)
            commit_idx += 1

    end = start + timedelta(days=commit_idx - 1)
    return FixtureRepo(
        path=repo,
        name='rename_heavy',
        commit_count=commit_idx,
        date_range=(start.isoformat(), end.isoformat()),
        traits=['rename_heavy'],
    )


# ---------------------------------------------------------------------------
# Fixture: generated_file_heavy — commits with large generated content
# ---------------------------------------------------------------------------

def create_generated_file_heavy(base_dir: Path) -> FixtureRepo:
    """15 commits with large auto-generated files (lockfiles, build output)."""
    repo = _init_repo(base_dir, 'generated_file_heavy')
    start = datetime(2025, 1, 15, 8, 0, 0, tzinfo=timezone.utc)

    _write_file(repo, 'src/index.ts', 'export {};\n')
    _write_file(repo, 'package.json', '{"name": "fixture-generated", "dependencies": {}}\n')
    _commit(repo, 'feat: init project', start)

    for i in range(1, 15):
        date = start + timedelta(days=i)

        # Small real change
        _write_file(repo, 'src/index.ts', f'export const VERSION = "{i}";\n')

        # Large generated file changes
        if i % 3 == 0:
            lockfile = _generate_lockfile(i, 200)
            _write_file(repo, 'package-lock.json', lockfile)

        if i % 4 == 0:
            bundle = _generate_bundle(i, 500)
            _write_file(repo, 'dist/bundle.js', bundle)

        if i % 5 == 0:
            types = _generate_types(i, 100)
            _write_file(repo, 'dist/types.d.ts', types)

        _commit(repo, f'chore: update deps and build v{i}', date)

    end = start + timedelta(days=14)
    return FixtureRepo(
        path=repo,
        name='generated_file_heavy',
        commit_count=15,
        date_range=(start.isoformat(), end.isoformat()),
        traits=['generated_file_heavy'],
    )


def _generate_lockfile(seed: int, entries: int) -> str:
    lines = ['{\n  "lockfileVersion": 3,\n  "packages": {']
    for j in range(entries):
        name = f'@fixture/pkg-{j}'
        ver = f'{seed}.{j}.0'
        lines.append(f'    "{name}": {{ "version": "{ver}", "resolved": "https://registry.npmjs.org/{name}/-/{name}-{ver}.tgz" }},')
    lines.append('  }\n}')
    return '\n'.join(lines)


def _generate_bundle(seed: int, lines_count: int) -> str:
    lines = [f'// Generated bundle v{seed}', '(function() {']
    for j in range(lines_count):
        lines.append(f'  var __{j} = function() {{ return {seed * 1000 + j}; }};')
    lines.append('})();')
    return '\n'.join(lines)


def _generate_types(seed: int, count: int) -> str:
    lines = [f'// Generated types v{seed}']
    for j in range(count):
        lines.append(f'export interface Type_{j} {{ id: number; value_{seed}: string; }}')
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Fixture: cache scenario — same repo, two config snapshots
# ---------------------------------------------------------------------------

def create_cache_scenario(base_dir: Path) -> tuple[FixtureRepo, dict, dict]:
    """
    Creates one repo and returns two config snapshots for cold/warm testing.
    Returns (fixture, cold_config, warm_config).
    """
    repo = create_narrow_scope(base_dir / '_cache_base')

    cold_config = {
        'repos': [{'url': str(repo.path), 'branch': 'main', 'slug': 'fixture/cache-test'}],
        'scope': {'mode': 'ALL_TIME'},
        'llm': {'provider': 'ollama', 'model': 'test-model'},
        'dry_run_llm': True,
        'cache_mode': 'off',
    }

    warm_config = {
        **cold_config,
        'cache_mode': 'any',
    }

    return repo, cold_config, warm_config


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

ALL_FIXTURES: dict[str, Callable] = {
    'narrow_scope': create_narrow_scope,
    'wide_scope': create_wide_scope,
    'rename_heavy': create_rename_heavy,
    'generated_file_heavy': create_generated_file_heavy,
}


def create_fixture_by_name(name: str, base_dir: Path) -> FixtureRepo:
    """Create a fixture by name. Raises KeyError if unknown."""
    if name not in ALL_FIXTURES:
        raise KeyError(f'Unknown fixture: {name!r}. Available: {list(ALL_FIXTURES.keys())}')
    return ALL_FIXTURES[name](base_dir)
