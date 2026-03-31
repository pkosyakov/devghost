import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import {
  apiResponse,
  apiError,
  parseBody,
  getOrderWithAuth,
  orderAuthError,
} from '@/lib/api-utils';
import { Order, OrderMetric } from '@prisma/client';
import { updateOrderSchema } from '@/lib/schemas';
import { analysisLogger } from '@/lib/logger';

type OrderWithMetrics = Order & { metrics: OrderMetric[] };

// GET /api/orders/[id] - Get single order
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await getOrderWithAuth<OrderWithMetrics>(id, {
      include: {
        metrics: {
          orderBy: [
            { periodType: 'asc' },
            { year: 'desc' },
            { month: 'desc' },
          ],
        },
      },
    });

    if (!result.success) {
      return orderAuthError(result);
    }

    const { order } = result;

    // Resolve first canonical repository for handoff CTA (workspace-scoped)
    let topCanonicalRepoId: string | null = null;
    if (order.status === 'COMPLETED') {
      const repoFullNames = Array.isArray(order.selectedRepos)
        ? (order.selectedRepos as Array<{ full_name?: string; fullName?: string }>)
            .map((r) => r.full_name ?? r.fullName)
            .filter((n): n is string => !!n)
        : [];
      if (repoFullNames.length > 0) {
        const workspace = await prisma.workspace.findUnique({
          where: { ownerId: order.userId },
          select: { id: true },
        });
        if (workspace) {
          const match = await prisma.repository.findFirst({
            where: {
              workspaceId: workspace.id,
              fullName: { in: repoFullNames },
            },
            select: { id: true },
          });
          topCanonicalRepoId = match?.id ?? null;
        }
      }
    }

    return apiResponse({
      ...order,
      topCanonicalRepoId,
      metrics: order.metrics.map((m) => ({
        ...m,
        totalEffortHours: Number(m.totalEffortHours ?? 0),
        avgDailyEffort: Number(m.avgDailyEffort ?? 0),
        ghostPercentRaw: m.ghostPercentRaw != null ? Number(m.ghostPercentRaw) : null,
        ghostPercent: m.ghostPercent != null ? Number(m.ghostPercent) : null,
        share: Number(m.share ?? 1),
      })),
    });
  } catch (error) {
    analysisLogger.error({ err: error }, 'Error fetching order');
    return apiError('Failed to fetch order', 500);
  }
}

// PUT /api/orders/[id] - Update order
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await getOrderWithAuth(id);
    if (!result.success) {
      return orderAuthError(result);
    }

    const parsed = await parseBody(request, updateOrderSchema);
    if (!parsed.success) return parsed.error;
    const {
      name,
      selectedRepos,
      selectedDevelopers,
      developerMapping,
      analysisPeriodMode,
      analysisYears,
      analysisStartDate,
      analysisEndDate,
      analysisCommitLimit,
    } = parsed.data;

    // Semantic date range validation
    if (analysisPeriodMode === 'DATE_RANGE' && analysisStartDate && analysisEndDate) {
      const start = new Date(analysisStartDate);
      const end = new Date(analysisEndDate);
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return apiError('Invalid date format', 400);
      }
      if (start > end) {
        return apiError('Start date must be before end date', 400);
      }
    }

    const updateData: Record<string, unknown> = {};

    if (name !== undefined) updateData.name = name;
    if (selectedRepos !== undefined) {
      updateData.selectedRepos = selectedRepos;
      updateData.repositoriesTotal = selectedRepos.length;
    }
    if (selectedDevelopers !== undefined) updateData.selectedDevelopers = selectedDevelopers;
    if (developerMapping !== undefined) updateData.developerMapping = developerMapping;
    if (analysisPeriodMode !== undefined) updateData.analysisPeriodMode = analysisPeriodMode;
    if (analysisYears !== undefined) updateData.analysisYears = analysisYears;
    if (analysisStartDate !== undefined) {
      updateData.analysisStartDate = analysisStartDate ? new Date(analysisStartDate) : null;
    }
    if (analysisEndDate !== undefined) {
      updateData.analysisEndDate = analysisEndDate ? new Date(analysisEndDate) : null;
    }
    if (analysisCommitLimit !== undefined) {
      updateData.analysisCommitLimit = analysisCommitLimit ?? null;
    }
    const updated = await prisma.order.update({
      where: { id },
      data: updateData,
    });

    return apiResponse(updated);
  } catch (error) {
    analysisLogger.error({ err: error }, 'Error updating order');
    return apiError('Failed to update order', 500);
  }
}

// DELETE /api/orders/[id] - Delete order
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await getOrderWithAuth(id);
    if (!result.success) {
      return orderAuthError(result);
    }

    await prisma.order.delete({ where: { id } });

    return apiResponse({ deleted: true });
  } catch (error) {
    analysisLogger.error({ err: error }, 'Error deleting order');
    return apiError('Failed to delete order', 500);
  }
}
