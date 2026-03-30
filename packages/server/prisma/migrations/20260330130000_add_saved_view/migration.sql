-- Global Scope and Saved Views: SavedView
-- Generated via: prisma migrate diff --from-schema-datasource --to-schema-datamodel --script

-- CreateEnum
CREATE TYPE "SavedViewVisibility" AS ENUM ('PRIVATE', 'WORKSPACE');

-- CreateTable
CREATE TABLE "SavedView" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "visibility" "SavedViewVisibility" NOT NULL DEFAULT 'PRIVATE',
    "scopeDefinition" JSONB NOT NULL,
    "filterDefinition" JSONB NOT NULL DEFAULT '{}',
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SavedView_workspaceId_isArchived_idx" ON "SavedView"("workspaceId", "isArchived");

-- CreateIndex
CREATE INDEX "SavedView_ownerUserId_idx" ON "SavedView"("ownerUserId");

-- CreateIndex
CREATE INDEX "SavedView_workspaceId_updatedAt_idx" ON "SavedView"("workspaceId", "updatedAt");

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
