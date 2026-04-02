import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveEffectiveUser, isEffectiveUserError } from '@/lib/view-as';
import { paginationQuerySchema } from '@/lib/schemas/contributor';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { getContributorIdsForScope, resolveActiveScope } from '@/lib/services/active-scope-service';
import type { Prisma } from '@prisma/client';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);

  const queryParams = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = paginationQuerySchema.safeParse(queryParams);
  const { page, pageSize } = parsed.success ? parsed.data : { page: 1, pageSize: 20 };
  const parsedScope = activeScopeQuerySchema.safeParse(queryParams);
  const resolvedScope = await resolveActiveScope(
    workspace.id,
    parsedScope.success ? parsedScope.data : {
      scopeKind: 'all_teams',
      repositoryIds: [],
      contributorIds: [],
    },
    {
      actorUserId: effective.effectiveUserId,
    },
  );
  const allowedContributorIds = await getContributorIdsForScope(resolvedScope);

  const where: Prisma.ContributorAliasWhereInput = {
    workspaceId: workspace.id,
    resolveStatus: { in: ['UNRESOLVED', 'SUGGESTED'] },
  };
  if (allowedContributorIds) {
    where.contributorId = { in: allowedContributorIds };
  }

  const unresolvedWhere: Prisma.ContributorAliasWhereInput = {
    ...where,
    resolveStatus: 'UNRESOLVED',
  };
  const suggestedWhere: Prisma.ContributorAliasWhereInput = {
    ...where,
    resolveStatus: 'SUGGESTED',
  };

  const [aliases, total, unresolvedCount, suggestedCount] = await Promise.all([
    prisma.contributorAlias.findMany({
      where,
      orderBy: { lastSeenAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.contributorAlias.count({ where }),
    prisma.contributorAlias.count({ where: unresolvedWhere }),
    prisma.contributorAlias.count({ where: suggestedWhere }),
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
