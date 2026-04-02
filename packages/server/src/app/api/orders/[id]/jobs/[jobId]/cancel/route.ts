import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, getOrderWithAuth, orderAuthError } from '@/lib/api-utils';
import { requestCancel } from '@/lib/services/job-registry';
import { isBillingEnabled, releaseReservedCredits } from '@/lib/services/credit-service';
import { analysisLogger, billingLogger } from '@/lib/logger';

const log = analysisLogger.child({ module: 'cancel-api' });
const CANCELLABLE_STATUSES = ['PENDING', 'RUNNING', 'LLM_COMPLETE'] as const;

// POST /api/orders/[id]/jobs/[jobId]/cancel
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id, jobId } = await params;
  const authResult = await getOrderWithAuth<{ id: string; status: string; userId: string }>(id, {
    select: { id: true, status: true, userId: true },
  });
  if (!authResult.success) return orderAuthError(authResult);
  const { order } = authResult;

  // Verify job exists and belongs to this order
  const job = await prisma.analysisJob.findFirst({
    where: { id: jobId, orderId: id },
    select: { id: true, status: true, type: true, executionMode: true },
  });
  if (!job) return apiError('Job not found', 404);

  if (!CANCELLABLE_STATUSES.includes(job.status as (typeof CANCELLABLE_STATUSES)[number])) {
    return apiError(`Cannot cancel job in ${job.status} state`, 400);
  }

  log.info(
    {
      jobId,
      orderId: id,
      jobType: job.type,
      jobStatus: job.status,
      executionMode: job.executionMode,
    },
    'Cancel requested via API',
  );

  // Local mode: kill process tree / set in-memory cancel flag.
  // Modal mode: worker observes DB status transitions instead.
  if (job.executionMode !== 'modal') {
    requestCancel(jobId);
  }

  const cancelResult = await prisma.analysisJob.updateMany({
    where: {
      id: jobId,
      status: { in: [...CANCELLABLE_STATUSES] },
    },
    data: { status: 'CANCELLED', completedAt: new Date(), currentStep: 'cancelled' },
  });
  if (cancelResult.count === 0) {
    return apiError('Job is no longer cancellable', 409);
  }

  // Release reserved credits (idempotent — safe even if watchdog also calls it)
  if (isBillingEnabled()) {
    try {
      const released = await releaseReservedCredits(order.userId, jobId, id);
      if (released > 0) {
        billingLogger.info({ jobId, orderId: id, released }, 'Credits released on cancel');
      }
    } catch (err) {
      billingLogger.error({ err, jobId, orderId: id }, 'Failed to release credits on cancel');
    }
  }

  // For primary analysis: reset order status so user can retry
  if (job.type === 'analysis' && order.status === 'PROCESSING') {
    const hasMetrics = await prisma.orderMetric.count({ where: { orderId: id } });
    await prisma.order.update({
      where: { id },
      data: {
        status: hasMetrics > 0 ? 'COMPLETED' : 'READY_FOR_ANALYSIS',
        errorMessage: null,
      },
    });
  }

  return apiResponse({ status: 'CANCELLED' });
}
