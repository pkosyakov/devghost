"""
Modal worker — main analysis function.

Reads all config from DB by job_id. Writes CommitAnalysis results
and sets LLM_COMPLETE when done. Vercel handles post-processing.
"""
import json
import os
import sys
import threading
import time

import modal

app = modal.App("devghost-worker")

repos_volume = modal.Volume.from_name("devghost-repos", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "fastapi[standard]",  # Required for web trigger app
        "psycopg2-binary",    # Direct Supabase connection
        "requests",           # OpenRouter API calls
        "numpy>=1.24",        # Required by run_v16_pipeline.py
        "scikit-learn>=1.3",  # Required by run_v16_pipeline.py
    )
    .run_commands(
        # CVE-2024-32002 mitigation: prevent symlink-based RCE
        "git config --system protocol.file.allow never",
        "git config --system core.symlinks false",
    )
    .add_local_dir(
        os.path.dirname(__file__),
        remote_path="/app/modal",
    )
    .add_local_dir(
        os.path.join(os.path.dirname(__file__), "..", "server", "scripts", "pipeline"),
        remote_path="/app/pipeline",
    )
)

# Modal imports this entrypoint from /root/worker.py, while helper modules are
# copied to /app/modal via add_local_dir.
MODAL_SRC_DIR = "/app/modal"
if MODAL_SRC_DIR not in sys.path:
    sys.path.insert(0, MODAL_SRC_DIR)

from db import (
    connect_db, acquire_job, load_order, load_github_token,
    load_demo_live_mode,
    get_existing_shas, lookup_cached_commits, copy_cached_to_order,
    save_commit_analyses, update_progress, update_heartbeat,
    set_job_status, set_job_error, increment_total_commits,
    update_llm_usage, account_cached_batch, delete_existing_analyses,
    append_job_event,
)
from git_ops import clone_or_update, extract_commits
from rate_limiter import RateLimiter


HEARTBEAT_INTERVAL_S = 60


def _env_positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        return max(1, int(raw))
    except ValueError:
        return default


DEMO_LIVE_CHUNK_SIZE = _env_positive_int("DEMO_LIVE_CHUNK_SIZE", 10)


class HeartbeatThread(threading.Thread):
    """Background thread that updates heartbeatAt every HEARTBEAT_INTERVAL_S.

    Prevents watchdog from marking long-running jobs as stale during
    large repo processing (clone or LLM can take 10+ minutes per repo).

    Uses a persistent DB connection (created once in __init__) to avoid
    opening 60+ TCP+TLS connections over a 1-hour job. Reconnects on error.
    Connection is closed in stop().
    """

    def __init__(self, job_id: str, interval: int = HEARTBEAT_INTERVAL_S):
        super().__init__(daemon=True)
        self.job_id = job_id
        self.interval = interval
        self._stop_event = threading.Event()
        self._conn = connect_db()  # Persistent connection for heartbeat

    def run(self):
        while not self._stop_event.is_set():
            self._stop_event.wait(self.interval)
            if self._stop_event.is_set():
                break
            try:
                update_heartbeat(self._conn, self.job_id)
            except Exception as err:
                # Connection may be dead -- attempt reconnect
                try:
                    self._conn.close()
                except Exception:
                    pass
                try:
                    self._conn = connect_db()
                    append_job_event(
                        self._conn,
                        self.job_id,
                        "Heartbeat connection recovered after error",
                        level="warn",
                        phase="heartbeat",
                        code="HEARTBEAT_RECONNECTED",
                        payload={"error": str(err)[:300]},
                    )
                except Exception:
                    pass  # Next tick will retry reconnect

    def stop(self):
        self._stop_event.set()
        try:
            self._conn.close()
        except Exception:
            pass


@app.function(
    image=image,
    volumes={"/repos": repos_volume},
    timeout=3600,           # 1 hour max per job
    memory=2048,            # 2 GB RAM
    cpu=2.0,
    secrets=[
        modal.Secret.from_name("devghost-db"),    # DIRECT_URL
        modal.Secret.from_name("devghost-llm"),   # OPENROUTER_API_KEY, LLM_PROVIDER, etc.
        modal.Secret.from_name("devghost-worker-tuning"),  # DEMO_LIVE_CHUNK_SIZE
    ],
)
def run_analysis(job_id: str):
    """
    Main Modal worker. Reads all config from DB by job_id.
    Writes CommitAnalysis results and sets LLM_COMPLETE when done.
    """
    conn = connect_db()

    # 1. Acquire job with lease
    job = acquire_job(conn, job_id)
    if not job:
        return  # Already running, cancelled, or doesn't exist

    append_job_event(
        conn,
        job_id,
        "Modal worker acquired PENDING job",
        phase="worker",
        code="WORKER_ACQUIRED",
        payload={
            "modalCallId": job.get("modalCallId"),
            "lockedBy": job.get("lockedBy"),
        },
    )

    # Start background heartbeat thread (updates every 60s independently
    # of main processing loop -- prevents watchdog false positives on large repos)
    heartbeat = HeartbeatThread(job_id)
    heartbeat.start()
    append_job_event(
        conn,
        job_id,
        "Heartbeat thread started",
        phase="heartbeat",
        code="HEARTBEAT_THREAD_STARTED",
        payload={"intervalSec": HEARTBEAT_INTERVAL_S},
    )

    try:
        order = load_order(conn, job["orderId"])
        repos = json.loads(order["selected_repos"]) if isinstance(order["selected_repos"], str) else order["selected_repos"]
        llm_config = load_llm_config_snapshot(job)
        github_token = load_github_token(conn, order["user_id"])
        scope = build_scope(order)
        excluded_emails = order.get("excluded_developers") or []
        skip_billing = job.get("skipBilling", False)
        force_recalculate = job.get("forceRecalculate", False)
        demo_live_mode = load_demo_live_mode(conn)

        # Setup LLM environment from config snapshot (WITHOUT API key -- read from secret)
        setup_llm_env(llm_config)

        cache_mode = job.get("cacheMode") or job.get("cache_mode") or "model"
        current_llm_model = (
            llm_config.get("openrouter", {}).get("model")
            if llm_config.get("provider") == "openrouter"
            else llm_config.get("ollama", {}).get("model")
        )
        append_job_event(
            conn,
            job_id,
            "Worker context loaded",
            phase="worker",
            code="WORKER_CONTEXT_LOADED",
            payload={
                "orderId": order["id"],
                "repoCount": len(repos),
                "analysisPeriodMode": order.get("analysis_period_mode"),
                "cacheMode": cache_mode,
                "skipBilling": skip_billing,
                "forceRecalculate": force_recalculate,
                "llmProvider": llm_config.get("provider"),
                "llmModel": current_llm_model,
                "demoLiveMode": demo_live_mode,
            },
        )

        # If forceRecalculate -- delete existing CommitAnalysis for this order
        # so intra-order dedup doesn't skip them
        if force_recalculate:
            append_job_event(
                conn,
                job_id,
                "Force recalculate requested; clearing existing analyses",
                phase="worker",
                code="FORCE_RECALCULATE_START",
                payload={"orderId": order["id"]},
            )
            delete_existing_analyses(conn, order["id"])
            append_job_event(
                conn,
                job_id,
                "Existing analyses removed for force recalculate",
                phase="worker",
                code="FORCE_RECALCULATE_DONE",
                payload={"orderId": order["id"]},
            )

        rate_limiter = RateLimiter(max_qps=float(os.environ.get("LLM_MAX_QPS", "5")))
        total_analyzed = 0
        total_cache_hits = 0

        is_last_n = scope.get("is_last_n", False)

        # Phase 1: Clone all repos and extract commits
        # For LAST_N: collect all commits first, then global truncate.
        # For other modes: process each repo immediately after extraction.
        extracted_repos = []

        for repo_idx, repo in enumerate(repos):
            repo_full_name = repo.get("fullName") or repo.get("full_name", "")
            clone_url = repo.get("cloneUrl") or repo.get("clone_url", "")
            language = repo.get("language") or "Unknown"
            is_private = repo.get("isPrivate") or repo.get("is_private", False)
            default_branch = repo.get("defaultBranch") or repo.get("default_branch", "main")
            token = github_token if is_private else None

            append_job_event(
                conn,
                job_id,
                f"Starting repository {repo_idx + 1}/{len(repos)}",
                phase="repo",
                code="REPO_START",
                repo_name=repo_full_name,
                payload={
                    "repoIndex": repo_idx + 1,
                    "repoTotal": len(repos),
                    "language": language,
                    "defaultBranch": default_branch,
                    "private": bool(is_private),
                },
            )

            # a. Clone/update
            update_progress(conn, job_id, step="cloning", repo_name=repo_full_name)
            clone_started = time.time()
            append_job_event(
                conn,
                job_id,
                "Cloning/updating repository",
                phase="clone",
                code="REPO_CLONE_START",
                repo_name=repo_full_name,
            )
            repo_path = clone_or_update(
                clone_url, repo_full_name, token, default_branch,
                shallow_since=scope.get("since"),
                volume_path="/repos",
            )
            append_job_event(
                conn,
                job_id,
                "Repository clone/update completed",
                phase="clone",
                code="REPO_CLONE_DONE",
                repo_name=repo_full_name,
                payload={"durationSec": round(time.time() - clone_started, 2)},
            )

            # b. Extract commits
            update_progress(conn, job_id, step="extracting")
            extract_started = time.time()
            append_job_event(
                conn,
                job_id,
                "Extracting commits from repository",
                phase="extract",
                code="REPO_EXTRACT_START",
                repo_name=repo_full_name,
            )
            commits = extract_commits(
                repo_path,
                since=scope.get("since"),
                until=scope.get("until"),
                max_count=scope.get("max_count"),
                excluded_emails=excluded_emails,
            )
            append_job_event(
                conn,
                job_id,
                "Commit extraction finished",
                phase="extract",
                code="REPO_EXTRACT_DONE",
                repo_name=repo_full_name,
                payload={
                    "commitCount": len(commits),
                    "durationSec": round(time.time() - extract_started, 2),
                },
            )

            if not commits:
                append_job_event(
                    conn,
                    job_id,
                    "Repository has no commits in selected scope",
                    phase="extract",
                    code="REPO_EMPTY_SCOPE",
                    repo_name=repo_full_name,
                )
                continue

            if is_last_n:
                # Defer processing -- collect for global truncation
                extracted_repos.append({
                    "repo_idx": repo_idx, "repo": repo,
                    "repo_full_name": repo_full_name, "repo_path": repo_path,
                    "language": language, "commits": commits,
                })
                append_job_event(
                    conn,
                    job_id,
                    "Repository commits collected for global LAST_N truncation",
                    phase="scope",
                    code="LAST_N_REPO_COLLECTED",
                    repo_name=repo_full_name,
                    payload={"commitCount": len(commits)},
                )
                continue

            # Non-LAST_N: process immediately
            total_analyzed, total_cache_hits = _process_repo_commits(
                conn, job_id, order, repo_full_name, repo_path, language,
                commits, cache_mode, current_llm_model, llm_config,
                rate_limiter, total_analyzed, total_cache_hits,
                repo_idx, len(repos), skip_billing=skip_billing,
                demo_live_mode=demo_live_mode,
            )

        # Phase 1.5 (LAST_N only): Global sort + truncate to top N by date
        if is_last_n and extracted_repos:
            all_commits = []
            for er in extracted_repos:
                for c in er["commits"]:
                    all_commits.append({**c, "_repo_label": er["repo_full_name"]})

            # Sort by author_date descending, take top N
            all_commits.sort(
                key=lambda c: c.get("author_date", ""),
                reverse=True,
            )
            commit_limit = scope.get("commit_limit", len(all_commits))
            top_n = all_commits[:commit_limit]
            allowed_shas = {c["sha"] for c in top_n}
            append_job_event(
                conn,
                job_id,
                "Applied LAST_N global truncation",
                phase="scope",
                code="LAST_N_APPLIED",
                payload={
                    "candidateCommits": len(all_commits),
                    "selectedCommits": len(top_n),
                    "commitLimit": commit_limit,
                },
            )

            # Phase 2: Process only allowed commits per repo
            for er in extracted_repos:
                repo_commits = [c for c in er["commits"] if c["sha"] in allowed_shas]
                if not repo_commits:
                    continue

                total_analyzed, total_cache_hits = _process_repo_commits(
                    conn, job_id, order, er["repo_full_name"], er["repo_path"],
                    er["language"], repo_commits, cache_mode, current_llm_model,
                    llm_config, rate_limiter, total_analyzed, total_cache_hits,
                    er["repo_idx"], len(repos), skip_billing=skip_billing,
                    demo_live_mode=demo_live_mode,
                )

        # (cached commits already accounted per-repo in _process_repo_commits)

        # LLM usage aggregation (stored on job for post-processing)
        update_llm_usage(conn, job_id, total_analyzed)
        append_job_event(
            conn,
            job_id,
            "Aggregated LLM usage counters on job",
            phase="usage",
            code="LLM_USAGE_UPDATED",
            payload={
                "totalAnalyzed": total_analyzed,
                "cacheHits": total_cache_hits,
            },
        )

        # All done
        set_job_status(conn, job_id, "LLM_COMPLETE", progress=95)
        append_job_event(
            conn,
            job_id,
            "Modal worker finished; waiting for post-processing",
            phase="worker",
            code="WORKER_LLM_COMPLETE",
            payload={"progress": 95},
        )
        repos_volume.commit()
        append_job_event(
            conn,
            job_id,
            "Repository volume committed",
            phase="worker",
            code="REPOS_VOLUME_COMMITTED",
        )

    except Exception as e:
        error_msg = f"{type(e).__name__}: {str(e)}"

        # Classify error: retryable vs fatal
        is_fatal = any(keyword in error_msg.lower() for keyword in [
            "authentication", "permission", "invalid token",
            "schema", "column", "relation",  # DB schema issues
        ])
        append_job_event(
            conn,
            job_id,
            "Worker raised exception",
            level="error",
            phase="worker",
            code="WORKER_EXCEPTION",
            payload={"fatal": is_fatal, "error": error_msg[:500]},
        )

        # Try to record error on the job. If the main connection is dead
        # (network blip, Supabase restart), fall back to a fresh connection
        # so watchdog gets error context instead of a silent stale heartbeat.
        try:
            set_job_error(conn, job_id, error_msg, fatal=is_fatal)
        except Exception:
            try:
                fresh_conn = connect_db()
                set_job_error(fresh_conn, job_id, error_msg, fatal=is_fatal)
                fresh_conn.close()
            except Exception:
                pass  # Watchdog will catch this via stale heartbeat

        raise
    finally:
        heartbeat.stop()  # Stop background heartbeat thread
        try:
            conn.close()
        except Exception:
            pass


def _process_repo_commits(
    conn, job_id, order, repo_full_name, repo_path, language,
    commits, cache_mode, current_llm_model, llm_config,
    rate_limiter, total_analyzed, total_cache_hits,
    repo_idx, total_repos, skip_billing=False, demo_live_mode=False,
):
    """Process commits for a single repo: dedup -> cache -> LLM -> save.
    Returns updated (total_analyzed, total_cache_hits) counters.
    """
    repo_started = time.time()
    initial_commit_count = len(commits)
    append_job_event(
        conn,
        job_id,
        "Starting repository processing pipeline",
        phase="repo",
        code="REPO_PROCESS_START",
        repo_name=repo_full_name,
        payload={
            "commitCount": initial_commit_count,
            "cacheMode": cache_mode,
            "demoLiveMode": demo_live_mode,
        },
    )

    # Intra-order dedup
    existing_shas = get_existing_shas(conn, order["id"], repo_full_name)
    commits = [c for c in commits if c["sha"] not in existing_shas]
    append_job_event(
        conn,
        job_id,
        "Intra-order deduplication complete",
        phase="dedup",
        code="REPO_DEDUP_DONE",
        repo_name=repo_full_name,
        payload={
            "existingCount": len(existing_shas),
            "remainingCount": len(commits),
        },
    )

    if not commits:
        append_job_event(
            conn,
            job_id,
            "Repository skipped after deduplication (all commits already analyzed)",
            phase="dedup",
            code="REPO_SKIP_DEDUP",
            repo_name=repo_full_name,
            payload={"durationSec": round(time.time() - repo_started, 2)},
        )
        return total_analyzed, total_cache_hits

    # Cross-order cache lookup
    all_shas = [c["sha"] for c in commits]
    cached_rows, cached_sha_set = lookup_cached_commits(
        conn, all_shas, order["id"], order["user_id"],
        repo_full_name, cache_mode, current_llm_model,
    )
    append_job_event(
        conn,
        job_id,
        "Cross-order cache lookup complete",
        phase="cache",
        code="CACHE_LOOKUP_DONE",
        repo_name=repo_full_name,
        payload={
            "requestedCount": len(all_shas),
            "cacheHitCount": len(cached_rows),
            "cacheMissCount": len(all_shas) - len(cached_rows),
            "cacheMode": cache_mode,
            "llmModel": current_llm_model,
        },
    )

    if cached_rows:
        copy_cached_to_order(conn, cached_rows, order["id"], repo_full_name)
        # Account cached commits immediately per-repo (crash-safe).
        # If the job crashes after this repo but before the next,
        # creditsReleased is already updated -- no double-charge on retry.
        # Skip for ADMINs / billing-disabled (no reservation was made).
        if not skip_billing:
            account_cached_batch(conn, job_id, len(cached_rows))
        total_analyzed += len(cached_rows)
        total_cache_hits += len(cached_rows)
        append_job_event(
            conn,
            job_id,
            "Cache-hit analyses copied to order",
            phase="cache",
            code="CACHE_REUSED",
            repo_name=repo_full_name,
            payload={"cacheHitCount": len(cached_rows)},
        )

    commits = [c for c in commits if c["sha"] not in cached_sha_set]
    increment_total_commits(conn, job_id, len(all_shas))
    append_job_event(
        conn,
        job_id,
        "Updated total commit counter for repository",
        phase="repo",
        code="TOTAL_COMMITS_INCREMENTED",
        repo_name=repo_full_name,
        payload={"added": len(all_shas), "remainingForLlm": len(commits)},
    )

    if not commits:
        append_job_event(
            conn,
            job_id,
            "Repository fully satisfied by cache (no LLM calls needed)",
            phase="cache",
            code="REPO_FULLY_CACHED",
            repo_name=repo_full_name,
            payload={"durationSec": round(time.time() - repo_started, 2)},
        )
        return total_analyzed, total_cache_hits

    # Process via evaluate_chunk
    update_progress(conn, job_id, step="analyzing")
    llm_started = time.time()
    append_job_event(
        conn,
        job_id,
        "Starting LLM evaluation for repository commits",
        phase="llm",
        code="LLM_EVAL_START",
        repo_name=repo_full_name,
        payload={"commitCount": len(commits), "language": language},
    )
    chunk_size = DEMO_LIVE_CHUNK_SIZE if demo_live_mode else len(commits)
    chunk_size = max(1, min(chunk_size, len(commits)))
    total_chunks = (len(commits) + chunk_size - 1) // chunk_size
    append_job_event(
        conn,
        job_id,
        "LLM chunking plan prepared",
        phase="llm",
        code="LLM_CHUNK_PLAN",
        repo_name=repo_full_name,
        payload={
            "demoLiveMode": demo_live_mode,
            "chunkSize": chunk_size,
            "chunkCount": total_chunks,
        },
    )

    method_counts = {}
    error_samples = []
    saved_count = 0

    for chunk_index, start in enumerate(range(0, len(commits), chunk_size), start=1):
        chunk_commits = commits[start:start + chunk_size]
        chunk_started = time.time()

        if total_chunks > 1:
            append_job_event(
                conn,
                job_id,
                "Processing LLM chunk",
                phase="llm",
                code="LLM_CHUNK_START",
                repo_name=repo_full_name,
                payload={
                    "chunkIndex": chunk_index,
                    "chunkTotal": total_chunks,
                    "chunkCommitCount": len(chunk_commits),
                    "processedBeforeChunk": start,
                    "repoCommitCount": len(commits),
                },
            )

        chunk_results = evaluate_chunk(
            chunk_commits, repo_path, language, llm_config, rate_limiter,
        )

        for result in chunk_results:
            method = result.get("method", "unknown")
            method_counts[method] = method_counts.get(method, 0) + 1
            if method == "error" or result.get("error"):
                error_samples.append({
                    "sha": result.get("sha"),
                    "error": str(result.get("error") or result.get("type") or "unknown")[:200],
                })

        analyses = [
            map_to_commit_analysis(r, chunk_commits, order["id"], repo_full_name, current_llm_model)
            for r in chunk_results
        ]
        if analyses:
            save_commit_analyses(conn, analyses)
            saved_count += len(analyses)
            total_analyzed += len(analyses)

        processed_in_repo = min(start + len(chunk_commits), len(commits))
        progress_pct = int(
            ((repo_idx + (processed_in_repo / len(commits))) / total_repos) * 90
        )
        progress_pct = max(1, min(progress_pct, 90))
        update_progress(conn, job_id, progress=progress_pct, processed=total_analyzed)

        if total_chunks > 1:
            append_job_event(
                conn,
                job_id,
                "LLM chunk completed",
                phase="llm",
                code="LLM_CHUNK_DONE",
                repo_name=repo_full_name,
                payload={
                    "chunkIndex": chunk_index,
                    "chunkTotal": total_chunks,
                    "chunkResultCount": len(chunk_results),
                    "processedInRepo": processed_in_repo,
                    "repoCommitCount": len(commits),
                    "totalAnalyzed": total_analyzed,
                    "durationSec": round(time.time() - chunk_started, 2),
                },
            )

    append_job_event(
        conn,
        job_id,
        "LLM evaluation finished",
        phase="llm",
        code="LLM_EVAL_DONE",
        repo_name=repo_full_name,
        payload={
            "resultCount": saved_count,
            "durationSec": round(time.time() - llm_started, 2),
            "methodCounts": method_counts,
            "errorCount": len(error_samples),
            "errorSamples": error_samples[:5],
            "chunkCount": total_chunks,
            "chunkSize": chunk_size,
        },
    )

    append_job_event(
        conn,
        job_id,
        "Saved commit analyses for repository",
        phase="repo",
        code="ANALYSES_SAVED",
        repo_name=repo_full_name,
        payload={
            "savedCount": saved_count,
            "totalAnalyzed": total_analyzed,
        },
    )

    # Update progress (heartbeat is handled by background thread)
    progress_pct = int((repo_idx + 1) / total_repos * 90)
    update_progress(conn, job_id, progress=progress_pct, processed=total_analyzed)
    append_job_event(
        conn,
        job_id,
        "Repository processing completed",
        phase="repo",
        code="REPO_PROCESS_DONE",
        repo_name=repo_full_name,
        payload={
            "progress": progress_pct,
            "totalAnalyzed": total_analyzed,
            "durationSec": round(time.time() - repo_started, 2),
        },
    )

    return total_analyzed, total_cache_hits


def evaluate_chunk(commits, repo_path, language, llm_config, rate_limiter):
    """
    Process a chunk of commits through the LLM pipeline.

    This function is isolated as the future boundary for fan-out
    via Modal .map() when migrating to Approach C.
    """
    import sys
    sys.path.insert(0, "/app/pipeline")
    from run_devghost_pipeline import process_commits

    # Inject rate limiter into the pipeline's LLM call path.
    if rate_limiter and os.environ.get("LLM_PROVIDER") == "openrouter":
        _install_rate_limiter(rate_limiter)

    # process_commits expects list of dicts with sha, message, author_email, author_name
    commit_dicts = [
        {
            "sha": c["sha"],
            "message": c["message"],
            "author_email": c["author_email"],
            "author_name": c["author_name"],
        }
        for c in commits
    ]

    result = process_commits(repo_path, language, commit_dicts)
    return result.get("commits", [])


_rl_installed = False  # Module-level guard to prevent monkey-patch stacking


def _install_rate_limiter(rate_limiter):
    """Monkey-patch requests.post to add rate limiting for OpenRouter calls.

    Idempotent: only patches once per process. Without the guard, each
    evaluate_chunk() call would wrap requests.post again, creating a
    growing call chain: rl(rl(rl(original_post))).
    """
    global _rl_installed
    if _rl_installed:
        return

    import requests
    _original_post = requests.post

    def rate_limited_post(*args, **kwargs):
        url = args[0] if args else kwargs.get("url", "")
        if "openrouter.ai" in str(url):
            rate_limiter.wait()
        return _original_post(*args, **kwargs)

    requests.post = rate_limited_post
    _rl_installed = True


def load_llm_config_snapshot(job: dict) -> dict:
    """Load LLM config from job snapshot. API key comes from Modal Secret, not DB."""
    snapshot = job.get("llmConfigSnapshot") or job.get("llm_config_snapshot") or {}
    if isinstance(snapshot, str):
        snapshot = json.loads(snapshot)
    return snapshot


def setup_llm_env(llm_config):
    """Set environment variables from llm_config snapshot for the Python pipeline.

    SECURITY: API key is NOT in the config snapshot (stripped before DB write).
    It's read from OPENROUTER_API_KEY env var set by Modal Secret 'devghost-llm'.
    """
    os.environ["LLM_PROVIDER"] = llm_config.get("provider", "openrouter")

    ollama = llm_config.get("ollama", {})
    os.environ["OLLAMA_URL"] = ollama.get("url", "http://localhost:11434")
    os.environ["OLLAMA_MODEL"] = ollama.get("model", "qwen2.5-coder:32b")

    openrouter = llm_config.get("openrouter", {})
    # OPENROUTER_API_KEY already set by Modal Secret -- do NOT override from snapshot
    os.environ["OPENROUTER_MODEL"] = openrouter.get("model", "qwen/qwen-2.5-coder-32b-instruct")

    # providerOrder/providerIgnore may be list (from TS LlmConfig) or string — normalize to CSV
    provider_order = openrouter.get("providerOrder", "Chutes")
    if isinstance(provider_order, list):
        provider_order = ",".join(provider_order)
    os.environ["OPENROUTER_PROVIDER_ORDER"] = provider_order

    provider_ignore = openrouter.get("providerIgnore", "Cloudflare")
    if isinstance(provider_ignore, list):
        provider_ignore = ",".join(provider_ignore)
    os.environ["OPENROUTER_PROVIDER_IGNORE"] = provider_ignore

    os.environ["OPENROUTER_ALLOW_FALLBACKS"] = str(openrouter.get("allowFallbacks", True)).lower()
    os.environ["OPENROUTER_REQUIRE_PARAMETERS"] = str(openrouter.get("requireParameters", True)).lower()


def build_scope(order):
    """Build commit scope filters from order config.

    For LAST_N_COMMITS: returns max_count=limit*2 per-repo (generous buffer).
    The actual global truncation to top-N happens in run_analysis() after
    extracting commits from ALL repos.
    """
    mode = order.get("analysis_period_mode", "ALL_TIME")

    if mode == "LAST_N_COMMITS" and order.get("analysis_commit_limit"):
        return {
            "max_count": order["analysis_commit_limit"] * 2,
            "is_last_n": True,
            "commit_limit": order["analysis_commit_limit"],
        }

    if mode == "DATE_RANGE" and order.get("analysis_start_date") and order.get("analysis_end_date"):
        return {
            "since": order["analysis_start_date"].isoformat() if hasattr(order["analysis_start_date"], 'isoformat') else order["analysis_start_date"],
            "until": order["analysis_end_date"].isoformat() if hasattr(order["analysis_end_date"], 'isoformat') else order["analysis_end_date"],
        }

    if mode == "SELECTED_YEARS" and order.get("analysis_years"):
        years = order["analysis_years"]
        min_year = min(years)
        max_year = max(years)
        return {
            "since": f"{min_year}-01-01T00:00:00Z",
            "until": f"{max_year + 1}-01-01T00:00:00Z",
        }

    return {}  # ALL_TIME -- no filters


def map_to_commit_analysis(result, commits, order_id, repo_full_name, llm_model):
    """Map pipeline result to CommitAnalysis row dict."""
    commit = next((c for c in commits if c["sha"] == result["sha"]), None)
    method = result.get("method", "")

    confidence = 0.8
    if method.startswith("FD"):
        confidence = 0.6
    elif method == "error":
        confidence = 0.1
    elif method == "root_commit_skip":
        confidence = 0.5

    model_for_row = None if (
        method.startswith("FD") or method == "root_commit_skip" or method == "error"
    ) else llm_model

    analysis = result.get("analysis") or {}

    return {
        "order_id": order_id,
        "commit_hash": result["sha"],
        "commit_message": commit["message"] if commit else "",
        "author_email": commit["author_email"] if commit else "",
        "author_name": commit["author_name"] if commit else "",
        "author_date": commit["author_date"] if commit else None,
        "repository": repo_full_name,
        "additions": commit.get("additions", 0) if commit else 0,
        "deletions": commit.get("deletions", 0) if commit else 0,
        "files_count": commit.get("files_count", 0) if commit else 0,
        "effort_hours": result.get("estimated_hours", 0),
        "category": analysis.get("change_type"),
        "complexity": analysis.get("cognitive_complexity"),
        "confidence": confidence,
        "method": method,
        "llm_model": model_for_row,
    }
