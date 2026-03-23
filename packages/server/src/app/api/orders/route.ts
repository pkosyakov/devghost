import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import {
  apiResponse,
  apiError,
  parseBody,
  requireUserSession,
  isErrorResponse,
} from '@/lib/api-utils';
import { createOrderSchema } from '@/lib/schemas';
import { logger } from '@/lib/logger';

/** Generate order name from selected repos: "owner/repo" or "owner/a, owner/b" */
function generateOrderName(repos: Array<{ full_name?: string; name?: string }>): string {
  const names = repos.map(r => r.full_name || r.name || 'repo').slice(0, 3);
  let label = names.join(', ');
  if (repos.length > 3) label += ` +${repos.length - 3}`;
  return label;
}

// GET /api/orders - List user's orders
export async function GET() {
  try {
    const session = await requireUserSession();
    if (isErrorResponse(session)) return session;

    const orders = await prisma.order.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        status: true,
        selectedRepos: true,
        selectedDevelopers: true,
        totalCommits: true,
        repositoriesTotal: true,
        repositoriesProcessed: true,
        createdAt: true,
        analyzedAt: true,
        completedAt: true,
      },
    });

    // Fetch ALL_TIME metrics for completed orders in one query
    const completedIds = orders
      .filter((o) => o.status === 'COMPLETED')
      .map((o) => o.id);

    const metricsMap = new Map<string, {
      avgGhostPercent: number;
      totalEffortHours: number;
      totalCommitsAnalyzed: number;
      developerCount: number;
    }>();

    if (completedIds.length > 0) {
      const allMetrics = await prisma.orderMetric.findMany({
        where: {
          orderId: { in: completedIds },
          periodType: 'ALL_TIME',
        },
        select: {
          orderId: true,
          ghostPercent: true,
          totalEffortHours: true,
          commitCount: true,
        },
      });

      // Aggregate per order
      for (const m of allMetrics) {
        const existing = metricsMap.get(m.orderId);
        const ghost = m.ghostPercent != null ? Number(m.ghostPercent) : null;
        const effort = Number(m.totalEffortHours ?? 0);
        const commits = m.commitCount ?? 0;

        if (!existing) {
          metricsMap.set(m.orderId, {
            avgGhostPercent: ghost ?? 0,
            totalEffortHours: effort,
            totalCommitsAnalyzed: commits,
            developerCount: 1,
          });
        } else {
          if (ghost != null) {
            existing.avgGhostPercent =
              (existing.avgGhostPercent * existing.developerCount + ghost) /
              (existing.developerCount + 1);
          }
          existing.totalEffortHours += effort;
          existing.totalCommitsAnalyzed += commits;
          existing.developerCount += 1;
        }
      }
    }

    // Transform for frontend
    const transformed = orders.map((order) => {
      const metrics = metricsMap.get(order.id) ?? null;
      return {
        ...order,
        repoCount: Array.isArray(order.selectedRepos) ? order.selectedRepos.length : 0,
        developerCount: Array.isArray(order.selectedDevelopers) ? order.selectedDevelopers.length : 0,
        metrics: metrics
          ? {
              avgGhostPercent: Math.round(metrics.avgGhostPercent * 10) / 10,
              totalEffortHours: Math.round(metrics.totalEffortHours * 10) / 10,
              totalCommitsAnalyzed: metrics.totalCommitsAnalyzed,
            }
          : null,
      };
    });

    return apiResponse(transformed);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching orders');
    return apiError('Failed to fetch orders', 500);
  }
}

// POST /api/orders - Create new order
export async function POST(request: NextRequest) {
  try {
    const session = await requireUserSession();
    if (isErrorResponse(session)) return session;

    const parsed = await parseBody(request, createOrderSchema);
    if (!parsed.success) return parsed.error;
    const { name, selectedRepos, analysisPeriodMode, analysisStartDate, analysisEndDate, analysisCommitLimit } = parsed.data;

    // Date range validation (semantic: start < end)
    let startDate: Date | null = null;
    let endDate: Date | null = null;
    if (analysisPeriodMode === 'DATE_RANGE' && analysisStartDate && analysisEndDate) {
      startDate = new Date(analysisStartDate);
      endDate = new Date(analysisEndDate);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return apiError('Invalid date format', 400);
      }
      if (startDate > endDate) {
        return apiError('Start date must be before end date', 400);
      }
    }

    const order = await prisma.order.create({
      data: {
        userId: session.user.id,
        name: name || generateOrderName(selectedRepos),
        selectedRepos: selectedRepos,
        repositoriesTotal: selectedRepos.length,
        status: 'DRAFT',
        analysisPeriodMode: analysisPeriodMode || 'ALL_TIME',
        analysisStartDate: startDate,
        analysisEndDate: endDate,
        analysisCommitLimit: analysisCommitLimit ?? null,
      },
    });

    return apiResponse(order, 201);
  } catch (error) {
    logger.error({ err: error }, 'Error creating order');
    return apiError('Failed to create order', 500);
  }
}
