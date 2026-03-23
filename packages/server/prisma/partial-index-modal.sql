-- Modal integration: partial unique index for idempotent upserts when jobId IS NULL.
-- PostgreSQL treats each NULL as distinct, so the existing @@unique([orderId, commitHash, jobId])
-- does NOT prevent duplicates when jobId IS NULL. On retries, Modal would insert duplicate rows.
-- This index ensures only one row per (orderId, commitHash) when jobId is NULL (original analyses).
-- Benchmark rows (jobId IS NOT NULL) still use the existing composite unique constraint.
--
-- Apply: psql $DATABASE_URL -f prisma/partial-index-modal.sql
-- Or via Prisma: npx prisma db execute --file prisma/partial-index-modal.sql

CREATE UNIQUE INDEX IF NOT EXISTS "CommitAnalysis_orderId_commitHash_noJob_key"
ON "CommitAnalysis" ("orderId", "commitHash")
WHERE "jobId" IS NULL;
