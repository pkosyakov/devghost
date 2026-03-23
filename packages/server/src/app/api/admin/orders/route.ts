import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, requireAdmin, isErrorResponse } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  const url = request.nextUrl;
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1') || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20') || 20));
  const status = url.searchParams.get('status') ?? '';
  const userId = url.searchParams.get('userId') ?? '';

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (userId) where.userId = userId;

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        id: true,
        name: true,
        status: true,
        selectedRepos: true,
        totalCommits: true,
        createdAt: true,
        completedAt: true,
        errorMessage: true,
        user: { select: { email: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return apiResponse({
    orders: orders.map((o) => ({
      ...o,
      repoCount: Array.isArray(o.selectedRepos) ? (o.selectedRepos as unknown[]).length : 0,
      ownerEmail: o.user.email,
      ownerName: o.user.name,
      user: undefined,
      selectedRepos: undefined,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}
