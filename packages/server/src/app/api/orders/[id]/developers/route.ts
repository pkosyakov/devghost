import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import {
  apiResponse,
  apiError,
  getOrderWithAuth,
  orderAuthError,
} from '@/lib/api-utils';
import { analysisLogger } from '@/lib/logger';

interface GitHubCommit {
  sha: string;
  commit: {
    author: {
      name: string;
      email: string;
      date: string;
    };
    message: string;
  };
  author: {
    login: string;
    avatar_url: string;
  } | null;
}

interface ExtractedDeveloper {
  email: string;
  name: string;
  login: string | null;
  avatarUrl: string | null;
  commitCount: number;
  repositories: string[];
  firstCommitAt: string;
  lastCommitAt: string;
}

interface SelectedRepo {
  full_name: string;
  name: string;
}

/**
 * Fetch commits from a GitHub repository
 */
async function fetchRepoCommits(
  repoFullName: string,
  githubToken: string | null,
  since?: string,
  until?: string,
  maxCommits?: number
): Promise<GitHubCommit[]> {
  const commits: GitHubCommit[] = [];
  const perPage = maxCommits ? Math.min(maxCommits, 100) : 100;
  const maxPages = 10;

  for (let page = 1; page <= maxPages; page++) {
    let url = `https://api.github.com/repos/${repoFullName}/commits?per_page=${perPage}&page=${page}`;
    if (since) url += `&since=${since}`;
    if (until) url += `&until=${until}`;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'DevGhost',
    };
    if (githubToken) {
      headers['Authorization'] = `token ${githubToken}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 409) break; // Empty repository
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const pageCommits: GitHubCommit[] = await response.json();
    if (pageCommits.length === 0) break;

    commits.push(...pageCommits);

    // Stop if we've reached the commit limit
    if (maxCommits && commits.length >= maxCommits) {
      return commits.slice(0, maxCommits);
    }

    if (pageCommits.length < perPage) break;
  }

  return commits;
}

/**
 * Extract unique developers from commits using multi-strategy matching
 */
function extractDevelopers(
  commits: GitHubCommit[],
  repoName: string,
  existingDevs: Map<string, ExtractedDeveloper>
): Map<string, ExtractedDeveloper> {
  for (const commit of commits) {
    const email = commit.commit.author.email?.toLowerCase() || '';
    const name = commit.commit.author.name || '';
    const login = commit.author?.login || null;
    const avatarUrl = commit.author?.avatar_url || null;
    const commitDate = commit.commit.author.date;

    if (!email && !name) continue;

    // Multi-strategy matching for deduplication
    let matchKey: string | null = null;

    // Strategy 1: GitHub login (most reliable)
    if (login) {
      for (const [key, dev] of existingDevs.entries()) {
        if (dev.login === login) {
          matchKey = key;
          break;
        }
      }
    }

    // Strategy 2: Exact email match
    if (!matchKey && email) {
      if (existingDevs.has(email)) {
        matchKey = email;
      }
    }

    // Strategy 3: Exact name match (fallback)
    if (!matchKey && name) {
      for (const [key, dev] of existingDevs.entries()) {
        if (dev.name.toLowerCase() === name.toLowerCase()) {
          matchKey = key;
          break;
        }
      }
    }

    if (matchKey) {
      // Update existing developer
      const dev = existingDevs.get(matchKey)!;
      dev.commitCount++;
      if (!dev.repositories.includes(repoName)) {
        dev.repositories.push(repoName);
      }
      // Update login/avatar if we found it
      if (login && !dev.login) dev.login = login;
      if (avatarUrl && !dev.avatarUrl) dev.avatarUrl = avatarUrl;
      // Update date range
      if (commitDate < dev.firstCommitAt) dev.firstCommitAt = commitDate;
      if (commitDate > dev.lastCommitAt) dev.lastCommitAt = commitDate;
    } else {
      // Create new developer entry
      const key = email || name.toLowerCase();
      existingDevs.set(key, {
        email,
        name,
        login,
        avatarUrl,
        commitCount: 1,
        repositories: [repoName],
        firstCommitAt: commitDate,
        lastCommitAt: commitDate,
      });
    }
  }

  return existingDevs;
}

/**
 * Detect potential duplicates for user review
 */
function detectDuplicates(developers: ExtractedDeveloper[]): {
  groups: { id: string; developers: ExtractedDeveloper[]; suggested: boolean }[];
} {
  const groups: { id: string; developers: ExtractedDeveloper[]; suggested: boolean }[] = [];
  const processed = new Set<string>();

  for (let i = 0; i < developers.length; i++) {
    const dev = developers[i];
    const devKey = dev.email || dev.name.toLowerCase();

    if (processed.has(devKey)) continue;

    const similar: ExtractedDeveloper[] = [dev];
    processed.add(devKey);

    // Find similar developers
    for (let j = i + 1; j < developers.length; j++) {
      const other = developers[j];
      const otherKey = other.email || other.name.toLowerCase();

      if (processed.has(otherKey)) continue;

      // Check for similarity
      const isSimilar =
        // Same GitHub login
        (dev.login && other.login && dev.login === other.login) ||
        // Similar name (first initial + last name)
        namesAreSimilar(dev.name, other.name);

      if (isSimilar) {
        similar.push(other);
        processed.add(otherKey);
      }
    }

    groups.push({
      id: `group-${i}`,
      developers: similar,
      suggested: similar.length > 1,
    });
  }

  return { groups };
}

/**
 * Check if two names are similar (handles "John Doe" vs "J. Doe")
 */
function namesAreSimilar(name1: string, name2: string): boolean {
  const n1 = name1.toLowerCase().trim();
  const n2 = name2.toLowerCase().trim();

  if (n1 === n2) return true;

  const parts1 = n1.split(/\s+/);
  const parts2 = n2.split(/\s+/);

  if (parts1.length < 2 || parts2.length < 2) return false;

  const lastName1 = parts1[parts1.length - 1];
  const lastName2 = parts2[parts2.length - 1];

  if (lastName1 !== lastName2) return false;

  // Check first initial
  const first1 = parts1[0];
  const first2 = parts2[0];

  return first1[0] === first2[0];
}

// POST /api/orders/[id]/developers - Extract developers from repositories
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await getOrderWithAuth(id);
    if (!result.success) {
      return orderAuthError(result);
    }

    const { order, session } = result;

    // Get user's GitHub token
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { githubAccessToken: true },
    });

    const accessToken = user?.githubAccessToken ?? null;

    const selectedRepos = order.selectedRepos as unknown as SelectedRepo[];
    if (!selectedRepos || selectedRepos.length === 0) {
      return apiError('No repositories selected', 400);
    }

    // Build date params for period filtering
    let since: string | undefined;
    let until: string | undefined;
    let maxCommits: number | undefined;

    if (order.analysisPeriodMode === 'LAST_N_COMMITS' && order.analysisCommitLimit) {
      // Limit commits per repo, no date filtering
      maxCommits = order.analysisCommitLimit;
    } else if (order.analysisPeriodMode === 'DATE_RANGE' && order.analysisStartDate && order.analysisEndDate) {
      // Use the exact date range specified
      since = order.analysisStartDate.toISOString();
      until = order.analysisEndDate.toISOString();
    } else if (order.analysisPeriodMode === 'SELECTED_YEARS' && order.analysisYears.length > 0) {
      // Legacy support for year-based selection
      const minYear = Math.min(...order.analysisYears);
      const maxYear = Math.max(...order.analysisYears);
      since = `${minYear}-01-01T00:00:00Z`;
      until = `${maxYear + 1}-01-01T00:00:00Z`;
    }
    // For ALL_TIME mode, since/until/maxCommits remain undefined (fetch all commits)

    // Extract developers from all repos (parallel fetching)
    const developersMap = new Map<string, ExtractedDeveloper>();
    let totalCommits = 0;

    // Fetch all repos in parallel for better performance
    const repoResults = await Promise.all(
      selectedRepos.map(async (repo) => {
        try {
          analysisLogger.info({ repo: repo.full_name }, 'Fetching commits');
          const commits = await fetchRepoCommits(
            repo.full_name,
            accessToken,
            since,
            until,
            maxCommits
          );
          return { repoName: repo.full_name, commits, error: null };
        } catch (error) {
          analysisLogger.error({ err: error, repo: repo.full_name }, 'Error fetching commits');
          return { repoName: repo.full_name, commits: [], error };
        }
      })
    );

    // Process results sequentially (extractDevelopers mutates the map)
    for (const result of repoResults) {
      totalCommits += result.commits.length;
      extractDevelopers(result.commits, result.repoName, developersMap);
    }

    const developers = Array.from(developersMap.values());
    developers.sort((a, b) => b.commitCount - a.commitCount);

    // Calculate available date range from all developers
    let minDate: string | null = null;
    let maxDate: string | null = null;
    for (const dev of developers) {
      if (dev.firstCommitAt && (!minDate || dev.firstCommitAt < minDate)) minDate = dev.firstCommitAt;
      if (dev.lastCommitAt && (!maxDate || dev.lastCommitAt > maxDate)) maxDate = dev.lastCommitAt;
    }

    // Detect duplicates
    const duplicates = detectDuplicates(developers);

    // Update order
    await prisma.order.update({
      where: { id },
      data: {
        selectedDevelopers: JSON.parse(JSON.stringify(developers)),
        totalCommits,
        status: 'DEVELOPERS_LOADED',
        availableStartDate: minDate ? new Date(minDate) : null,
        availableEndDate: maxDate ? new Date(maxDate) : null,
      },
    });

    return apiResponse({
      developers,
      duplicateGroups: duplicates.groups,
      totalCommits,
      repositoriesProcessed: selectedRepos.length,
    });
  } catch (error) {
    analysisLogger.error({ err: error }, 'Error extracting developers');
    return apiError('Failed to extract developers', 500);
  }
}
