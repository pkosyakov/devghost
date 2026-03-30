import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { repositoryListQuerySchema } from '@/lib/schemas/repository';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { getRepositoryNamesForScope, resolveActiveScope } from '@/lib/services/active-scope-service';
import type { Prisma } from '@prisma/client';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = repositoryListQuerySchema.safeParse(params);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }
  const parsedScope = activeScopeQuerySchema.safeParse(params);
  if (!parsedScope.success) {
    return apiError(parsedScope.error.errors[0].message, 400);
  }

  const { page, pageSize, sort, sortOrder, language, search, freshness } = parsed.data;
  const resolvedScope = await resolveActiveScope(workspace.id, parsedScope.data, {
    actorUserId: session.user.id,
  });
  const scopedRepositoryNames = await getRepositoryNamesForScope(resolvedScope);

  const scopeWhere: Prisma.RepositoryWhereInput = {
    workspaceId: workspace.id,
  };

  if (scopedRepositoryNames) {
    scopeWhere.fullName = { in: scopedRepositoryNames };
  }

  const where: Prisma.RepositoryWhereInput = {
    ...scopeWhere,
  };

  if (language) {
    where.language = { equals: language, mode: 'insensitive' };
  }

  if (search) {
    where.OR = [
      { fullName: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { owner: { contains: search, mode: 'insensitive' } },
    ];
  }

  // Freshness filter: fresh = analyzed in last 30 days, stale = older, never = never analyzed
  if (freshness === 'fresh') {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    where.lastAnalyzedAt = { gte: thirtyDaysAgo };
  } else if (freshness === 'stale') {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    where.lastAnalyzedAt = { lt: thirtyDaysAgo };
  } else if (freshness === 'never') {
    where.lastAnalyzedAt = null;
  }

  const [total, repositories] = await Promise.all([
    prisma.repository.count({ where }),
    prisma.repository.findMany({
      where,
      orderBy: { [sort]: sortOrder },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // Compute freshness status per repository
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const rows = repositories.map((r) => {
    let freshnessStatus: 'fresh' | 'stale' | 'never';
    if (!r.lastAnalyzedAt) {
      freshnessStatus = 'never';
    } else if (r.lastAnalyzedAt >= thirtyDaysAgo) {
      freshnessStatus = 'fresh';
    } else {
      freshnessStatus = 'stale';
    }

    return {
      id: r.id,
      provider: r.provider,
      fullName: r.fullName,
      name: r.name,
      owner: r.owner,
      language: r.language,
      stars: r.stars,
      isPrivate: r.isPrivate,
      defaultBranch: r.defaultBranch,
      freshnessStatus,
      lastAnalyzedAt: r.lastAnalyzedAt,
      lastCommitAt: r.lastCommitAt,
      totalCommits: r.totalCommits,
      contributorCount: r.contributorCount,
    };
  });

  // Summary stats — counts across entire workspace, not just current page
  const summaryWhere = {
    workspaceId: workspace.id,
    ...(scopeWhere.fullName ? { fullName: scopeWhere.fullName } : {}),
  };
  const [totalAll, freshCount, neverCount, languageCounts] = await Promise.all([
    prisma.repository.count({ where: summaryWhere }),
    prisma.repository.count({ where: { ...summaryWhere, lastAnalyzedAt: { gte: thirtyDaysAgo } } }),
    prisma.repository.count({ where: { ...summaryWhere, lastAnalyzedAt: null } }),
    prisma.repository.groupBy({
      by: ['language'],
      where: { ...summaryWhere, language: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    }),
  ]);

  return apiResponse({
    repositories: rows,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
    summary: {
      totalRepositories: totalAll,
      freshCount,
      staleCount: totalAll - freshCount - neverCount,
      neverCount,
      languages: languageCounts.map((l) => ({
        language: l.language,
        count: l._count.id,
      })),
    },
  });
}
