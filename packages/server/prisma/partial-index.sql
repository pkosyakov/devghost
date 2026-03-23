-- Partial unique index for CommitAnalysis with NULL jobId
-- Prevents duplicate (orderId, commitHash) pairs for original analysis records
-- PostgreSQL treats each NULL as unique in regular unique constraints,
-- so @@unique([orderId, commitHash, jobId]) does NOT prevent duplicates when jobId IS NULL.
-- This partial index fills that gap.
--
-- Run manually: npx prisma db execute --schema prisma/schema.prisma --stdin < prisma/partial-index.sql

CREATE UNIQUE INDEX IF NOT EXISTS "CommitAnalysis_orderId_commitHash_null_jobId"
ON "CommitAnalysis" ("orderId", "commitHash")
WHERE "jobId" IS NULL;
