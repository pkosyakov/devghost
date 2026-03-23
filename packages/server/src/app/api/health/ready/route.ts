import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { logger } from '@/lib/logger';

const HEALTH_SECRET = process.env.HEALTH_CHECK_SECRET;

export const dynamic = 'force-dynamic';

/** GET /api/health/ready — readiness probe (DB connect) */
export async function GET(request: NextRequest) {
  if (HEALTH_SECRET) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${HEALTH_SECRET}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Health check failed');
    return Response.json({ ok: false }, { status: 503 });
  }
}
