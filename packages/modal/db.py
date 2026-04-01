"""
Supabase PostgreSQL connection and query helpers for Modal worker.
Uses psycopg2 with direct connection (port 5432, not pooler).
"""
import json
import os
import uuid
from datetime import datetime

import psycopg2
import psycopg2.extras


RETRYABLE_DB_ERRORS = (
    psycopg2.InterfaceError,
    psycopg2.OperationalError,
)

MODEL_INDEPENDENT_NULL_METHODS = (
    "root_commit_skip",
    "FD_cheap",
    "FD_bulk_scaffold",
    "FD_v2_heuristic_only",
    "FD_v3_heuristic_only",
)


class ResilientConnection:
    """Thin psycopg2 connection proxy with auto-reconnect on cursor acquisition.

    Why this exists:
    - Long-running Modal containers can hold a DB connection long enough for it to
      be closed by network/proxy/server side.
    - The common failure mode is `psycopg2.InterfaceError: connection already closed`
      thrown at `conn.cursor()`.

    Behaviour:
    - `cursor(...)` verifies underlying connection and reconnects automatically on
      retryable connection errors, then retries cursor acquisition.
    - `rollback()` is best-effort and never raises for closed/retryable connection
      failures (used mainly in telemetry/error paths).
    - Other attributes/methods are forwarded to the underlying psycopg2 connection.
    """

    def __init__(self, dsn: str, reconnect_attempts: int = 2):
        self._dsn = dsn
        self._reconnect_attempts = max(1, reconnect_attempts)
        self._conn = self._new_conn()

    def _new_conn(self):
        return psycopg2.connect(self._dsn)

    def _close_underlying(self):
        if self._conn is None:
            return
        try:
            self._conn.close()
        except Exception:
            pass

    def _ensure_open(self):
        if self._conn is None or self._conn.closed:
            self._conn = self._new_conn()

    def _reconnect(self):
        self._close_underlying()
        self._conn = self._new_conn()

    @property
    def closed(self):
        if self._conn is None:
            return 1
        return self._conn.closed

    def cursor(self, *args, **kwargs):
        last_err = None
        for _ in range(self._reconnect_attempts):
            self._ensure_open()
            try:
                return self._conn.cursor(*args, **kwargs)
            except RETRYABLE_DB_ERRORS as err:
                last_err = err
                self._reconnect()
        if last_err is not None:
            raise last_err
        raise RuntimeError("Failed to acquire DB cursor")

    def commit(self):
        self._ensure_open()
        return self._conn.commit()

    def rollback(self):
        if self._conn is None or self._conn.closed:
            return None
        try:
            return self._conn.rollback()
        except RETRYABLE_DB_ERRORS:
            return None

    def close(self):
        self._close_underlying()

    def __getattr__(self, name):
        self._ensure_open()
        return getattr(self._conn, name)


def connect_db():
    """Connect to Supabase using DIRECT_URL (port 5432, not pooled)."""
    url = os.environ["DIRECT_URL"]  # Must be direct, not pooled
    try:
        reconnect_attempts = int(os.environ.get("DB_RECONNECT_ATTEMPTS", "2"))
    except ValueError:
        reconnect_attempts = 2
    return ResilientConnection(url, reconnect_attempts=reconnect_attempts)


def acquire_job(conn, job_id: str) -> dict | None:
    """
    Acquire a job with optimistic locking.
    Returns job dict if acquired, None if already taken or invalid.
    """
    modal_call_id = os.environ.get("MODAL_TASK_ID", str(uuid.uuid4()))

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        # Atomic: only acquire if PENDING (or retried PENDING)
        cur.execute("""
            UPDATE "AnalysisJob"
            SET status = 'RUNNING',
                "lockedBy" = %s,
                "heartbeatAt" = NOW(),
                "startedAt" = COALESCE("startedAt", NOW()),
                "executionMode" = 'modal',
                "modalCallId" = %s
            WHERE id = %s AND status = 'PENDING'
            RETURNING *
        """, (modal_call_id, modal_call_id, job_id))

        row = cur.fetchone()
        conn.commit()

        if not row:
            return None
        return dict(row)


def load_order(conn, order_id: str) -> dict:
    """Load order with all fields needed for analysis."""
    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""
            SELECT id, "userId" as user_id, status,
                   "selectedRepos" as selected_repos,
                   "excludedDevelopers" as excluded_developers,
                   "analysisPeriodMode" as analysis_period_mode,
                   "analysisYears" as analysis_years,
                   "analysisStartDate" as analysis_start_date,
                   "analysisEndDate" as analysis_end_date,
                   "analysisCommitLimit" as analysis_commit_limit
            FROM "Order" WHERE id = %s
        """, (order_id,))
        return dict(cur.fetchone())


def load_demo_live_settings(conn) -> tuple[bool, int]:
    """Read demo-live settings from SystemSettings singleton."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT "demoLiveMode", "demoLiveChunkSize" FROM "SystemSettings" WHERE id = %s',
                ('singleton',),
            )
            row = cur.fetchone()
            if not row:
                return False, 10
            mode = bool(row[0])
            chunk_size = row[1]
            if not isinstance(chunk_size, int):
                chunk_size = 10
            return mode, max(1, min(200, chunk_size))
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
    # Backward compatibility for DB schemas that still don't have
    # "demoLiveChunkSize" column.
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT "demoLiveMode" FROM "SystemSettings" WHERE id = %s',
                ('singleton',),
            )
            row = cur.fetchone()
            if not row:
                return False, 10
            return bool(row[0]), 10
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        return False, 10


def load_demo_live_mode(conn) -> bool:
    """Backwards-compatible helper: only demo-live toggle."""
    mode, _ = load_demo_live_settings(conn)
    return mode


def load_github_token(conn, user_id: str) -> str | None:
    """Load user's GitHub access token for private repo access."""
    with conn.cursor() as cur:
        cur.execute(
            'SELECT "githubAccessToken" FROM "User" WHERE id = %s',
            (user_id,),
        )
        row = cur.fetchone()
        return row[0] if row else None


def get_existing_shas(conn, order_id: str, repository: str) -> set[str]:
    """Get already-analyzed commit hashes for intra-order dedup."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT "commitHash" FROM "CommitAnalysis"
            WHERE "orderId" = %s AND "jobId" IS NULL
              AND method != 'error' AND repository = %s
        """, (order_id, repository))
        return {row[0] for row in cur.fetchall()}


def lookup_cached_commits(
    conn, shas: list[str], current_order_id: str, user_id: str,
    repository: str, cache_mode: str, current_llm_model: str,
) -> tuple[list[dict], set[str]]:
    """Cross-order cache: find commits analyzed in other completed orders."""
    if cache_mode == "off" or not shas:
        return [], set()

    query = """
        SELECT ca."commitHash", ca."commitMessage", ca."authorEmail",
               ca."authorName", ca."authorDate", ca.repository,
               ca.additions, ca.deletions, ca."filesCount",
               ca."effortHours", ca.category, ca.complexity,
               ca.confidence, ca.method, ca."llmModel"
        FROM "CommitAnalysis" ca
        JOIN "Order" o ON o.id = ca."orderId"
        WHERE ca."commitHash" = ANY(%s)
          AND ca.repository = %s
          AND ca."orderId" != %s
          AND o."userId" = %s
          AND o.status = 'COMPLETED'
          AND ca.method != 'error'
          AND ca."jobId" IS NULL
    """
    params = [shas, repository, current_order_id, user_id]

    if cache_mode == "model":
        # Reuse exact llmModel matches plus a narrow allowlist of methods that
        # are explicitly model-independent and therefore safe to cache even
        # when historical rows were stored with llmModel=NULL.
        #
        # Everything else with llmModel=NULL (for example legacy plain FD rows
        # or old mis-attributed large-model rows) must be recomputed under the
        # current pipeline to avoid pulling stale pre-rollout estimates.
        query += (
            ' AND (ca."llmModel" = %s'
            ' OR (ca."llmModel" IS NULL AND ca.method = ANY(%s)))'
        )
        params.extend([current_llm_model, list(MODEL_INDEPENDENT_NULL_METHODS)])

    query += ' ORDER BY ca."analyzedAt" DESC'

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(query, params)
        rows = cur.fetchall()

    # Deduplicate: keep one per SHA (most recent)
    seen = set()
    deduped = []
    for row in rows:
        sha = row["commitHash"]
        if sha not in seen:
            seen.add(sha)
            deduped.append(dict(row))

    return deduped, seen


def copy_cached_to_order(conn, rows: list[dict], order_id: str, repository: str):
    """Copy cached CommitAnalysis rows into current order."""
    with conn.cursor() as cur:
        for row in rows:
            cur.execute("""
                INSERT INTO "CommitAnalysis" (
                    id, "orderId", "commitHash", "commitMessage",
                    "authorEmail", "authorName", "authorDate", repository,
                    additions, deletions, "filesCount",
                    "effortHours", category, complexity, confidence,
                    method, "llmModel", "analyzedAt"
                ) VALUES (
                    gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()
                ) ON CONFLICT ("orderId", "commitHash") WHERE "jobId" IS NULL DO NOTHING
            """, (
                order_id, row["commitHash"], row["commitMessage"],
                row["authorEmail"], row["authorName"], row["authorDate"],
                repository,
                row["additions"], row["deletions"], row["filesCount"],
                row["effortHours"], row["category"], row["complexity"],
                row["confidence"], row["method"], row["llmModel"],
            ))
    conn.commit()


def delete_existing_analyses(conn, order_id: str):
    """Delete all CommitAnalysis rows for an order (forceRecalculate mode)."""
    with conn.cursor() as cur:
        cur.execute(
            'DELETE FROM "CommitAnalysis" WHERE "orderId" = %s AND "jobId" IS NULL',
            (order_id,),
        )
    conn.commit()


def delete_analyses_since(conn, order_id: str, started_at) -> int:
    """Delete CommitAnalysis rows inserted since job start for rollback on strict failures."""
    with conn.cursor() as cur:
        cur.execute(
            """
            DELETE FROM "CommitAnalysis"
            WHERE "orderId" = %s
              AND "jobId" IS NULL
              AND "analyzedAt" >= %s
            """,
            (order_id, started_at),
        )
        deleted = cur.rowcount or 0
    conn.commit()
    return deleted


def get_base_commit_shas(conn, order_id: str, repository: str) -> set[str]:
    """Get commit SHAs from the original analysis (jobId IS NULL) for benchmark pinning."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT "commitHash" FROM "CommitAnalysis"
            WHERE "orderId" = %s AND "jobId" IS NULL AND repository = %s
        """, (order_id, repository))
        return {row[0] for row in cur.fetchall()}


def delete_benchmark_analyses(conn, order_id: str, job_id: str) -> int:
    """Delete all CommitAnalysis rows for a benchmark job (rollback on failure)."""
    with conn.cursor() as cur:
        cur.execute(
            'DELETE FROM "CommitAnalysis" WHERE "orderId" = %s AND "jobId" = %s',
            (order_id, job_id),
        )
        deleted = cur.rowcount or 0
    conn.commit()
    return deleted


def save_commit_analyses(conn, analyses: list[dict], job_id: str | None = None):
    """Batch insert CommitAnalysis rows.

    When job_id is provided (benchmarks), rows are written with that jobId and use
    the composite unique constraint (orderId, commitHash, jobId) for conflict handling.
    When job_id is None (regular analysis), rows use the partial index WHERE jobId IS NULL.
    """
    with conn.cursor() as cur:
        for a in analyses:
            if job_id is not None:
                cur.execute("""
                    INSERT INTO "CommitAnalysis" (
                        id, "orderId", "jobId", "commitHash", "commitMessage",
                        "authorEmail", "authorName", "authorDate", repository,
                        additions, deletions, "filesCount",
                        "effortHours", category, complexity, confidence,
                        method, "llmModel", "analyzedAt"
                    ) VALUES (
                        gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()
                    ) ON CONFLICT ("orderId", "commitHash", "jobId") DO NOTHING
                """, (
                    a["order_id"], job_id, a["commit_hash"], a["commit_message"],
                    a["author_email"], a["author_name"], a["author_date"],
                    a["repository"],
                    a["additions"], a["deletions"], a["files_count"],
                    a["effort_hours"], a["category"], a["complexity"],
                    a["confidence"], a["method"], a["llm_model"],
                ))
            else:
                cur.execute("""
                    INSERT INTO "CommitAnalysis" (
                        id, "orderId", "commitHash", "commitMessage",
                        "authorEmail", "authorName", "authorDate", repository,
                        additions, deletions, "filesCount",
                        "effortHours", category, complexity, confidence,
                        method, "llmModel", "analyzedAt"
                    ) VALUES (
                        gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW()
                    ) ON CONFLICT ("orderId", "commitHash") WHERE "jobId" IS NULL DO NOTHING
                """, (
                    a["order_id"], a["commit_hash"], a["commit_message"],
                    a["author_email"], a["author_name"], a["author_date"],
                    a["repository"],
                    a["additions"], a["deletions"], a["files_count"],
                    a["effort_hours"], a["category"], a["complexity"],
                    a["confidence"], a["method"], a["llm_model"],
                ))
    conn.commit()


def increment_total_commits(conn, job_id: str, count: int):
    """Increment totalCommits counter on the job."""
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE "AnalysisJob"
            SET "totalCommits" = COALESCE("totalCommits", 0) + %s,
                "updatedAt" = NOW()
            WHERE id = %s
        """, (count, job_id))
    conn.commit()


def append_job_event(
    conn,
    job_id: str,
    message: str,
    level: str = "info",
    phase: str | None = None,
    code: str | None = None,
    repo_name: str | None = None,
    sha: str | None = None,
    payload: dict | list | str | int | float | bool | None = None,
):
    """Append a diagnostics event for an analysis job (best-effort)."""
    payload_json = json.dumps(payload) if payload is not None else None
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO "AnalysisJobEvent"
                  ("jobId", level, phase, code, message, repo, sha, payload)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            """, (job_id, level, phase, code, message, repo_name, sha, payload_json))
        conn.commit()
    except Exception:
        # Telemetry must never break the analysis flow.
        try:
            conn.rollback()
        except Exception:
            pass


def update_progress(conn, job_id: str, progress: int | None = None,
                    processed: int | None = None, step: str | None = None,
                    repo_name: str | None = None):
    """Update job progress fields."""
    updates = []
    params = []

    if progress is not None:
        updates.append('"progress" = %s')
        params.append(min(progress, 99))
    if processed is not None:
        updates.append('"currentCommit" = %s')
        params.append(processed)
    if step is not None:
        updates.append('"currentStep" = %s')
        params.append(step)

    if not updates:
        return

    params.append(job_id)
    with conn.cursor() as cur:
        cur.execute(
            f'UPDATE "AnalysisJob" SET {", ".join(updates)}, "updatedAt" = NOW() WHERE id = %s',
            params,
        )

    # Also update order's currentRepoName if provided
    if repo_name:
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE "Order" SET "currentRepoName" = %s
                WHERE id = (SELECT "orderId" FROM "AnalysisJob" WHERE id = %s)
            """, (repo_name, job_id))

    conn.commit()


def update_heartbeat(conn, job_id: str):
    """Update heartbeat timestamp."""
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE "AnalysisJob"
            SET "heartbeatAt" = NOW(),
                "updatedAt" = NOW()
            WHERE id = %s
        """, (job_id,))
    conn.commit()


def is_job_cancelled(conn, job_id: str) -> bool:
    """Check if a job was cancelled by user/API."""
    with conn.cursor() as cur:
        cur.execute('SELECT status FROM "AnalysisJob" WHERE id = %s', (job_id,))
        row = cur.fetchone()
    if not row:
        return True
    return row[0] == "CANCELLED"


def update_llm_usage(conn, job_id: str, total_analyzed: int):
    """Store LLM usage stats on the job (token counts aggregated from pipeline)."""
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE "AnalysisJob"
            SET "totalLlmCalls" = COALESCE("totalLlmCalls", 0) + %s,
                "updatedAt" = NOW()
            WHERE id = %s
        """, (total_analyzed, job_id))
    conn.commit()


def account_cached_batch(conn, job_id: str, count: int):
    """Account for cached commits -- increment creditsReleased and decrement user reservedCredits.

    Mirrors accountCachedBatch() from the TypeScript worker.
    This ensures post-processing correctly calculates: toDebit = processed - cachedReleased.
    Without this step, post-processing would double-charge for cache-hit commits.
    """
    if count <= 0:
        return
    with conn.cursor() as cur:
        # Update job: track how many were from cache
        cur.execute("""
            UPDATE "AnalysisJob"
            SET "creditsReleased" = COALESCE("creditsReleased", 0) + %s
            WHERE id = %s
        """, (count, job_id))

        # Release reservation on user (cache hits are free)
        cur.execute("""
            UPDATE "User" SET "reservedCredits" = GREATEST("reservedCredits" - %s, 0)
            WHERE id = (
                SELECT o."userId" FROM "AnalysisJob" aj
                JOIN "Order" o ON o.id = aj."orderId"
                WHERE aj.id = %s
            )
        """, (count, job_id))
    conn.commit()


def set_job_status(conn, job_id: str, status: str, progress: int | None = None):
    """Set job status with optional progress."""
    updates = ['"status" = %s']
    params = [status]

    if progress is not None:
        updates.append('"progress" = %s')
        params.append(progress)

    if status == "LLM_COMPLETE":
        updates.append('"currentStep" = %s')
        params.append("llm_complete")
    elif status == "COMPLETED":
        updates.append('"completedAt" = NOW()')
        updates.append('"currentStep" = %s')
        params.append("completed")
    elif status == "CANCELLED":
        updates.append('"completedAt" = NOW()')
        updates.append('"currentStep" = %s')
        params.append("cancelled")

    params.append(job_id)
    with conn.cursor() as cur:
        cur.execute(
            f'UPDATE "AnalysisJob" SET {", ".join(updates)}, "updatedAt" = NOW() WHERE id = %s',
            params,
        )
    conn.commit()


def set_job_error(conn, job_id: str, error_msg: str, fatal: bool = False,
                  skip_order_update: bool = False):
    """Mark job as failed (retryable or fatal).

    When skip_order_update is True (benchmarks), the Order status is NOT set to FAILED.
    Benchmark failures should not affect the underlying order.
    """
    status = "FAILED_FATAL" if fatal else "FAILED_RETRYABLE"
    with conn.cursor() as cur:
        cur.execute("""
            UPDATE "AnalysisJob"
            SET status = %s, error = %s, "completedAt" = NOW(), "updatedAt" = NOW()
            WHERE id = %s
        """, (status, error_msg[:2000], job_id))  # Truncate error to avoid DB overflow
        if fatal and not skip_order_update:
            cur.execute(
                """
                UPDATE "Order"
                SET status = 'FAILED',
                    "errorMessage" = %s,
                    "updatedAt" = NOW()
                WHERE id = (SELECT "orderId" FROM "AnalysisJob" WHERE id = %s)
                """,
                (error_msg[:1000], job_id),
            )
    conn.commit()
