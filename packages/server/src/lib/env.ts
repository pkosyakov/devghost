import { logger } from '@/lib/logger';

const required = ['DATABASE_URL', 'AUTH_SECRET', 'AUTH_URL'] as const;

const recommendedForProduction = [
  'HEALTH_CHECK_SECRET',
  'DIRECT_URL',
  'CRON_SECRET',
  'STRIPE_WEBHOOK_SECRET',
] as const;

/**
 * Validate required env vars. Throws if any are missing.
 * Call from instrumentation.ts at startup.
 */
export function validateEnv(): void {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }

  const missingRecommended = recommendedForProduction.filter((k) => !process.env[k]);
  if (missingRecommended.length > 0) {
    logger.warn(
      { missing: missingRecommended },
      'Recommended env vars not set for production'
    );
  }
}
