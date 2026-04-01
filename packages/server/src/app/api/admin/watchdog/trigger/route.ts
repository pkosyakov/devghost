import { NextRequest } from 'next/server';
import { requireAdmin, apiError, isErrorResponse } from '@/lib/api-utils';
import { auditLog } from '@/lib/audit';
import { GET as watchdogHandler } from '@/app/api/cron/analysis-watchdog/route';

export const maxDuration = 60;

export async function POST() {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return apiError('CRON_SECRET not configured', 500);
  }

  const fakeReq = new NextRequest(
    new URL('/api/cron/analysis-watchdog', 'http://localhost'),
    { headers: { authorization: `Bearer ${cronSecret}` } },
  );

  try {
    const result = await watchdogHandler(fakeReq);

    await auditLog({
      userId: session.user.id,
      action: 'admin.watchdog.trigger',
      details: { source: 'admin_ui' },
    });

    return result;
  } catch (err) {
    return apiError(`Watchdog failed: ${String(err).slice(0, 200)}`, 500);
  }
}
