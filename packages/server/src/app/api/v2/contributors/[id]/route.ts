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

  // Summary metrics from CommitAnalysis
  const aliasEmails = contributor.aliases.map((a) => a.email);
  const commitAnalyses = await prisma.commitAnalysis.findMany({
    where: {
      order: { userId: session.user.id },
      authorEmail: { in: aliasEmails },
    },
    select: {
      id: true,
      repository: true,
      authorDate: true,
      effortHours: true,
    },
  });

  // Repository breakdown
  const repoMap = new Map<string, { commitCount: number; lastActivityAt: Date }>();
  for (const ca of commitAnalyses) {
    const repo = ca.repository || 'unknown';
    const existing = repoMap.get(repo);
    if (existing) {
      existing.commitCount++;
      if (ca.authorDate && ca.authorDate > existing.lastActivityAt) {
        existing.lastActivityAt = ca.authorDate;
      }
    } else {
      repoMap.set(repo, {
        commitCount: 1,
        lastActivityAt: ca.authorDate || new Date(0),
      });
    }
  }

  const repositoryBreakdown = Array.from(repoMap.entries())
    .map(([repoName, data]) => ({
      repoName,
      commitCount: data.commitCount,
      lastActivityAt: data.lastActivityAt,
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

  const lastActivity = commitAnalyses.reduce<Date | null>((latest, ca) => {
    if (!ca.authorDate) return latest;
    return latest && latest > ca.authorDate ? latest : ca.authorDate;
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
      totalCommits: commitAnalyses.length,
      activeRepositoryCount: repoMap.size,
      lastActivityAt: lastActivity,
    },
    repositoryBreakdown,
    identityHealth,
    potentialMatches,
  });
}
