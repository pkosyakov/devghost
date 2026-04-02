ALTER TABLE "AnalysisJob"
ADD COLUMN "failureClass" TEXT,
ADD COLUMN "pausedAt" TIMESTAMP(3),
ADD COLUMN "pauseReason" TEXT;
