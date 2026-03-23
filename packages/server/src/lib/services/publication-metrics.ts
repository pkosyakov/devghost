/**
 * Publication Metrics Service
 *
 * Computes GhostMetric-compatible data from CommitAnalysis
 * filtered by repository. Used by public API endpoints to display
 * per-repo metrics on published analytics pages.
 */

import prisma from '@/lib/db';
import type { GhostMetric } from '@devghost/shared';
import { calcAutoShare, calcGhostPercent, calcGhostPercentRaw, MIN_WORK_DAYS_FOR_GHOST, spreadEffort } from '@devghost/shared';

export async function computeRepoMetrics(
  orderId: string,
  repository: string,
  visibleDevelopers?: string[] | null,
): Promise<GhostMetric[]> {
  const commits = await prisma.commitAnalysis.findMany({
    where: { orderId, repository },
    select: {
      commitHash: true,
      authorEmail: true,
      authorName: true,
      authorDate: true,
      effortHours: true,
    },
    orderBy: { authorDate: 'asc' },
  });

  if (commits.length === 0) return [];

  // Group by developer
  const devMap = new Map<string, {
    name: string;
    commits: typeof commits;
  }>();

  for (const c of commits) {
    const existing = devMap.get(c.authorEmail);
    if (existing) {
      existing.commits.push(c);
    } else {
      devMap.set(c.authorEmail, { name: c.authorName, commits: [c] });
    }
  }

  // Filter by visibleDevelopers if provided
  const emails = visibleDevelopers
    ? [...devMap.keys()].filter(e => visibleDevelopers.includes(e))
    : [...devMap.keys()];

  const totalCommitsAll = commits.length;

  return emails.map(email => {
    const dev = devMap.get(email)!;
    const devCommits = dev.commits;
    const totalEffort = devCommits.reduce((sum, c) => sum + Number(c.effortHours), 0);

    // Use canonical effort spreading algorithm (matches ghost-metrics-service.ts)
    const spreadResult = spreadEffort(
      devCommits.map(c => ({ sha: c.commitHash, authorDate: c.authorDate, effortHours: Number(c.effortHours) })),
    );
    const workDays = spreadResult.dayMap.size;
    const overheadHours = spreadResult.totalOverhead;

    const avgDaily = workDays > 0 ? totalEffort / workDays : 0;
    const share = calcAutoShare(devCommits.length, totalCommitsAll);

    return {
      developerId: email,
      developerName: dev.name,
      developerEmail: email,
      periodType: 'ALL_TIME' as const,
      totalEffortHours: totalEffort,
      actualWorkDays: workDays,
      avgDailyEffort: avgDaily,
      ghostPercentRaw: calcGhostPercentRaw(totalEffort, workDays),
      ghostPercent: calcGhostPercent(totalEffort, workDays, share),
      share,
      shareAutoCalculated: true,
      commitCount: devCommits.length,
      overheadHours,
      hasEnoughData: workDays >= MIN_WORK_DAYS_FOR_GHOST,
    };
  });
}
