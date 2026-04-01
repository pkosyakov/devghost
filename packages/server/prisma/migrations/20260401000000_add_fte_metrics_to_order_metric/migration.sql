-- FTE Metrics: add full-time employee mode columns to OrderMetric
-- Generated via: prisma migrate diff --from-schema-datasource --to-schema-datamodel --script

-- AlterTable
ALTER TABLE "OrderMetric" ADD COLUMN     "fteAvgDailyEffort" DECIMAL(10,4) DEFAULT 0,
ADD COLUMN     "fteGhostPercent" DECIMAL(10,2),
ADD COLUMN     "fteGhostPercentRaw" DECIMAL(10,2),
ADD COLUMN     "fteWorkDays" INTEGER NOT NULL DEFAULT 0;
