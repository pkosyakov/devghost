import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';
import { isBillingEnabled, releaseReservedCredits } from '@/lib/services/credit-service';

export const maxDuration = 30;

const log = billingLogger.child({ module: 'billing-reconciliation' });

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED_FATAL', 'FAILED', 'CANCELLED'];

// GET /api/cron/billing-reconciliation
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isBillingEnabled()) {
    return Response.json({ ok: true, skipped: true, reason: 'billing disabled' });
  }

  const violations: {
    overConsumed: string[];
    overTotal: string[];
    leakedTerminal: string[];
    autoRepaired: string[];
  } = {
    overConsumed: [],
    overTotal: [],
    leakedTerminal: [],
    autoRepaired: [],
  };

  // Invariant 1: creditsConsumed <= creditsReserved (SQL-filtered)
  const inv1Jobs = await prisma.$queryRaw<{ id: string; creditsConsumed: number; creditsReserved: number }[]>`
    SELECT id, "creditsConsumed", "creditsReserved"
    FROM "AnalysisJob"
    WHERE "creditsReserved" > 0 AND "creditsConsumed" > "creditsReserved"
    LIMIT 100
  `;
  for (const job of inv1Jobs) {
    violations.overConsumed.push(job.id);
    log.error(
      { jobId: job.id, creditsConsumed: job.creditsConsumed, creditsReserved: job.creditsReserved },
      'Invariant 1 violation: consumed > reserved',
    );
  }

  // Invariant 2: creditsConsumed + creditsReleased <= creditsReserved (SQL-filtered)
  const inv2Jobs = await prisma.$queryRaw<{ id: string; creditsConsumed: number; creditsReleased: number; creditsReserved: number }[]>`
    SELECT id, "creditsConsumed", "creditsReleased", "creditsReserved"
    FROM "AnalysisJob"
    WHERE "creditsReserved" > 0 AND "creditsConsumed" + "creditsReleased" > "creditsReserved"
    LIMIT 100
  `;
  for (const job of inv2Jobs) {
    violations.overTotal.push(job.id);
    log.error(
      { jobId: job.id, creditsConsumed: job.creditsConsumed, creditsReleased: job.creditsReleased, creditsReserved: job.creditsReserved },
      'Invariant 2 violation: consumed + released > reserved',
    );
  }

  // Invariant 3: terminal jobs must have zero remaining reservation (SQL-filtered, auto-repair)
  const inv3Jobs = await prisma.$queryRaw<{ id: string; orderId: string; status: string; userId: string; creditsConsumed: number; creditsReleased: number; creditsReserved: number }[]>`
    SELECT j.id, j."orderId", j.status,
           j."creditsConsumed", j."creditsReleased", j."creditsReserved",
           o."userId"
    FROM "AnalysisJob" j
    JOIN "Order" o ON o.id = j."orderId"
    WHERE j.status IN ('COMPLETED', 'FAILED_FATAL', 'FAILED', 'CANCELLED')
      AND j."creditsReserved" > 0
      AND j."creditsReserved" - j."creditsConsumed" - j."creditsReleased" > 0
    LIMIT 100
  `;
  for (const job of inv3Jobs) {
    const leaked = job.creditsReserved - job.creditsConsumed - job.creditsReleased;
    violations.leakedTerminal.push(job.id);
    log.warn(
      { jobId: job.id, status: job.status, leaked, creditsConsumed: job.creditsConsumed, creditsReleased: job.creditsReleased, creditsReserved: job.creditsReserved },
      'Invariant 3 violation: terminal job has leaked reservation',
    );

    // Auto-repair: releaseReservedCredits is idempotent
    try {
      await releaseReservedCredits(job.userId, job.id, job.orderId);
      violations.autoRepaired.push(job.id);
      log.info({ jobId: job.id, leaked }, 'Auto-repaired leaked reservation');
    } catch (err) {
      log.error({ err, jobId: job.id }, 'Failed to auto-repair leaked reservation');
    }
  }

  const hasViolations =
    violations.overConsumed.length > 0 ||
    violations.overTotal.length > 0 ||
    violations.leakedTerminal.length > 0;

  if (hasViolations) {
    log.warn(
      {
        overConsumed: violations.overConsumed.length,
        overTotal: violations.overTotal.length,
        leakedTerminal: violations.leakedTerminal.length,
        autoRepaired: violations.autoRepaired.length,
      },
      'Billing reconciliation found violations',
    );
  }

  return Response.json({
    ok: true,
    violations: {
      overConsumed: violations.overConsumed.length,
      overTotal: violations.overTotal.length,
      leakedTerminal: violations.leakedTerminal.length,
      autoRepaired: violations.autoRepaired.length,
    },
    ...(hasViolations ? { jobIds: violations } : {}),
  });
}
