-- Contributor Foundation: Workspace, Contributor, ContributorAlias, CurationAuditLog
-- Generated via: prisma migrate diff --from-schema-datasource --to-schema-datamodel --script

-- CreateEnum
CREATE TYPE "ContributorClassification" AS ENUM ('INTERNAL', 'EXTERNAL', 'BOT', 'FORMER_EMPLOYEE');

-- CreateEnum
CREATE TYPE "AliasResolveStatus" AS ENUM ('AUTO_MERGED', 'MANUAL', 'SUGGESTED', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "CurationAction" AS ENUM ('MERGE', 'UNMERGE', 'EXCLUDE', 'INCLUDE', 'CLASSIFY');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'My Workspace',
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contributor" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "primaryEmail" TEXT NOT NULL,
    "classification" "ContributorClassification" NOT NULL DEFAULT 'INTERNAL',
    "isExcluded" BOOLEAN NOT NULL DEFAULT false,
    "excludedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contributor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContributorAlias" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contributorId" TEXT,
    "providerType" TEXT NOT NULL DEFAULT 'github',
    "providerId" TEXT,
    "email" TEXT NOT NULL,
    "username" TEXT,
    "resolveStatus" "AliasResolveStatus" NOT NULL DEFAULT 'UNRESOLVED',
    "mergeReason" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "classificationHint" "ContributorClassification",
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContributorAlias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurationAuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contributorId" TEXT,
    "aliasId" TEXT,
    "action" "CurationAction" NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "performedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CurationAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_ownerId_key" ON "Workspace"("ownerId");

-- CreateIndex
CREATE INDEX "Contributor_workspaceId_idx" ON "Contributor"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Contributor_workspaceId_primaryEmail_key" ON "Contributor"("workspaceId", "primaryEmail");

-- CreateIndex
CREATE INDEX "ContributorAlias_contributorId_idx" ON "ContributorAlias"("contributorId");

-- CreateIndex
CREATE INDEX "ContributorAlias_resolveStatus_idx" ON "ContributorAlias"("resolveStatus");

-- CreateIndex
CREATE INDEX "ContributorAlias_workspaceId_idx" ON "ContributorAlias"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ContributorAlias_workspaceId_providerType_email_key" ON "ContributorAlias"("workspaceId", "providerType", "email");

-- CreateIndex
CREATE UNIQUE INDEX "ContributorAlias_workspaceId_providerType_providerId_key" ON "ContributorAlias"("workspaceId", "providerType", "providerId");

-- CreateIndex
CREATE INDEX "CurationAuditLog_workspaceId_idx" ON "CurationAuditLog"("workspaceId");

-- CreateIndex
CREATE INDEX "CurationAuditLog_contributorId_idx" ON "CurationAuditLog"("contributorId");

-- CreateIndex
CREATE INDEX "CurationAuditLog_aliasId_idx" ON "CurationAuditLog"("aliasId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contributor" ADD CONSTRAINT "Contributor_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributorAlias" ADD CONSTRAINT "ContributorAlias_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributorAlias" ADD CONSTRAINT "ContributorAlias_contributorId_fkey" FOREIGN KEY ("contributorId") REFERENCES "Contributor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurationAuditLog" ADD CONSTRAINT "CurationAuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurationAuditLog" ADD CONSTRAINT "CurationAuditLog_contributorId_fkey" FOREIGN KEY ("contributorId") REFERENCES "Contributor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CurationAuditLog" ADD CONSTRAINT "CurationAuditLog_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
