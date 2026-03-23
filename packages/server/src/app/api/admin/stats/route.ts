import prisma from '@/lib/db';
import { apiResponse, requireAdmin, isErrorResponse } from '@/lib/api-utils';

export async function GET() {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  const [
    totalUsers,
    blockedUsers,
    totalOrders,
    ordersByStatus,
    activeJobs,
    recentAudit,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isBlocked: true } }),
    prisma.order.count(),
    prisma.order.groupBy({
      by: ['status'],
      _count: { id: true },
    }),
    prisma.analysisJob.count({
      where: { status: { in: ['PENDING', 'RUNNING'] } },
    }),
    prisma.auditLog.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true } } },
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const entry of ordersByStatus) {
    statusCounts[entry.status] = entry._count.id;
  }

  return apiResponse({
    users: { total: totalUsers, blocked: blockedUsers, active: totalUsers - blockedUsers },
    orders: {
      total: totalOrders,
      processing: statusCounts['PROCESSING'] ?? 0,
      completed: statusCounts['COMPLETED'] ?? 0,
      failed: statusCounts['FAILED'] ?? 0,
    },
    activeJobs,
    recentAudit: recentAudit.map((entry) => ({
      id: entry.id,
      action: entry.action,
      userEmail: entry.user?.email ?? null,
      targetType: entry.targetType,
      targetId: entry.targetId,
      createdAt: entry.createdAt,
    })),
  });
}
