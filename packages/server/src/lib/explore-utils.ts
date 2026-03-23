import type { ActivityLevel } from '@/types/repository';

export function getActivityLevel(score: number): ActivityLevel {
  if (score >= 10) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

export interface GQLRepoForFilter {
  mentionableUsers: { totalCount: number };
  defaultBranchRef: {
    target: {
      history: { totalCount: number };
    };
  } | null;
}

/**
 * Pre-filter GraphQL results by mentionableUsers (proxy for contributors)
 * and recent commit count (proxy for activity score).
 *
 * Uses wide tolerance bands because mentionableUsers over-counts
 * (includes watchers, issue participants, not just committers).
 */
export function preFilterCandidates<T extends GQLRepoForFilter>(
  repos: T[],
  minContributors: number,
  maxContributors: number,
  minActivityScore: number,
): T[] {
  const mentionableMin = Math.max(1, minContributors - 1);
  const mentionableMax = maxContributors * 3;
  const minRecentCommits = Math.max(1, Math.floor(minActivityScore * 13 * 0.5));

  return repos.filter((repo) => {
    const mentionable = repo.mentionableUsers.totalCount;
    if (!repo.defaultBranchRef) return false;
    if (mentionable < mentionableMin || mentionable > mentionableMax) return false;
    const recentCommits = repo.defaultBranchRef.target.history.totalCount;
    if (recentCommits < minRecentCommits) return false;
    return true;
  });
}
