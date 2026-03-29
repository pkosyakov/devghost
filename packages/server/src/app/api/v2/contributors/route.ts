import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { computeIdentityHealth } from '@/lib/services/contributor-identity';
import { contributorListQuerySchema } from '@/lib/schemas/contributor';
import type { Prisma } from '@prisma/client';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = contributorListQuerySchema.safeParse(params);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const { page, pageSize, sort, sortOrder, classification, identityHealth, search } = parsed.data;

  // Build where clause
  const where: Prisma.ContributorWhereInput = {
    workspaceId: workspace.id,
  };

  if (classification) {
    const values = classification.split(',').map((v) => v.trim());
    where.classification = { in: values as any[] };
  }

  if (search) {
    where.OR = [
      { displayName: { contains: search, mode: 'insensitive' } },
      { primaryEmail: { contains: search, mode: 'insensitive' } },
    ];
  }

  // Get total count
  const total = await prisma.contributor.count({ where });

  // Get contributors
  const contributors = await prisma.contributor.findMany({
    where,
    include: {
      aliases: {
        select: { id: true, resolveStatus: true },
      },
      _count: {
        select: { aliases: true },
      },
    },
    orderBy:
      sort === 'displayName'
        ? { displayName: sortOrder }
        : sort === 'primaryEmail'
          ? { primaryEmail: sortOrder }
          : { updatedAt: sortOrder }, // lastActivityAt approximated by updatedAt
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  // Compute identity health per contributor and apply filter
  const rows = contributors.map((c) => {
    const resolvedCount = c.aliases.filter(
      (a) => a.resolveStatus === 'AUTO_MERGED' || a.resolveStatus === 'MANUAL',
    ).length;
    const unresolvedCount = c.aliases.filter(
      (a) => a.resolveStatus === 'UNRESOLVED' || a.resolveStatus === 'SUGGESTED',
    ).length;
    const health = computeIdentityHealth({ resolvedCount, unresolvedCount });

    return {
      id: c.id,
      displayName: c.displayName,
      primaryEmail: c.primaryEmail,
      classification: c.classification,
      isExcluded: c.isExcluded,
      identityHealth: health,
      aliasCount: c._count.aliases,
      lastActivityAt: c.updatedAt,
    };
  });

  // Filter by identity health if specified (post-query since it's computed)
  const filtered = identityHealth
    ? rows.filter((r) => r.identityHealth.status === identityHealth)
    : rows;

  // Identity queue summary
  const unresolvedCount = await prisma.contributorAlias.count({
    where: { workspaceId: workspace.id, resolveStatus: 'UNRESOLVED' },
  });
  const suggestedCount = await prisma.contributorAlias.count({
    where: { workspaceId: workspace.id, resolveStatus: 'SUGGESTED' },
  });
  const excludedCount = await prisma.contributor.count({
    where: { workspaceId: workspace.id, isExcluded: true },
  });

  return apiResponse({
    contributors: filtered,
    pagination: {
      page,
      pageSize,
      total: identityHealth ? filtered.length : total,
      totalPages: Math.ceil((identityHealth ? filtered.length : total) / pageSize),
    },
    identityQueueSummary: { unresolvedCount, suggestedCount },
    totalContributors: total,
    excludedCount,
  });
}
