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
from datetime import datetime, timedelta, timezone

import modal
import requests

app = modal.App("devghost-worker")

repos_volume = modal.Volume.from_name("devghost-repos", create_if_missing=True)
pipeline_cache_volume = modal.Volume.from_name("devghost-pipeline-cache", create_if_missing=True)

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
    load_demo_live_settings,
    get_existing_shas, get_base_commit_shas, lookup_cached_commits, copy_cached_to_order,
    save_commit_analyses, update_progress, update_heartbeat,
    set_job_status, set_job_error, increment_total_commits,
    update_llm_usage, account_cached_batch, delete_existing_analyses, delete_analyses_since,
    delete_benchmark_analyses,
    append_job_event,
)
from git_ops import clone_or_update, extract_commits, get_repo_size_kb
from rate_limiter import RateLimiter


HEARTBEAT_INTERVAL_S = 60


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


DEMO_LIVE_CHUNK_SIZE_ENV_FALLBACK = _env_positive_int("DEMO_LIVE_CHUNK_SIZE", 10)
LAST_N_SHALLOW_INITIAL_DAYS = _env_positive_int("LAST_N_SHALLOW_INITIAL_DAYS", 30)
LAST_N_SHALLOW_MAX_DAYS = _env_positive_int("LAST_N_SHALLOW_MAX_DAYS", 3650)
LAST_N_SHALLOW_GROWTH_FACTOR = max(2, _env_positive_int("LAST_N_SHALLOW_GROWTH_FACTOR", 2))
REPO_VOLUME_CHECKPOINTS = _env_bool("REPO_VOLUME_CHECKPOINTS", True)
COMMIT_TIMELINE_EVENTS = _env_bool("COMMIT_TIMELINE_EVENTS", True)
PIPELINE_CACHE_DIR = (os.environ.get("PIPELINE_CACHE_DIR") or "/cache/pipeline").strip()
PIPELINE_CACHE_NAMESPACE = (os.environ.get("PIPELINE_CACHE_NAMESPACE") or "prod").strip()
WATCHDOG_TRIGGER_URL = (os.environ.get("WATCHDOG_TRIGGER_URL") or "").strip()
WATCHDOG_TRIGGER_TOKEN = (os.environ.get("WATCHDOG_TRIGGER_TOKEN") or "").strip()
WATCHDOG_TRIGGER_TIMEOUT_SEC = _env_positive_int("WATCHDOG_TRIGGER_TIMEOUT_SEC", 8)


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
    volumes={"/repos": repos_volume, "/cache": pipeline_cache_volume},
    timeout=3600,           # 1 hour max per job
    memory=2048,            # 2 GB RAM
    cpu=2.0,
    secrets=[
        modal.Secret.from_name("devghost-db"),    # DIRECT_URL
        modal.Secret.from_name("devghost-llm"),   # OPENROUTER_API_KEY, LLM_PROVIDER, etc.
        modal.Secret.from_name("devghost-worker-tuning"),  # env fallbacks (DEMO_LIVE_CHUNK_SIZE, etc.)
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
    order_id = job.get("orderId") or job.get("order_id")
    job_started_at = job.get("startedAt") or job.get("started_at")
    is_benchmark = job.get("type") == "benchmark"

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
        order_id = order["id"]
        repos = json.loads(order["selected_repos"]) if isinstance(order["selected_repos"], str) else order["selected_repos"]
        llm_config = load_llm_config_snapshot(job)
        llm_config_error = validate_llm_config_snapshot(llm_config)
        if llm_config_error:
            fatal_message = f"FATAL_LLM: {llm_config_error}"
            append_job_event(
                conn,
                job_id,
                "LLM config snapshot is missing or invalid",
                level="error",
                phase="worker",
                code="LLM_SNAPSHOT_INVALID",
                payload={"error": fatal_message},
            )
            set_job_error(conn, job_id, fatal_message, fatal=True)
            return

        github_token = load_github_token(conn, order["user_id"])
        scope = build_scope(order)
        excluded_emails = order.get("excluded_developers") or []
        skip_billing = True if is_benchmark else job.get("skipBilling", False)
        force_recalculate = False if is_benchmark else job.get("forceRecalculate", False)
        if is_benchmark:
            demo_live_mode, demo_live_chunk_size = False, 1
        else:
            demo_live_mode, demo_live_chunk_size = load_demo_live_settings(conn)
        demo_live_chunk_size = max(1, min(200, int(demo_live_chunk_size)))

        # Setup LLM environment from config snapshot (WITHOUT API key -- read from secret)
        setup_llm_env(llm_config)

        cache_mode = "off" if is_benchmark else (job.get("cacheMode") or job.get("cache_mode") or "model")
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
                "demoLiveChunkSize": demo_live_chunk_size,
                "lastNAdaptive": {
                    "initialDays": LAST_N_SHALLOW_INITIAL_DAYS,
                    "maxDays": LAST_N_SHALLOW_MAX_DAYS,
                    "growthFactor": LAST_N_SHALLOW_GROWTH_FACTOR,
                },
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
            update_progress(conn, job_id, step="cloning",
                            repo_name=None if is_benchmark else repo_full_name)
            clone_started = time.time()
            append_job_event(
                conn,
                job_id,
                "Cloning/updating repository",
                phase="clone",
                code="REPO_CLONE_START",
                repo_name=repo_full_name,
            )
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

            if is_last_n:
                repo_path, commits, adaptive_meta = _extract_last_n_commits_with_adaptive_shallow(
                    conn=conn,
                    job_id=job_id,
                    repo_full_name=repo_full_name,
                    clone_url=clone_url,
                    token=token,
                    default_branch=default_branch,
                    target_count=max(1, int(scope.get("max_count") or 1)),
                    excluded_emails=excluded_emails,
                )
                clone_size_kb = get_repo_size_kb(repo_path)
                append_job_event(
                    conn,
                    job_id,
                    "Repository clone/update completed",
                    phase="clone",
                    code="REPO_CLONE_DONE",
                    repo_name=repo_full_name,
                    payload={
                        "durationSec": round(time.time() - clone_started, 2),
                        "cloneSizeKb": clone_size_kb,
                        "adaptiveShallow": adaptive_meta,
                    },
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
                        "adaptiveShallow": adaptive_meta,
                    },
                )
            else:
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
                    payload={
                        "durationSec": round(time.time() - clone_started, 2),
                        "cloneSizeKb": get_repo_size_kb(repo_path),
                    },
                )

                years = scope.get("years")
                if years:
                    commits = _extract_commits_for_selected_years(
                        repo_path=repo_path,
                        years=years,
                        excluded_emails=excluded_emails,
                    )
                else:
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
                        **({"selectedYears": years} if years else {}),
                    },
                )

            _commit_repos_volume_checkpoint(
                conn=conn,
                job_id=job_id,
                reason="repo_cloned",
                repo_name=repo_full_name,
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
                demo_live_chunk_size=demo_live_chunk_size,
                is_benchmark=is_benchmark,
                benchmark_job_id=job_id if is_benchmark else None,
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
                    demo_live_chunk_size=demo_live_chunk_size,
                    is_benchmark=is_benchmark,
                    benchmark_job_id=job_id if is_benchmark else None,
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
        if is_benchmark:
            # Benchmarks complete directly — no post-processing (metrics, DailyEffort)
            set_job_status(conn, job_id, "COMPLETED", progress=100)
            append_job_event(
                conn,
                job_id,
                "Benchmark completed",
                phase="worker",
                code="BENCHMARK_COMPLETED",
                payload={"progress": 100, "totalAnalyzed": total_analyzed},
            )
        else:
            set_job_status(conn, job_id, "LLM_COMPLETE", progress=95)
            append_job_event(
                conn,
                job_id,
                "Modal worker finished; waiting for post-processing",
                phase="worker",
                code="WORKER_LLM_COMPLETE",
                payload={"progress": 95},
            )
            _try_trigger_watchdog_post_processing(conn, job_id)
        _commit_repos_volume_checkpoint(
            conn=conn,
            job_id=job_id,
            reason="job_complete",
        )

    except Exception as e:
        error_msg = f"{type(e).__name__}: {str(e)}"
        error_lower = error_msg.lower()

        # Classify error: retryable vs fatal
        is_fatal = any(keyword in error_lower for keyword in [
            "fatal_llm:",
            "openrouter",
            "llm_snapshot_invalid",
            "missing llmconfigsnapshot",
            "all providers have been ignored",
            "authentication", "permission", "invalid token",
            "schema", "column", "relation",  # DB schema issues
        ])

        rollback_deleted = 0
        if order_id:
            try:
                if is_benchmark:
                    rollback_deleted = delete_benchmark_analyses(conn, order_id, job_id)
                elif job_started_at:
                    rollback_deleted = delete_analyses_since(conn, order_id, job_started_at)
                if rollback_deleted > 0:
                    append_job_event(
                        conn,
                        job_id,
                        "Rolled back partial analyses from failed run",
                        level="warn",
                        phase="worker",
                        code="ANALYSES_ROLLBACK_OK",
                        payload={"deletedCount": rollback_deleted, "benchmark": is_benchmark},
                    )
            except Exception as rollback_err:
                try:
                    append_job_event(
                        conn,
                        job_id,
                        "Rollback of partial analyses failed",
                        level="warn",
                        phase="worker",
                        code="ANALYSES_ROLLBACK_FAILED",
                        payload={"error": str(rollback_err)[:300]},
                    )
                except Exception:
                    pass

        append_job_event(
            conn,
            job_id,
            "Worker raised exception",
            level="error",
            phase="worker",
            code="WORKER_EXCEPTION",
            payload={
                "fatal": is_fatal,
                "error": error_msg[:500],
                "rollbackDeleted": rollback_deleted,
            },
        )

        # Try to record error on the job. If the main connection is dead
        # (network blip, Supabase restart), fall back to a fresh connection
        # so watchdog gets error context instead of a silent stale heartbeat.
        try:
            set_job_error(conn, job_id, error_msg, fatal=is_fatal,
                          skip_order_update=is_benchmark)
        except Exception:
            try:
                fresh_conn = connect_db()
                set_job_error(fresh_conn, job_id, error_msg, fatal=is_fatal,
                              skip_order_update=is_benchmark)
                fresh_conn.close()
            except Exception:
                pass  # Watchdog will catch this via stale heartbeat

        _commit_repos_volume_checkpoint(
            conn=conn,
            job_id=job_id,
            reason="job_failed",
        )

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
    demo_live_chunk_size=DEMO_LIVE_CHUNK_SIZE_ENV_FALLBACK,
    is_benchmark=False, benchmark_job_id=None,
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
            "demoLiveChunkSize": demo_live_chunk_size,
        },
    )

    # Intra-order dedup / benchmark commit pinning
    if is_benchmark:
        # Pin to base analysis set — only analyze commits the original analyzed
        base_shas = get_base_commit_shas(conn, order["id"], repo_full_name)
        commits = [c for c in commits if c["sha"] in base_shas]
        append_job_event(
            conn,
            job_id,
            "Benchmark commit pinning complete",
            phase="dedup",
            code="BENCHMARK_PIN_DONE",
            repo_name=repo_full_name,
            payload={
                "baseShaCount": len(base_shas),
                "pinnedCount": len(commits),
            },
        )
    else:
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
    chunk_size = demo_live_chunk_size if demo_live_mode else len(commits)
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
            "chunkSource": "db" if demo_live_mode else "full-batch",
        },
    )

    method_counts = {}
    error_samples = []
    saved_count = 0
    commit_lookup = {c["sha"]: c for c in commits}

    for chunk_index, start in enumerate(range(0, len(commits), chunk_size), start=1):
        chunk_commits = commits[start:start + chunk_size]
        chunk_started = time.time()
        chunk_sha = chunk_commits[0]["sha"] if len(chunk_commits) == 1 else None

        _touch_chunk_heartbeat(
            conn=conn,
            job_id=job_id,
            repo_name=repo_full_name,
            chunk_index=chunk_index,
            chunk_total=total_chunks,
            stage="before_chunk",
        )

        if total_chunks > 1:
            append_job_event(
                conn,
                job_id,
                "Processing LLM chunk",
                phase="llm",
                code="LLM_CHUNK_START",
                repo_name=repo_full_name,
                sha=chunk_sha,
                payload={
                    "chunkIndex": chunk_index,
                    "chunkTotal": total_chunks,
                    "chunkCommitCount": len(chunk_commits),
                    "processedBeforeChunk": start,
                    "repoCommitCount": len(commits),
                    **({"currentSha": chunk_sha} if chunk_sha else {}),
                },
            )

        chunk_results = evaluate_chunk(
            chunk_commits, repo_path, language, llm_config, rate_limiter,
        )

        _touch_chunk_heartbeat(
            conn=conn,
            job_id=job_id,
            repo_name=repo_full_name,
            chunk_index=chunk_index,
            chunk_total=total_chunks,
            stage="after_chunk",
        )

        for result in chunk_results:
            method = result.get("method", "unknown")
            method_counts[method] = method_counts.get(method, 0) + 1
            if method == "error" or result.get("error"):
                error_samples.append({
                    "sha": result.get("sha"),
                    "error": str(result.get("error") or result.get("type") or "unknown")[:200],
                })
            # Track file-level LLM cache hits for diagnostics
            for lc in (result.get("llm_calls") or []):
                if lc.get("cache_hit"):
                    method_counts["_file_cache_hit"] = method_counts.get("_file_cache_hit", 0) + 1
                else:
                    method_counts["_file_cache_miss"] = method_counts.get("_file_cache_miss", 0) + 1

        analyses = [
            map_to_commit_analysis(r, chunk_commits, order["id"], repo_full_name, current_llm_model)
            for r in chunk_results
        ]
        if analyses:
            save_commit_analyses(conn, analyses, job_id=benchmark_job_id)
            saved_count += len(analyses)
            total_analyzed += len(analyses)

        if COMMIT_TIMELINE_EVENTS:
            _emit_commit_live_results(
                conn=conn,
                job_id=job_id,
                repo_full_name=repo_full_name,
                commit_lookup=commit_lookup,
                chunk_results=chunk_results,
            )

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

    # Update progress (heartbeat is handled by background thread + chunk touches)
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


def _touch_chunk_heartbeat(
    conn,
    job_id: str,
    repo_name: str,
    chunk_index: int,
    chunk_total: int,
    stage: str,
) -> None:
    """Best-effort explicit lease refresh around chunk boundaries."""
    try:
        update_heartbeat(conn, job_id)
    except Exception as err:
        try:
            append_job_event(
                conn,
                job_id,
                "Chunk-boundary heartbeat refresh failed",
                level="warn",
                phase="heartbeat",
                code="HEARTBEAT_TOUCH_FAILED",
                repo_name=repo_name,
                payload={
                    "stage": stage,
                    "chunkIndex": chunk_index,
                    "chunkTotal": chunk_total,
                    "error": str(err)[:300],
                },
            )
        except Exception:
            pass


def _to_float_or_none(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int_or_none(value):
    value_f = _to_float_or_none(value)
    if value_f is None:
        return None
    return int(value_f)


def _confidence_from_method(method: str) -> float:
    confidence = 0.8
    if method.startswith("FD"):
        confidence = 0.6
    elif method == "error":
        confidence = 0.1
    elif method == "root_commit_skip":
        confidence = 0.5
    return confidence


def _try_trigger_watchdog_post_processing(conn, job_id: str) -> None:
    """Best-effort nudge: trigger watchdog immediately after LLM_COMPLETE.

    This removes the usual wait for the next cron tick. If disabled/misconfigured,
    cron-based watchdog still processes the job later.
    """
    if not WATCHDOG_TRIGGER_URL:
        append_job_event(
            conn,
            job_id,
            "Watchdog trigger URL is not configured; waiting for cron",
            phase="worker",
            code="POST_WATCHDOG_TRIGGER_SKIPPED",
            payload={"reason": "missing_url"},
        )
        return

    if not WATCHDOG_TRIGGER_TOKEN:
        append_job_event(
            conn,
            job_id,
            "Watchdog trigger token is not configured; waiting for cron",
            level="warn",
            phase="worker",
            code="POST_WATCHDOG_TRIGGER_SKIPPED",
            payload={"reason": "missing_token"},
        )
        return

    headers = {"Authorization": f"Bearer {WATCHDOG_TRIGGER_TOKEN}"}
    try:
        response = requests.get(
            WATCHDOG_TRIGGER_URL,
            headers=headers,
            timeout=WATCHDOG_TRIGGER_TIMEOUT_SEC,
        )
        if response.ok:
            payload = {"httpStatus": response.status_code}
            try:
                body = response.json()
                if isinstance(body, dict):
                    if "processed" in body:
                        payload["processed"] = body["processed"]
                    if "partial" in body:
                        payload["partial"] = body["partial"]
            except Exception:
                pass
            append_job_event(
                conn,
                job_id,
                "Triggered watchdog post-processing immediately",
                phase="worker",
                code="POST_WATCHDOG_TRIGGER_OK",
                payload=payload,
            )
        else:
            append_job_event(
                conn,
                job_id,
                "Watchdog trigger call failed",
                level="warn",
                phase="worker",
                code="POST_WATCHDOG_TRIGGER_HTTP_FAIL",
                payload={"httpStatus": response.status_code},
            )
    except Exception as err:
        append_job_event(
            conn,
            job_id,
            "Watchdog trigger network error",
            level="warn",
            phase="worker",
            code="POST_WATCHDOG_TRIGGER_NETWORK_FAIL",
            payload={"error": str(err)[:300]},
        )


def _emit_commit_live_results(
    conn,
    job_id: str,
    repo_full_name: str,
    commit_lookup: dict[str, dict],
    chunk_results: list[dict],
) -> None:
    """Emit per-commit live telemetry events for progress timeline visibility."""
    fd_child_cap = 120

    for result in chunk_results:
        sha = str(result.get("sha") or "")
        if not sha:
            continue

        commit = commit_lookup.get(sha) or {}
        analysis = result.get("analysis") or {}
        method = str(result.get("method") or "unknown")
        error_text = result.get("error")
        level = "warn" if (method == "error" or error_text) else "info"
        llm_calls = result.get("llm_calls") if isinstance(result.get("llm_calls"), list) else []

        estimated_hours = _to_float_or_none(result.get("estimated_hours"))
        confidence = _confidence_from_method(method)
        commit_started_at_ms = _to_int_or_none(result.get("started_at_ms") or result.get("startedAtMs"))
        commit_finished_at_ms = _to_int_or_none(result.get("finished_at_ms") or result.get("finishedAtMs"))
        commit_wall_time_ms = _to_float_or_none(result.get("wall_time_ms") or result.get("wallTimeMs"))
        llm_duration_ms = sum(
            (_to_float_or_none(call.get("total_duration_ms")) or 0.0)
            for call in llm_calls
            if isinstance(call, dict)
        )
        duration_ms = llm_duration_ms if llm_duration_ms > 0 else commit_wall_time_ms

        payload = {
            "method": method,
            "estimatedHours": round(estimated_hours, 2) if estimated_hours is not None else None,
            "category": analysis.get("change_type"),
            "complexity": analysis.get("cognitive_complexity") or analysis.get("complexity"),
            "confidence": round(confidence, 3),
            "type": result.get("type"),
            "subject": str(commit.get("message") or "")[:140] or None,
            "llmCallCount": len(llm_calls),
            "durationMs": round(duration_ms, 1) if duration_ms is not None else None,
        }
        if commit_started_at_ms is not None:
            payload["commitStartedAtMs"] = commit_started_at_ms
        if commit_finished_at_ms is not None:
            payload["commitFinishedAtMs"] = commit_finished_at_ms
        if commit_wall_time_ms is not None:
            payload["commitWallTimeMs"] = round(commit_wall_time_ms, 1)
        if error_text:
            payload["error"] = str(error_text)[:240]

        fd_children = []
        fd_details = result.get("fd_details") if isinstance(result.get("fd_details"), dict) else {}
        raw_file_timeline = fd_details.get("file_timeline") if isinstance(fd_details, dict) else None

        if isinstance(raw_file_timeline, list):
            for idx, child in enumerate(raw_file_timeline):
                if not isinstance(child, dict):
                    continue
                child_start = _to_int_or_none(child.get("started_at_ms") or child.get("startedAtMs"))
                child_finish = _to_int_or_none(child.get("finished_at_ms") or child.get("finishedAtMs"))
                child_wall = _to_float_or_none(child.get("wall_time_ms") or child.get("wallTimeMs"))
                fd_children.append({
                    "id": f"file-{idx + 1}",
                    "label": str(child.get("file") or f"file-{idx + 1}")[:180],
                    "startedAtMs": child_start,
                    "finishedAtMs": child_finish,
                    "wallTimeMs": round(child_wall, 1) if child_wall is not None else None,
                    "estimatedHours": _to_float_or_none(child.get("estimated_hours") or child.get("estimatedHours")),
                    "tags": child.get("tags") if isinstance(child.get("tags"), list) else None,
                })

        elif method.startswith("FD"):
            for idx, call in enumerate(llm_calls):
                if not isinstance(call, dict):
                    continue
                child_start = _to_int_or_none(call.get("started_at_ms") or call.get("startedAtMs"))
                child_finish = _to_int_or_none(call.get("finished_at_ms") or call.get("finishedAtMs"))
                child_wall = _to_float_or_none(call.get("wall_time_ms") or call.get("wallTimeMs"))
                child_duration = _to_float_or_none(call.get("total_duration_ms"))
                fd_children.append({
                    "id": f"llm-{idx + 1}",
                    "label": str(call.get("step") or "fd"),
                    "startedAtMs": child_start,
                    "finishedAtMs": child_finish,
                    "wallTimeMs": round(child_wall, 1) if child_wall is not None else None,
                    "durationMs": round(child_duration, 1) if child_duration is not None else None,
                    "cacheHit": bool(call.get("cache_hit")),
                    "provider": str(call.get("provider") or "") or None,
                    "error": str(call.get("error") or "")[:180] or None,
                })

        if fd_children:
            fd_children.sort(
                key=lambda child: (
                    child.get("startedAtMs") if isinstance(child, dict) and child.get("startedAtMs") is not None else 0,
                    child.get("id") if isinstance(child, dict) else "",
                )
            )
            if len(fd_children) > fd_child_cap:
                payload["fdChildrenTruncated"] = len(fd_children) - fd_child_cap
                fd_children = fd_children[:fd_child_cap]
            payload["fdChildren"] = fd_children

        append_job_event(
            conn,
            job_id,
            "Commit analysis result available",
            level=level,
            phase="llm",
            code="LLM_COMMIT_RESULT",
            repo_name=repo_full_name,
            sha=sha,
            payload=payload,
        )


def evaluate_chunk(commits, repo_path, language, llm_config, rate_limiter):
    """
    Process a chunk of commits through the LLM pipeline.

    This function is isolated as the future boundary for fan-out
    via Modal .map() when migrating to Approach C.
    """
    import sys
    sys.path.insert(0, "/app/pipeline")
    from run_devghost_pipeline import process_commits
    from run_v16_pipeline import reload_config

    # Sync pipeline globals with os.environ (warm container may have stale values)
    reload_config()

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

    # Strict mode: abort the entire job on first commit-level LLM failure.
    prev_fail_fast = os.environ.get("FAIL_FAST")
    os.environ["FAIL_FAST"] = "1"
    try:
        result = process_commits(repo_path, language, commit_dicts)
    finally:
        if prev_fail_fast is None:
            os.environ.pop("FAIL_FAST", None)
        else:
            os.environ["FAIL_FAST"] = prev_fail_fast

    chunk_results = result.get("commits", [])
    if result.get("status") != "ok":
        first_error = next((str(e) for e in (result.get("errors") or []) if e), None)
        if not first_error:
            for r in chunk_results:
                if r.get("method") == "error" or r.get("error"):
                    first_error = str(r.get("error") or f"commit {r.get('sha')} returned method=error")
                    break
        raise RuntimeError(f"FATAL_LLM: {first_error or 'chunk failed with unknown LLM error'}")

    for r in chunk_results:
        if r.get("method") == "error" or r.get("error"):
            commit_sha = str(r.get("sha") or "unknown")
            commit_error = str(r.get("error") or "commit returned method=error")
            raise RuntimeError(f"FATAL_LLM: commit {commit_sha} failed: {commit_error[:500]}")

    return chunk_results


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


def validate_llm_config_snapshot(llm_config: dict) -> str | None:
    """Return validation error for LLM snapshot, or None when valid."""
    if not isinstance(llm_config, dict) or not llm_config:
        return "Missing llmConfigSnapshot on AnalysisJob: refusing to run with implicit defaults"

    provider = llm_config.get("provider")
    if provider not in ("openrouter", "ollama"):
        return f"Invalid llmConfigSnapshot.provider={provider!r}; expected 'openrouter' or 'ollama'"

    if provider == "openrouter":
        model = (llm_config.get("openrouter") or {}).get("model")
        if not model:
            return "Invalid llmConfigSnapshot: openrouter.model is required"
    else:
        model = (llm_config.get("ollama") or {}).get("model")
        if not model:
            return "Invalid llmConfigSnapshot: ollama.model is required"

    return None


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
    provider_order = openrouter.get("providerOrder", "")
    if isinstance(provider_order, list):
        provider_order = ",".join(provider_order)
    os.environ["OPENROUTER_PROVIDER_ORDER"] = provider_order

    provider_ignore = openrouter.get("providerIgnore", "")
    if isinstance(provider_ignore, list):
        provider_ignore = ",".join(provider_ignore)
    os.environ["OPENROUTER_PROVIDER_IGNORE"] = provider_ignore

    os.environ["OPENROUTER_ALLOW_FALLBACKS"] = str(openrouter.get("allowFallbacks", True)).lower()
    os.environ["OPENROUTER_REQUIRE_PARAMETERS"] = str(openrouter.get("requireParameters", True)).lower()
    os.environ["PIPELINE_CACHE_DIR"] = PIPELINE_CACHE_DIR
    os.environ["PIPELINE_CACHE_NAMESPACE"] = PIPELINE_CACHE_NAMESPACE
    os.makedirs(PIPELINE_CACHE_DIR, exist_ok=True)

    # Effective context length — restore from snapshot so the pipeline uses the same
    # FD threshold as the server-side analysis that created this job.
    eff_ctx = llm_config.get("effectiveContextLength")
    if eff_ctx is not None:
        os.environ["MODEL_CONTEXT_LENGTH"] = str(int(eff_ctx))

    # FD v2 configuration — read from Modal env vars (not from llm_config snapshot,
    # because server-side SystemSettings schema doesn't include fdV2 fields yet).
    # Set these via Modal Secret 'devghost-llm' or Modal environment variables.
    # If not set, defaults apply: Branch B, 50 files, holistic enabled, no large model.
    for env_key, default in [
        ("FD_V2_BRANCH", "B"),
        ("FD_V2_MIN_FILES", "50"),
        ("FD_V2_HOLISTIC", "true"),
        ("FD_LARGE_LLM_PROVIDER", ""),
        ("FD_LARGE_LLM_MODEL", ""),
        ("FD_V3_ENABLED", ""),
    ]:
        if env_key not in os.environ:
            os.environ[env_key] = default

    # FD v3 config from snapshot (overrides Modal Secret values when present).
    # Benchmarks snapshot FD config at launch time — this ensures the worker
    # uses the same FD routing as intended, not whatever the Secret currently has.
    if llm_config.get("fdV3Enabled") is not None:
        os.environ["FD_V3_ENABLED"] = str(llm_config["fdV3Enabled"]).lower()
    if llm_config.get("fdLargeModel"):
        os.environ["FD_LARGE_LLM_MODEL"] = llm_config["fdLargeModel"]
    if llm_config.get("fdLargeProvider"):
        os.environ["FD_LARGE_LLM_PROVIDER"] = llm_config["fdLargeProvider"]


def _utc_iso_days_ago(days: int) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days)
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _extract_last_n_commits_with_adaptive_shallow(
    conn,
    job_id: str,
    repo_full_name: str,
    clone_url: str,
    token: str | None,
    default_branch: str,
    target_count: int,
    excluded_emails: list[str],
) -> tuple[str, list[dict], dict]:
    """Iteratively deepen shallow history until enough commits are available."""
    lookback_days = LAST_N_SHALLOW_INITIAL_DAYS
    max_days = max(LAST_N_SHALLOW_INITIAL_DAYS, LAST_N_SHALLOW_MAX_DAYS)
    attempts = 0
    previous_count = -1
    repo_path = ""
    commits: list[dict] = []
    last_since = _utc_iso_days_ago(lookback_days)
    stop_reason = "unknown"

    while True:
        attempts += 1
        last_since = _utc_iso_days_ago(lookback_days)
        append_job_event(
            conn,
            job_id,
            "Adaptive shallow attempt for LAST_N extraction",
            phase="scope",
            code="LAST_N_ADAPTIVE_ATTEMPT",
            repo_name=repo_full_name,
            payload={
                "attempt": attempts,
                "lookbackDays": lookback_days,
                "targetCount": target_count,
                "since": last_since,
            },
        )

        repo_path = clone_or_update(
            clone_url,
            repo_full_name,
            token,
            default_branch,
            shallow_since=last_since,
            volume_path="/repos",
        )
        commits = extract_commits(
            repo_path,
            since=last_since,
            max_count=target_count,
            excluded_emails=excluded_emails,
        )

        append_job_event(
            conn,
            job_id,
            "Adaptive shallow extraction probe completed",
            phase="scope",
            code="LAST_N_ADAPTIVE_RESULT",
            repo_name=repo_full_name,
            payload={
                "attempt": attempts,
                "lookbackDays": lookback_days,
                "commitCount": len(commits),
                "targetCount": target_count,
            },
        )

        if len(commits) >= target_count:
            stop_reason = "target_reached"
            break
        if lookback_days >= max_days:
            stop_reason = "max_lookback_reached"
            break
        if previous_count >= 0 and len(commits) <= previous_count:
            stop_reason = "stagnated_count"
            break

        previous_count = len(commits)
        next_lookback = min(max_days, lookback_days * LAST_N_SHALLOW_GROWTH_FACTOR)
        if next_lookback == lookback_days:
            stop_reason = "lookback_saturated"
            break
        lookback_days = next_lookback

    return repo_path, commits, {
        "attempts": attempts,
        "targetCount": target_count,
        "finalCount": len(commits),
        "finalLookbackDays": lookback_days,
        "finalSince": last_since,
        "reason": stop_reason,
    }


def _extract_commits_for_selected_years(
    repo_path: str,
    years: list[int],
    excluded_emails: list[str],
) -> list[dict]:
    """Extract commits for exact year buckets (non-contiguous years supported)."""
    unique_years = sorted({int(year) for year in years}, reverse=True)
    by_sha: dict[str, dict] = {}

    for year in unique_years:
        since = f"{year}-01-01T00:00:00Z"
        until = f"{year + 1}-01-01T00:00:00Z"
        rows = extract_commits(
            repo_path,
            since=since,
            until=until,
            excluded_emails=excluded_emails,
        )
        for row in rows:
            by_sha[row["sha"]] = row

    commits = list(by_sha.values())
    commits.sort(key=lambda c: c.get("author_date", ""), reverse=True)
    return commits


def _commit_repos_volume_checkpoint(
    conn,
    job_id: str,
    reason: str,
    repo_name: str | None = None,
) -> None:
    """Best-effort volume commit so retries reuse repos and pipeline cache."""
    if not REPO_VOLUME_CHECKPOINTS and reason not in {"job_complete", "job_failed"}:
        return

    committed_volumes: list[str] = []
    failed_volumes: dict[str, str] = {}
    volumes = [
        ("repos", repos_volume),
        ("pipeline_cache", pipeline_cache_volume),
    ]

    for volume_name, volume in volumes:
        last_err = None
        for attempt in range(3):
            try:
                volume.commit()
                committed_volumes.append(volume_name)
                last_err = None
                break
            except Exception as err:
                last_err = err
                if attempt < 2:
                    time.sleep(1 * (attempt + 1))  # 1s, 2s backoff
        if last_err is not None:
            failed_volumes[volume_name] = str(last_err)[:300]

    if committed_volumes:
        try:
            append_job_event(
                conn,
                job_id,
                "Worker volume checkpoint committed",
                phase="worker",
                code="REPOS_VOLUME_COMMITTED",
                repo_name=repo_name,
                payload={
                    "reason": reason,
                    "committedVolumes": committed_volumes,
                },
            )
        except Exception:
            pass

    if failed_volumes:
        try:
            append_job_event(
                conn,
                job_id,
                "Worker volume checkpoint failed",
                level="warn",
                phase="worker",
                code="REPOS_VOLUME_COMMIT_FAILED",
                repo_name=repo_name,
                payload={
                    "reason": reason,
                    "failedVolumes": failed_volumes,
                },
            )
        except Exception:
            pass


def build_scope(order):
    """Build commit scope filters from order config.

    For LAST_N_COMMITS: returns max_count=limit*2 per-repo (generous buffer).
    The actual global truncation to top-N happens in run_analysis() after
    extracting commits from ALL repos.
    """
    mode = order.get("analysis_period_mode", "ALL_TIME")

    if mode == "LAST_N_COMMITS" and order.get("analysis_commit_limit"):
        commit_limit = int(order["analysis_commit_limit"])
        return {
            "max_count": commit_limit * 2,
            "is_last_n": True,
            "commit_limit": commit_limit,
        }

    if mode == "DATE_RANGE" and order.get("analysis_start_date") and order.get("analysis_end_date"):
        return {
            "since": order["analysis_start_date"].isoformat() if hasattr(order["analysis_start_date"], 'isoformat') else order["analysis_start_date"],
            "until": order["analysis_end_date"].isoformat() if hasattr(order["analysis_end_date"], 'isoformat') else order["analysis_end_date"],
        }

    if mode == "SELECTED_YEARS" and order.get("analysis_years"):
        years_set: set[int] = set()
        for raw_year in order["analysis_years"]:
            try:
                year = int(raw_year)
            except (TypeError, ValueError):
                continue
            if year <= 0:
                continue
            years_set.add(year)
        years = sorted(years_set)
        if not years:
            return {}
        min_year = min(years)
        max_year = max(years)
        return {
            "years": years,
            "since": f"{min_year}-01-01T00:00:00Z",
            "until": f"{max_year + 1}-01-01T00:00:00Z",
        }

    return {}  # ALL_TIME -- no filters


def map_to_commit_analysis(result, commits, order_id, repo_full_name, llm_model):
    """Map pipeline result to CommitAnalysis row dict."""
    commit = next((c for c in commits if c["sha"] == result["sha"]), None)
    method = result.get("method", "")

    confidence = _confidence_from_method(method)

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
