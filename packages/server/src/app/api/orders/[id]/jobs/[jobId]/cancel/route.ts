import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { requestCancel } from '@/lib/services/job-registry';
import { analysisLogger } from '@/lib/logger';

const log = analysisLogger.child({ module: 'cancel-api' });

// POST /api/orders/[id]/jobs/[jobId]/cancel
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id, jobId } = await params;
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  // Verify order ownership
  const order = await prisma.order.findFirst({
    where: { id, userId: session.user.id },
    select: { id: true, status: true },
  });
  if (!order) return apiError('Order not found', 404);

  // Verify job exists and belongs to this order
  const job = await prisma.analysisJob.findFirst({
    where: { id: jobId, orderId: id },
    select: { id: true, status: true, type: true },
  });
  if (!job) return apiError('Job not found', 404);

  if (job.status !== 'PENDING' && job.status !== 'RUNNING') {
    return apiError(`Cannot cancel job in ${job.status} state`, 400);
  }

  log.info({ jobId, orderId: id, jobType: job.type, jobStatus: job.status }, 'Cancel requested via API');

  // Signal cancellation — kills process tree and sets flag for worker
  requestCancel(jobId);

  // Immediately mark job as CANCELLED in DB
  await prisma.analysisJob.update({
    where: { id: jobId },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });

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
