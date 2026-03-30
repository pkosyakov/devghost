import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const repository = await prisma.repository.findFirst({
    where: { id, workspaceId: workspace.id },
  });

  if (!repository) {
    return apiError('Repository not found', 404);
  }

  // Freshness status
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  let freshnessStatus: 'fresh' | 'stale' | 'never';
  if (!repository.lastAnalyzedAt) {
    freshnessStatus = 'never';
  } else if (repository.lastAnalyzedAt >= thirtyDaysAgo) {
    freshnessStatus = 'fresh';
  } else {
    freshnessStatus = 'stale';
  }

  // Fetch all commits for this repo, then deduplicate by commitHash
  // (same commit can appear in multiple orders for the same repo)
  const allCommits = await prisma.commitAnalysis.findMany({
    where: {
      order: { userId: workspace.ownerId },
      repository: repository.fullName,
    },
    select: {
      commitHash: true,
      commitMessage: true,
      authorEmail: true,
      authorName: true,
      authorDate: true,
      effortHours: true,
      category: true,
      complexity: true,
    },
    orderBy: { authorDate: 'desc' },
    take: 10000, // Safety bound — typical repos have hundreds to low thousands
  });

  // Deduplicate by commitHash — keep first occurrence (most recent by authorDate)
  const seenHashes = new Set<string>();
  const uniqueCommits = allCommits.filter((c) => {
    if (seenHashes.has(c.commitHash)) return false;
    seenHashes.add(c.commitHash);
    return true;
  });

  // Aggregate by authorEmail from deduplicated commits
  const authorAgg = new Map<string, { count: number; maxDate: Date | null; name: string | null }>();
  for (const c of uniqueCommits) {
    const existing = authorAgg.get(c.authorEmail);
    if (existing) {
      existing.count++;
      if (c.authorDate && (!existing.maxDate || c.authorDate > existing.maxDate)) {
        existing.maxDate = c.authorDate;
      }
    } else {
      // First occurrence is the most recent (ordered by authorDate desc)
      authorAgg.set(c.authorEmail, { count: 1, maxDate: c.authorDate, name: c.authorName });
    }
  }

  // Resolve emails to canonical contributors via ContributorAlias
  const authorEmails = Array.from(authorAgg.keys());
  const aliases = await prisma.contributorAlias.findMany({
    where: {
      workspaceId: workspace.id,
      email: { in: authorEmails },
      contributorId: { not: null },
    },
    select: {
      email: true,
      contributorId: true,
      contributor: {
        select: {
          id: true,
          displayName: true,
          primaryEmail: true,
          classification: true,
          isExcluded: true,
        },
      },
    },
  });

  // Build email-to-contributor lookup
  const emailToContributor = new Map<string, typeof aliases[0]['contributor']>();
  for (const a of aliases) {
    if (a.contributor) {
      emailToContributor.set(a.email, a.contributor);
    }
  }

  // Aggregate commits by canonical contributor (merge aliases of same contributor)
  const contributorMap = new Map<string, {
    contributor: NonNullable<typeof aliases[0]['contributor']>;
    commitCount: number;
    lastActivityAt: Date;
  }>();

  // Unresolved authors — emails without a canonical contributor
  const unresolvedContributors: {
    email: string;
    name: string | null;
    commitCount: number;
    lastActivityAt: Date;
  }[] = [];

  for (const [email, agg] of authorAgg) {
    const contributor = emailToContributor.get(email);
    if (!contributor) {
      unresolvedContributors.push({
        email,
        name: agg.name,
        commitCount: agg.count,
        lastActivityAt: agg.maxDate || new Date(0),
      });
      continue;
    }

    const existing = contributorMap.get(contributor.id);
    if (existing) {
      existing.commitCount += agg.count;
      if (agg.maxDate && agg.maxDate > existing.lastActivityAt) {
        existing.lastActivityAt = agg.maxDate;
      }
    } else {
      contributorMap.set(contributor.id, {
        contributor,
        commitCount: agg.count,
        lastActivityAt: agg.maxDate || new Date(0),
      });
    }
  }

  const contributors = Array.from(contributorMap.values())
    .sort((a, b) => b.commitCount - a.commitCount);
  unresolvedContributors.sort((a, b) => b.commitCount - a.commitCount);

  // Recent activity — first 20 from already-deduplicated commits
  const recentCommits = uniqueCommits.slice(0, 20);

  // Summary metrics from deduplicated data
  const totalCommits = uniqueCommits.length;
  const lastActivity = uniqueCommits.length > 0 ? uniqueCommits[0].authorDate : null;

  return apiResponse({
    repository: {
      id: repository.id,
      provider: repository.provider,
      fullName: repository.fullName,
      name: repository.name,
      owner: repository.owner,
      language: repository.language,
      stars: repository.stars,
      isPrivate: repository.isPrivate,
      defaultBranch: repository.defaultBranch,
      url: repository.url,
      freshnessStatus,
      lastAnalyzedAt: repository.lastAnalyzedAt,
      lastCommitAt: repository.lastCommitAt,
    },
    summaryMetrics: {
      totalCommits,
      contributorCount: contributors.length + unresolvedContributors.length,
      lastActivityAt: lastActivity,
    },
    contributors,
    unresolvedContributors,
    recentActivity: recentCommits,
  });
}
