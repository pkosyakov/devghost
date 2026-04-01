import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, getOrderWithAuth, orderAuthError } from '@/lib/api-utils';
import { analysisLogger } from '@/lib/logger';
import { appendJobEvent } from '@/lib/services/job-event-service';
import { claimAndTriggerModal } from '@/lib/services/modal-trigger';

const log = analysisLogger.child({ module: 'resume-api' });

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
    select: { id: true, status: true, executionMode: true },
  });
  if (!job) return apiError('Job not found', 404);

  // 3. Validate: job must be in FAILED_RETRYABLE status
  if (job.status !== 'FAILED_RETRYABLE') {
    return apiError(`Cannot resume job in ${job.status} state`, 400);
  }

  // 4. Validate failure class: only EXTERNAL_QUOTA jobs can be resumed
  const latestFailureEvent = await prisma.analysisJobEvent.findFirst({
    where: { jobId, code: { startsWith: 'FAILURE_CLASS_' } },
    orderBy: { id: 'desc' },
  });
  const failureClass = latestFailureEvent?.code?.replace('FAILURE_CLASS_', '') ?? 'UNKNOWN';

  if (failureClass !== 'EXTERNAL_QUOTA') {
    return apiError('Only quota-paused jobs can be resumed', 400);
  }

  log.info(
    { jobId, orderId: id, failureClass, executionMode: job.executionMode },
    'Manual resume requested',
  );

  // 5a. Log resume attempt (for audit trail even if CAS fails)
  await appendJobEvent({
    jobId,
    phase: 'resume',
    code: 'MANUAL_RESUME_REQUESTED',
    message: 'Manual resume requested by user',
  });

  // 5. CAS transition: atomic conditional update
  const resumed = await prisma.analysisJob.updateMany({
    where: { id: jobId, status: 'FAILED_RETRYABLE' },
    data: {
      status: 'PENDING',
      error: null,
      lockedBy: null,
      heartbeatAt: null,
      modalCallId: null,
      updatedAt: new Date(),
    },
  });
  if (resumed.count === 0) {
    return apiError('Job state changed, cannot resume', 409);
  }

  // 6. Emit resume event
  await appendJobEvent({
    jobId,
    phase: 'resume',
    code: 'MANUAL_RESUME_ACCEPTED',
    message: 'Manual resume requested and accepted',
  });

  // 7. Trigger Modal via shared claim protocol
  if (job.executionMode === 'modal') {
    await claimAndTriggerModal(jobId);
  }

  // 8. Ensure order is in PROCESSING state (only from expected pre-resume states)
  await prisma.order.updateMany({
    where: { id, status: { in: ['FAILED', 'READY_FOR_ANALYSIS'] } },
    data: { status: 'PROCESSING', errorMessage: null },
  });

  log.info({ jobId, orderId: id }, 'Job resumed successfully');

  // 9. Return response
  return apiResponse({ status: 'RESUMED', jobId });
}
