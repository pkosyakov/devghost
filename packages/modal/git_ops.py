"""
Git operations for Modal worker.
Port of packages/server/src/lib/services/git-operations.ts

Key differences from TypeScript version:
- Clones into Modal Volume (/repos) instead of process.cwd()/clones
- Uses subprocess instead of child_process
- CVE-2024-32002 mitigation: core.symlinks=false in clone args
"""
import os
import re
import subprocess
from datetime import datetime, timedelta
from urllib.parse import urlparse, urlunparse


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

    # Shallow-since with 14-day buffer
    shallow_date = None
    if shallow_since:
        d = datetime.fromisoformat(shallow_since.replace("Z", "+00:00"))
        d -= timedelta(days=14)
        shallow_date = d.strftime("%Y-%m-%d")

    git_dir = os.path.join(repo_path, ".git")
    if os.path.isdir(git_dir):
        # Update existing clone
        _run_git(["remote", "set-url", "origin", auth_url], cwd=repo_path, env=env)
        fetch_args = ["fetch", "--prune", "origin"]
        if shallow_date:
            fetch_args.insert(1, f"--shallow-since={shallow_date}")
        _run_git(fetch_args, cwd=repo_path, env=env, timeout=300)
        _run_git(["reset", "--hard", f"origin/{default_branch}"], cwd=repo_path, env=env)
    else:
        # Fresh clone
        os.makedirs(os.path.dirname(repo_path), exist_ok=True)
        clone_args = [
            "-c", "core.longpaths=true",
            "-c", "core.symlinks=false",
            "clone", "--single-branch", "--branch", default_branch,
        ]
        if shallow_date:
            clone_args.append(f"--shallow-since={shallow_date}")
        clone_args.extend([auth_url, repo_path])
        _run_git(clone_args, env=env, timeout=600)

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

    result = _run_git(args, cwd=repo_path, timeout=120)
    if not result.stdout.strip():
        return []

    return _parse_git_log(result.stdout, excluded_emails)


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
    result = subprocess.run(
        ["git"] + args,
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
