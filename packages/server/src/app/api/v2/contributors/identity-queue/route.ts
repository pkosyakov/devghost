import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { paginationQuerySchema } from '@/lib/schemas/contributor';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const queryParams = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = paginationQuerySchema.safeParse(queryParams);
  const { page, pageSize } = parsed.success ? parsed.data : { page: 1, pageSize: 20 };

  const [aliases, total, unresolvedCount, suggestedCount] = await Promise.all([
    prisma.contributorAlias.findMany({
      where: {
        workspaceId: workspace.id,
        resolveStatus: { in: ['UNRESOLVED', 'SUGGESTED'] },
      },
      orderBy: { lastSeenAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.contributorAlias.count({
      where: {
        workspaceId: workspace.id,
        resolveStatus: { in: ['UNRESOLVED', 'SUGGESTED'] },
      },
    }),
    prisma.contributorAlias.count({
      where: { workspaceId: workspace.id, resolveStatus: 'UNRESOLVED' },
    }),
    prisma.contributorAlias.count({
      where: { workspaceId: workspace.id, resolveStatus: 'SUGGESTED' },
    }),
  ]);

  return apiResponse({
    aliases: aliases.map((alias) => ({
      alias,
      suggestedContributor: null, // No fuzzy suggestions in slice 1
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
    summary: { unresolvedCount, suggestedCount },
  });
}
