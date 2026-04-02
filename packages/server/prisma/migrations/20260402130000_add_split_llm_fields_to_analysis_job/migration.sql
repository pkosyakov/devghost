ALTER TABLE "AnalysisJob"
ADD COLUMN "smallLlmProvider" TEXT,
ADD COLUMN "smallLlmModel" TEXT,
ADD COLUMN "largeLlmProvider" TEXT,
ADD COLUMN "largeLlmModel" TEXT,
ADD COLUMN "fdV3Enabled" BOOLEAN;
