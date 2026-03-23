import { NextRequest } from 'next/server';
import { apiResponse, apiError } from '@/lib/api-utils';
import { isValidRepoFullName, getAuthenticatedGitHubUser } from '@/lib/github-client';
import { gitLogger } from '@/lib/logger';

interface GitHubCommit {
  sha: string;
  commit: {
    author: {
      date: string;
    };
  };
}

// Fetch the oldest or newest commit from a repository
async function fetchCommitBoundary(
  repoFullName: string,
  token: string | null,
  direction: 'asc' | 'desc'
): Promise<string | null> {
  try {
    const url =
      direction === 'asc'
        ? `https://api.github.com/repos/${repoFullName}/commits?per_page=1&page=1`
        : `https://api.github.com/repos/${repoFullName}/commits?per_page=1`;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'DevGhost',
    };
    if (token) {
      headers['Authorization'] = `token ${token}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      gitLogger.error({ repo: repoFullName, status: response.status }, 'Failed to fetch commits');
      return null;
    }

    const commits: GitHubCommit[] = await response.json();
    if (commits.length === 0) {
      return null;
    }

    // For oldest, we need to traverse to the last page
    if (direction === 'asc') {
      const linkHeader = response.headers.get('Link');
      if (linkHeader) {
        const lastMatch = linkHeader.match(/<([^>]+)>;\s*rel="last"/);
        if (lastMatch) {
          const lastPageUrl = lastMatch[1];
          const lastPageResponse = await fetch(lastPageUrl, { headers });

          if (lastPageResponse.ok) {
            const lastPageCommits: GitHubCommit[] = await lastPageResponse.json();
            if (lastPageCommits.length > 0) {
              return lastPageCommits[lastPageCommits.length - 1].commit.author.date;
            }
          }
        }
      }
    }

    return commits[0].commit.author.date;
  } catch (error) {
    gitLogger.error({ err: error, repo: repoFullName }, 'Error fetching commit boundary');
    return null;
  }
}

// GET /api/github/repos/date-range?repos=owner/repo1,owner/repo2
// Returns the min and max commit dates across all specified repositories
export async function GET(request: NextRequest) {
  try {
    // Try to get auth token for higher rate limits; proceed without if unavailable
    let token: string | null = null;
    try {
      const user = await getAuthenticatedGitHubUser();
      token = user?.githubAccessToken ?? null;
    } catch {
      // No auth — proceed anonymously
    }

    const searchParams = request.nextUrl.searchParams;
    const reposParam = searchParams.get('repos');

    if (!reposParam) {
      return apiError('repos parameter is required', 400);
    }

    const repos = reposParam.split(',').filter((r) => r.trim());
    if (repos.length === 0) {
      return apiError('At least one repository is required', 400);
    }

    // Security: Validate all repo names to prevent path traversal
    const invalidRepos = repos.filter((r) => !isValidRepoFullName(r.trim()));
    if (invalidRepos.length > 0) {
      return apiError(`Invalid repository format: ${invalidRepos.join(', ')}`, 400);
    }

    // Limit the number of repos to prevent rate limiting issues
    const reposToProcess = repos.slice(0, 10);

    // Fetch date boundaries for all repositories in parallel
    const datePromises = reposToProcess.flatMap((repo) => [
      fetchCommitBoundary(repo.trim(), token, 'asc'), // oldest
      fetchCommitBoundary(repo.trim(), token, 'desc'), // newest
    ]);

    const dates = await Promise.all(datePromises);

    // Filter out nulls and convert to Date objects
    const validDates = dates
      .filter((d): d is string => d !== null)
      .map((d) => new Date(d));

    if (validDates.length === 0) {
      return apiError('Could not determine date range from repositories', 404);
    }

    // Find min and max dates
    const minDate = new Date(Math.min(...validDates.map((d) => d.getTime())));
    const maxDate = new Date(Math.max(...validDates.map((d) => d.getTime())));

    return apiResponse({
      minDate: minDate.toISOString(),
      maxDate: maxDate.toISOString(),
      repositoriesProcessed: reposToProcess.length,
    });
  } catch (error) {
    gitLogger.error({ err: error }, 'Error fetching date range');
    return apiError('Failed to fetch date range', 500);
  }
}
