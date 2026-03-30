import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { computeIdentityHealth } from '@/lib/services/contributor-identity';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const contributor = await prisma.contributor.findFirst({
    where: { id, workspaceId: workspace.id },
    include: {
      aliases: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!contributor) {
    return apiError('Contributor not found', 404);
  }

  // Compute identity health
  const resolvedCount = contributor.aliases.filter(
    (a) => a.resolveStatus === 'AUTO_MERGED' || a.resolveStatus === 'MANUAL',
  ).length;
  const unresolvedCount = contributor.aliases.filter(
    (a) => a.resolveStatus === 'UNRESOLVED' || a.resolveStatus === 'SUGGESTED',
  ).length;
  const identityHealth = computeIdentityHealth({ resolvedCount, unresolvedCount });

  // Summary metrics from CommitAnalysis — DB-level aggregation
  const aliasEmails = contributor.aliases.map((a) => a.email);

  const repoGroups = await prisma.commitAnalysis.groupBy({
    by: ['repository'],
    where: {
      order: { userId: session.user.id },
      authorEmail: { in: aliasEmails },
    },
    _count: { id: true },
    _max: { authorDate: true },
  });

  const totalCommits = repoGroups.reduce((sum, g) => sum + g._count.id, 0);

  const repositoryBreakdown = repoGroups
    .map((g) => ({
      repoName: g.repository || 'unknown',
      commitCount: g._count.id,
      lastActivityAt: g._max.authorDate || new Date(0),
    }))
    .sort((a, b) => b.commitCount - a.commitCount);

  // Potential matches: unresolved aliases with same email domain or from same orders
  const emailDomain = contributor.primaryEmail.split('@')[1];
  const potentialMatches = emailDomain
    ? await prisma.contributorAlias.findMany({
        where: {
          workspaceId: workspace.id,
          contributorId: null,
          resolveStatus: 'UNRESOLVED',
          email: { endsWith: `@${emailDomain}` },
        },
        select: {
          id: true,
          email: true,
          username: true,
          providerType: true,
          lastSeenAt: true,
        },
        take: 10,
      })
    : [];

  const lastActivity = repoGroups.reduce<Date | null>((latest, g) => {
    if (!g._max.authorDate) return latest;
    return latest && latest > g._max.authorDate ? latest : g._max.authorDate;
  }, null);

  return apiResponse({
    contributor: {
      id: contributor.id,
      displayName: contributor.displayName,
      primaryEmail: contributor.primaryEmail,
      classification: contributor.classification,
      isExcluded: contributor.isExcluded,
      excludedAt: contributor.excludedAt,
    },
    aliases: contributor.aliases,
    summaryMetrics: {
      totalCommits,
      activeRepositoryCount: repoGroups.length,
      lastActivityAt: lastActivity,
    },
    repositoryBreakdown,
    identityHealth,
    potentialMatches,
  });
}
