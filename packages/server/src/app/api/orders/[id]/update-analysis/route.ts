import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const order = await prisma.order.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!order) return apiError('Order not found', 404);
  if (order.status !== 'COMPLETED') {
    return apiError('Order must be completed before updating', 400);
  }

  // Get last analyzed SHAs from previous job
  const lastJob = await prisma.analysisJob.findFirst({
    where: { orderId: id, status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
  });

  // Create new job with last analyzed SHAs for incremental analysis
  const job = await prisma.analysisJob.create({
    data: {
      orderId: id,
      status: 'PENDING',
      ...(lastJob?.lastAnalyzedShas && { lastAnalyzedShas: lastJob.lastAnalyzedShas }),
    },
  });

  try {
    await processAnalysisJob(job.id);
    return apiResponse({ jobId: job.id, status: 'COMPLETED' });
  } catch (error) {
    return apiError('Update analysis failed', 500);
  }
}
