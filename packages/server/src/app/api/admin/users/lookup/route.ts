import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import type { Prisma } from '@prisma/client';

export async function GET(request: NextRequest) {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  const id = request.nextUrl.searchParams.get('id')?.trim();
  const search = request.nextUrl.searchParams.get('search')?.trim() ?? '';

  let where: Prisma.UserWhereInput = { isBlocked: false };

  if (id) {
    where.id = id;
  } else if (search) {
    where.OR = [
      { email: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
    ];
  }

  const users = await prisma.user.findMany({
    where,
    select: { id: true, email: true, name: true, role: true },
    orderBy: { email: 'asc' },
    take: id ? 1 : 20,
  });

  return apiResponse({ users });
}
