-- Manual migration: add OpenRouter provider routing settings to SystemSettings.
-- Apply this script manually to the target PostgreSQL database.

ALTER TABLE "SystemSettings"
  ADD COLUMN IF NOT EXISTS "openrouterProviderOrder" TEXT NOT NULL DEFAULT 'Chutes',
  ADD COLUMN IF NOT EXISTS "openrouterProviderIgnore" TEXT NOT NULL DEFAULT 'Cloudflare',
  ADD COLUMN IF NOT EXISTS "openrouterAllowFallbacks" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "openrouterRequireParameters" BOOLEAN NOT NULL DEFAULT true;
