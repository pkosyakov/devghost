import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, requireAdmin, isErrorResponse } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  const url = request.nextUrl;
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1') || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '30') || 30));
  const actionFilter = url.searchParams.get('action') ?? '';
  const userFilter = url.searchParams.get('userId') ?? '';

  const where: Record<string, unknown> = {};
  if (actionFilter) where.action = { startsWith: actionFilter };
  if (userFilter) where.userId = userFilter;

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return apiResponse({
    entries: entries.map((e) => ({
      id: e.id,
      action: e.action,
      userEmail: e.user?.email ?? null,
      userId: e.userId,
      targetType: e.targetType,
      targetId: e.targetId,
      details: e.details,
      createdAt: e.createdAt,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}
