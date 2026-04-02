"""
Git operations for Modal worker.
Port of packages/server/src/lib/services/git-operations.ts

Key differences from TypeScript version:
- Clones into Modal Volume (/repos) instead of process.cwd()/clones
- Uses subprocess instead of child_process
- CVE-2024-32002 mitigation: core.symlinks=false in clone args
"""
import logging
import os
import re
import subprocess
from datetime import datetime, timedelta
from urllib.parse import urlparse, urlunparse

logger = logging.getLogger(__name__)


def _env_positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        return max(1, int(raw))
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


GIT_SHALLOW_BUFFER_DAYS = _env_positive_int("GIT_SHALLOW_BUFFER_DAYS", 14)
GIT_FETCH_TIMEOUT_SEC = _env_positive_int("GIT_FETCH_TIMEOUT_SEC", 600)
GIT_CLONE_TIMEOUT_SEC = _env_positive_int("GIT_CLONE_TIMEOUT_SEC", 1800)
GIT_LOG_TIMEOUT_SEC = _env_positive_int("GIT_LOG_TIMEOUT_SEC", 900)
GIT_PARTIAL_CLONE = _env_bool("GIT_PARTIAL_CLONE", True)


def clone_or_update(
    clone_url: str,
    full_name: str,
    token: str | None = None,
    default_branch: str = "main",
    shallow_since: str | None = None,
    volume_path: str = "/repos",
) -> str:
    """
    Clone or update a repository on the Modal Volume.
    Returns the repo path.
    """
    repo_path = os.path.join(volume_path, *full_name.split("/"))

    # Build authenticated URL
    auth_url = clone_url
    if token:
        parsed = urlparse(clone_url)
        auth_url = urlunparse(parsed._replace(
            netloc=f"x-access-token:{token}@{parsed.hostname}"
            + (f":{parsed.port}" if parsed.port else "")
        ))

    env = {
        **os.environ,
        "GIT_LFS_SKIP_SMUDGE": "1",
        "GIT_TERMINAL_PROMPT": "0",
    }

    # Shallow-since with safety buffer for boundary parent commits.
    shallow_date = None
    if shallow_since:
        d = datetime.fromisoformat(shallow_since.replace("Z", "+00:00"))
        d -= timedelta(days=GIT_SHALLOW_BUFFER_DAYS)
        shallow_date = d.strftime("%Y-%m-%d")

    git_dir = os.path.join(repo_path, ".git")
    if os.path.isdir(git_dir):
        # Update existing clone
        _run_git(["remote", "set-url", "origin", auth_url], cwd=repo_path, env=env)
        # SECURITY: disable push to prevent any accidental writes to client repos
        _run_git(["remote", "set-url", "--push", "origin", "DISABLED"], cwd=repo_path, env=env)

        # Detect stale shallow clone from a previous DATE_RANGE analysis
        is_shallow = _is_shallow(repo_path)

        fetch_args = ["fetch", "--prune", "--no-tags", "origin"]
        if GIT_PARTIAL_CLONE:
            fetch_args.insert(1, "--filter=blob:none")

        needs_unshallow = is_shallow and not shallow_date
        if needs_unshallow:
            # ALL_TIME / LAST_N on a previously shallow clone — restore full history
            fetch_args.insert(1, "--unshallow")
            logger.info("Unshallowing existing clone for %s — filter fallback will download full blobs if server rejects --filter", full_name)
        elif shallow_date:
            fetch_args.insert(1, f"--shallow-since={shallow_date}")

        try:
            _run_git_with_partial_clone_fallback(
                fetch_args,
                cwd=repo_path,
                env=env,
                timeout=GIT_FETCH_TIMEOUT_SEC,
            )
        except RuntimeError as err:
            # TOCTOU: repo may have been unshallowed between check and fetch
            if needs_unshallow and "does not make sense" in str(err):
                logger.info("Repo already unshallowed for %s, retrying fetch without --unshallow", full_name)
                retry_args = [a for a in fetch_args if a != "--unshallow"]
                _run_git_with_partial_clone_fallback(
                    retry_args,
                    cwd=repo_path,
                    env=env,
                    timeout=GIT_FETCH_TIMEOUT_SEC,
                )
            else:
                raise
        _run_git(["reset", "--hard", f"origin/{default_branch}"], cwd=repo_path, env=env)
    else:
        # Fresh clone
        os.makedirs(os.path.dirname(repo_path), exist_ok=True)
        clone_args = [
            "-c", "core.longpaths=true",
            "-c", "core.symlinks=false",
            "-c", "protocol.version=2",
            "clone", "--single-branch", "--branch", default_branch,
            "--no-tags",
        ]
        if GIT_PARTIAL_CLONE:
            clone_args.append("--filter=blob:none")
        if shallow_date:
            clone_args.append(f"--shallow-since={shallow_date}")
        clone_args.extend([auth_url, repo_path])
        _run_git_with_partial_clone_fallback(
            clone_args,
            env=env,
            timeout=GIT_CLONE_TIMEOUT_SEC,
        )
        # SECURITY: disable push to prevent any accidental writes to client repos
        _run_git(["remote", "set-url", "--push", "origin", "DISABLED"], cwd=repo_path, env=env)

    return repo_path


def extract_commits(
    repo_path: str,
    since: str | None = None,
    until: str | None = None,
    max_count: int | None = None,
    excluded_emails: list[str] | None = None,
) -> list[dict]:
    """
    Extract commits with numstat. Returns list of commit dicts.
    Port of extractCommits() from git-operations.ts.
    """
    log_format = "%H|%ae|%an|%aI|%s"
    args = ["log", f"--format={log_format}", "--numstat", "--no-merges"]

    if max_count:
        args.append(f"--max-count={max_count}")
    if since:
        args.append(f"--since={since}")
    if until:
        args.append(f"--until={until}")

    result = _run_git(args, cwd=repo_path, timeout=GIT_LOG_TIMEOUT_SEC)
    if not result.stdout.strip():
        return []

    return _parse_git_log(result.stdout, excluded_emails)


def get_repo_size_kb(repo_path: str) -> int:
    """
    Get git object database size in KB using `git count-objects -v`.
    Returns 0 on any error.
    """
    try:
        result = _run_git(["count-objects", "-v"], cwd=repo_path, timeout=60)
        pack_match = re.search(r"size-pack:\s*(\d+)", result.stdout)
        loose_match = re.search(r"^size:\s*(\d+)", result.stdout, flags=re.MULTILINE)
        pack = int(pack_match.group(1)) if pack_match else 0
        loose = int(loose_match.group(1)) if loose_match else 0
        return max(0, pack + loose)
    except Exception:
        return 0


def _parse_git_log(raw: str, excluded_emails: list[str] | None = None) -> list[dict]:
    """Parse git log output with numstat. Port of parseGitLog() from git-operations.ts."""
    exclude_set = {e.lower() for e in (excluded_emails or [])}
    commits = []
    lines = raw.split("\n")
    i = 0

    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue

        parts = line.split("|")
        if len(parts) < 5 or not re.match(r"^[0-9a-f]{40}$", parts[0]):
            i += 1
            continue

        sha = parts[0]
        email = parts[1]
        name = parts[2]
        date_str = parts[3]
        message = "|".join(parts[4:])
        i += 1

        # Skip blank line after header
        if i < len(lines) and lines[i].strip() == "":
            i += 1

        # Parse numstat
        additions = 0
        deletions = 0
        files_count = 0

        while i < len(lines):
            num_line = lines[i]
            if num_line.strip() == "":
                i += 1
                break
            match = re.match(r"^(\d+|-)\t(\d+|-)\t(.+)", num_line)
            if not match:
                break
            add = 0 if match.group(1) == "-" else int(match.group(1))
            delete = 0 if match.group(2) == "-" else int(match.group(2))
            additions += add
            deletions += delete
            files_count += 1
            i += 1

        if email.lower() in exclude_set:
            continue

        commits.append({
            "sha": sha,
            "message": message,
            "author_email": email,
            "author_name": name,
            "author_date": date_str,
            "additions": additions,
            "deletions": deletions,
            "files_count": files_count,
        })

    return commits


def _run_git(args: list[str], cwd: str | None = None, env: dict | None = None, timeout: int = 120) -> subprocess.CompletedProcess:
    """Run a git command with error handling."""
    # Disable auto gc to prevent "Auto packing the repository in background"
    # messages from interfering with git operations (stderr noise + lock contention)
    result = subprocess.run(
        ["git", "-c", "gc.auto=0"] + args,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode != 0:
        # Sanitize: remove tokens from error messages
        safe_stderr = re.sub(r"x-access-token:[^@]+@", "x-access-token:***@", result.stderr)
        raise RuntimeError(f"git {args[0]} failed: {safe_stderr.strip()}")
    return result


def _is_shallow(repo_path: str) -> bool:
    """Check if a git repository is a shallow clone."""
    try:
        result = _run_git(
            ["rev-parse", "--is-shallow-repository"],
            cwd=repo_path,
            timeout=10,
        )
        return result.stdout.strip() == "true"
    except Exception:
        return False


def _run_git_with_partial_clone_fallback(
    args: list[str],
    cwd: str | None = None,
    env: dict | None = None,
    timeout: int = 120,
) -> subprocess.CompletedProcess:
    """Run git command and retry once without --filter=blob:none if unsupported."""
    try:
        return _run_git(args, cwd=cwd, env=env, timeout=timeout)
    except RuntimeError as err:
        has_filter = "--filter=blob:none" in args
        if not has_filter or not _looks_like_filter_unsupported(str(err)):
            raise

        fallback_args = [a for a in args if a != "--filter=blob:none"]
        return _run_git(fallback_args, cwd=cwd, env=env, timeout=timeout)


def _looks_like_filter_unsupported(error_text: str) -> bool:
    lower = error_text.lower()
    markers = [
        "unknown option",
        "filter-spec",
        "filtering not recognized by server",
        "server does not support filter",
        "did not send all necessary objects",
        "partial clone",
    ]
    return "filter" in lower and any(marker in lower for marker in markers)
