import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, getOrderWithAuth, orderAuthError } from '@/lib/api-utils';
import { analysisLogger } from '@/lib/logger';
import { appendJobEvent } from '@/lib/services/job-event-service';
import { claimAndTriggerModal } from '@/lib/services/modal-trigger';

const log = analysisLogger.child({ module: 'resume-api' });

const LEGACY_QUOTA_RE = /quota|rate.?limit|too many requests|429|402/i;

/** Infer failureClass for legacy jobs that predate the typed failureClass column. */
function inferLegacyFailureClass(error: string | null): string | null {
  if (!error) return null;
  return LEGACY_QUOTA_RE.test(error) ? 'EXTERNAL_QUOTA' : null;
}

// POST /api/orders/[id]/jobs/[jobId]/resume
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id, jobId } = await params;

  // 1. Auth check
  const authResult = await getOrderWithAuth<{ id: string; status: string }>(id, {
    select: { id: true, status: true },
  });
  if (!authResult.success) return orderAuthError(authResult);

  // 2. Find the job
  const job = await prisma.analysisJob.findFirst({
    where: { id: jobId, orderId: id },
    select: { id: true, status: true, executionMode: true, failureClass: true, error: true },
  });
  if (!job) return apiError('Job not found', 404);

  // 3. Validate: job must be modal and in FAILED_RETRYABLE status
  if (job.executionMode !== 'modal') {
    return apiError('Resume is only supported for modal jobs', 400);
  }
  if (job.status !== 'FAILED_RETRYABLE') {
    return apiError(`Cannot resume job in ${job.status} state`, 400);
  }

  // 4. Validate failure class: only EXTERNAL_QUOTA jobs can be resumed.
  //    Legacy fallback: pre-migration jobs may have failureClass=null with quota errors in error text.
  const failureClass = job.failureClass
    ?? inferLegacyFailureClass(job.error)
    ?? 'UNKNOWN';

  if (failureClass !== 'EXTERNAL_QUOTA') {
    return apiError('Only quota-paused jobs can be resumed', 400);
  }

  log.info(
    { jobId, orderId: id, failureClass, executionMode: job.executionMode },
    'Manual resume requested',
  );

  // 5. Log resume attempt (for audit trail even if CAS fails)
  await appendJobEvent({
    jobId,
    phase: 'resume',
    code: 'MANUAL_RESUME_REQUESTED',
    message: 'Manual resume requested by user',
  });

  // 6. CAS transition: atomic conditional update.
  //    Guard the exact failureClass we read — typed 'EXTERNAL_QUOTA' or legacy null
  //    (legacy jobs passed the regex check above, CAS still prevents status races).
  const isLegacy = job.failureClass === null;
  const resumed = await prisma.analysisJob.updateMany({
    where: { id: jobId, status: 'FAILED_RETRYABLE', failureClass: isLegacy ? null : 'EXTERNAL_QUOTA' },
    data: {
      status: 'PENDING',
      error: null,
      lockedBy: null,
      heartbeatAt: null,
      modalCallId: null,
      failureClass: null,
      pausedAt: null,
      pauseReason: null,
      updatedAt: new Date(),
    },
  });
  if (resumed.count === 0) {
    return apiError('Job state changed, cannot resume', 409);
  }

  // 7. Emit resume event
  await appendJobEvent({
    jobId,
    phase: 'resume',
    code: 'MANUAL_RESUME_ACCEPTED',
    message: 'Manual resume requested and accepted',
  });

  // 8. Trigger Modal via shared claim protocol (best-effort; watchdog recovers on failure)
  try {
    const triggered = await claimAndTriggerModal(jobId);
    if (!triggered) {
      log.warn({ jobId }, 'Modal trigger failed after CAS — watchdog will retry');
    }
  } catch (err) {
    log.error({ err, jobId }, 'claimAndTriggerModal threw after CAS — watchdog will retry');
  }

  // 9. Ensure order is in PROCESSING state (only from expected pre-resume states)
  await prisma.order.updateMany({
    where: { id, status: { in: ['FAILED', 'READY_FOR_ANALYSIS'] } },
    data: { status: 'PROCESSING', errorMessage: null },
  });

  log.info({ jobId, orderId: id }, 'Job resumed successfully');

  // 10. Return response
  return apiResponse({ status: 'RESUMED', jobId });
}
