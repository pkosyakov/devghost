import { NextRequest } from 'next/server';
import { apiError } from '@/lib/api-utils';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'rate-limit' });

type RateLimitTier = 'auth' | 'billing' | 'analysis';

const TIER_CONFIG: Record<RateLimitTier, { limit: number; window: string }> = {
  auth: { limit: 5, window: '1m' },
  billing: { limit: 10, window: '1m' },
  analysis: { limit: 3, window: '1h' },
};

/**
 * Extract client IP from request headers.
 * Prefers x-forwarded-for (reverse proxy), falls back to x-real-ip,
 * then NextRequest.ip (Vercel), then 'unknown'.
 */
function getClientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip')?.trim() ||
    (request as NextRequest & { ip?: string }).ip ||
    'unknown'
  );
}

/**
 * Check rate limit for a request.
 * Graceful degradation: if UPSTASH is not configured or Redis is unreachable, allows all requests.
 * @param request - NextRequest for IP extraction
 * @param tier - Rate limit tier
 * @param userId - Optional user ID (preferred over IP for authenticated routes)
 * @returns null if allowed, NextResponse if rate limited
 */
export async function checkRateLimit(
  request: NextRequest,
  tier: RateLimitTier,
  userId?: string,
) {
  // Graceful degradation: skip if Upstash is not configured
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return null;
  }

  try {
    // Dynamic import to avoid errors when packages aren't configured
    const { Ratelimit } = await import('@upstash/ratelimit');
    const { Redis } = await import('@upstash/redis');

    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    const config = TIER_CONFIG[tier];

    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(config.limit, config.window as Parameters<typeof Ratelimit.slidingWindow>[1]),
      prefix: `rl:${tier}`,
    });

    // Identifier: userId for auth routes, IP for public
    const identifier = userId ?? getClientIp(request);

    const { success, reset } = await ratelimit.limit(identifier);

    if (!success) {
      const retryAfter = Math.ceil((reset - Date.now()) / 1000);
      log.warn({ tier, identifier: userId ? 'user' : 'ip', retryAfter }, 'Rate limit exceeded');
      const response = apiError('Too many requests', 429);
      response.headers.set('Retry-After', String(retryAfter));
      return response;
    }

    return null;
  } catch (err) {
    // Fail-open: if Redis is unreachable, allow the request but log for observability
    log.warn({ err, tier }, 'Rate limiter unavailable, failing open');
    return null;
  }
}
