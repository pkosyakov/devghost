-- Pipeline concurrency: admin-editable settings (null = auto-detect)
-- Generated via: prisma migrate diff --from-schema-datasource --to-schema-datamodel --script

-- AlterTable
ALTER TABLE "SystemSettings" ADD COLUMN     "fdLlmConcurrency" INTEGER,
ADD COLUMN     "fdLlmConcurrencyCap" INTEGER,
ADD COLUMN     "llmConcurrency" INTEGER;
