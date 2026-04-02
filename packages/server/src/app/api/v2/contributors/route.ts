import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveEffectiveUser, isEffectiveUserError } from '@/lib/view-as';
import { computeIdentityHealth } from '@/lib/services/contributor-identity';
import { contributorListQuerySchema } from '@/lib/schemas/contributor';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { getContributorIdsForScope, resolveActiveScope } from '@/lib/services/active-scope-service';
import type { Prisma } from '@prisma/client';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = contributorListQuerySchema.safeParse(params);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }
  const parsedScope = activeScopeQuerySchema.safeParse(params);
  if (!parsedScope.success) {
    return apiError(parsedScope.error.errors[0].message, 400);
  }

  const { page, pageSize, sort, sortOrder, classification, identityHealth, search } = parsed.data;
  const resolvedScope = await resolveActiveScope(workspace.id, parsedScope.data, {
    actorUserId: effective.effectiveUserId,
  });
  const allowedContributorIds = await getContributorIdsForScope(resolvedScope);

  // Build where clause
  const where: Prisma.ContributorWhereInput = {
    workspaceId: workspace.id,
  };

  if (allowedContributorIds) {
    where.id = { in: allowedContributorIds };
  }

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

  // DB-level identity health filter using alias resolveStatus
  if (identityHealth === 'healthy') {
    // No UNRESOLVED or SUGGESTED aliases
    where.aliases = { none: { resolveStatus: { in: ['UNRESOLVED', 'SUGGESTED'] } } };
  } else if (identityHealth === 'attention') {
    // Has both unresolved AND resolved aliases
    where.AND = [
      { aliases: { some: { resolveStatus: { in: ['UNRESOLVED', 'SUGGESTED'] } } } },
      { aliases: { some: { resolveStatus: { in: ['AUTO_MERGED', 'MANUAL'] } } } },
    ];
  } else if (identityHealth === 'unresolved') {
    // Has unresolved aliases but NO resolved ones
    where.AND = [
      { aliases: { some: { resolveStatus: { in: ['UNRESOLVED', 'SUGGESTED'] } } } },
      { aliases: { none: { resolveStatus: { in: ['AUTO_MERGED', 'MANUAL'] } } } },
    ];
  }

  // Get total count (with health filter applied at DB level)
  const total = await prisma.contributor.count({ where });

  // Get contributors with DB-level pagination
  const contributors = await prisma.contributor.findMany({
    where,
    include: {
      aliases: {
        select: { id: true, resolveStatus: true, lastSeenAt: true },
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

  // Compute identity health per contributor
  const rows = contributors.map((c) => {
    const resolvedCount = c.aliases.filter(
      (a) => a.resolveStatus === 'AUTO_MERGED' || a.resolveStatus === 'MANUAL',
    ).length;
    const unresolvedCount = c.aliases.filter(
      (a) => a.resolveStatus === 'UNRESOLVED' || a.resolveStatus === 'SUGGESTED',
    ).length;
    const health = computeIdentityHealth({ resolvedCount, unresolvedCount });

    // Derive last activity from most recent alias lastSeenAt
    const lastSeenDates = c.aliases
      .map((a) => a.lastSeenAt)
      .filter((d): d is Date => d !== null);
    const lastActivityAt = lastSeenDates.length > 0
      ? new Date(Math.max(...lastSeenDates.map((d) => d.getTime())))
      : c.updatedAt;

    return {
      id: c.id,
      displayName: c.displayName,
      primaryEmail: c.primaryEmail,
      classification: c.classification,
      isExcluded: c.isExcluded,
      identityHealth: health,
      aliasCount: c._count.aliases,
      lastActivityAt,
    };
  });

  const summaryWhere: Prisma.ContributorWhereInput = {
    workspaceId: workspace.id,
  };
  if (allowedContributorIds !== null) {
    summaryWhere.id = { in: allowedContributorIds };
  }

  // Identity queue summary
  const identityQueueWhere: Prisma.ContributorAliasWhereInput = {
    workspaceId: workspace.id,
  };
  if (allowedContributorIds) {
    identityQueueWhere.contributorId = { in: allowedContributorIds };
  }

  const unresolvedCount = await prisma.contributorAlias.count({
    where: { ...identityQueueWhere, resolveStatus: 'UNRESOLVED' },
  });
  const suggestedCount = await prisma.contributorAlias.count({
    where: { ...identityQueueWhere, resolveStatus: 'SUGGESTED' },
  });
  const excludedCount = await prisma.contributor.count({
    where: { ...summaryWhere, isExcluded: true },
  });
  const totalContributors = await prisma.contributor.count({ where: summaryWhere });

  return apiResponse({
    contributors: rows,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
    identityQueueSummary: { unresolvedCount, suggestedCount },
    totalContributors,
    excludedCount,
  });
}
