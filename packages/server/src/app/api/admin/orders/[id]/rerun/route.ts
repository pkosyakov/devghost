import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { auditLog } from '@/lib/audit';
import { analysisLogger } from '@/lib/logger';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) return apiError('Order not found', 404);

  // Atomically: check status + create job + update order to prevent race conditions
  const job = await prisma.$transaction(async (tx) => {
    const current = await tx.order.findUnique({ where: { id }, select: { status: true } });
    if (current?.status === 'PROCESSING') {
      throw new Error('ALREADY_PROCESSING');
    }

    const newJob = await tx.analysisJob.create({
      data: { orderId: id, status: 'PENDING' },
    });

    await tx.order.update({
      where: { id },
      data: {
        status: 'PROCESSING',
        repositoriesProcessed: 0,
        repositoriesFailed: 0,
        errorMessage: null,
      },
    });

    return newJob;
  }).catch((err) => {
    if (err.message === 'ALREADY_PROCESSING') return null;
    throw err;
  });

  if (!job) {
    return apiError('Analysis already in progress', 409);
  }

  await auditLog({
    userId: session.user.id,
    action: 'admin.order.rerun',
    targetType: 'Order',
    targetId: id,
    details: { jobId: job.id },
  });

  // Fire-and-forget analysis
  processAnalysisJob(job.id).catch((err) => {
    analysisLogger.error({ err, jobId: job.id }, 'Admin rerun failed');
  });

  return apiResponse({ jobId: job.id });
}
