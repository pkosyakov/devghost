-- Manual migration: enable multi-author ground truth (multi-GT)
-- Apply this script manually against the target database.

BEGIN;

ALTER TABLE "GroundTruth"
  ADD COLUMN IF NOT EXISTS "author" TEXT NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'GroundTruth_orderId_commitHash_key'
  ) THEN
    ALTER TABLE "GroundTruth"
      DROP CONSTRAINT "GroundTruth_orderId_commitHash_key";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'GroundTruth_orderId_commitHash_author_key'
  ) THEN
    ALTER TABLE "GroundTruth"
      ADD CONSTRAINT "GroundTruth_orderId_commitHash_author_key"
      UNIQUE ("orderId", "commitHash", "author");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "GroundTruth_orderId_author_idx"
  ON "GroundTruth" ("orderId", "author");

COMMIT;
