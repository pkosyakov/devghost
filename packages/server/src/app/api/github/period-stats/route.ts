import { NextRequest } from 'next/server';
import { apiResponse, apiError } from '@/lib/api-utils';
import { isValidGitHubOwner, isValidGitHubRepo, getAuthenticatedGitHubUser } from '@/lib/github-client';
import { gitLogger } from '@/lib/logger';

interface CommitAuthor {
  name: string;
  email: string;
  date: string;
}

interface GitHubCommit {
  sha: string;
  commit: {
    author: CommitAuthor;
    committer: CommitAuthor;
    message: string;
  };
  author: {
    login: string;
    avatar_url: string;
  } | null;
}

/**
 * GET /api/github/period-stats
 * Returns commit and developer statistics for a repository within a date range
 *
 * Query params:
 * - owner: Repository owner
 * - repo: Repository name
 * - startDate: ISO date string (optional)
 * - endDate: ISO date string (optional)
 * - limit: Max number of recent commits to consider (optional, for LAST_N_COMMITS mode)
 * - source: 'connected' | 'public' (default: 'public')
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const owner = searchParams.get('owner');
    const repo = searchParams.get('repo');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const limitParam = searchParams.get('limit');
    const commitLimit = limitParam ? parseInt(limitParam, 10) : null;
    const source = searchParams.get('source') || 'public';

    if (!owner || !repo) {
      return apiError('Missing owner or repo parameter', 400);
    }

    // Security: Validate owner/repo format to prevent path traversal
    if (!isValidGitHubOwner(owner)) {
      return apiError('Invalid repository owner format', 400);
    }
    if (!isValidGitHubRepo(repo)) {
      return apiError('Invalid repository name format', 400);
    }

    // Always try to get auth token for higher rate limits (5000/hr vs 60/hr)
    let authToken: string | null = null;
    try {
      const user = await getAuthenticatedGitHubUser();
      authToken = user?.githubAccessToken ?? null;
    } catch {
      // No auth — proceed anonymously (lower rate limits)
    }

    // Build GitHub API URL with date filters
    const params = new URLSearchParams({
      per_page: '100',
    });

    if (startDate) {
      params.append('since', new Date(startDate).toISOString());
    }
    if (endDate) {
      // GitHub API 'until' is exclusive, add one day to include the end date
      const endDateObj = new Date(endDate);
      endDateObj.setDate(endDateObj.getDate() + 1);
      params.append('until', endDateObj.toISOString());
    }

    const headers: HeadersInit = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'DevGhost',
    };

    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    // Fetch commits with pagination to count all
    let page = 1;
    let allCommits: GitHubCommit[] = [];
    const maxPages = 10; // Limit to prevent too many requests

    while (page <= maxPages) {
      params.set('page', page.toString());

      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits?${params.toString()}`,
        {
          headers,
          cache: 'no-store', // Disable cache to ensure fresh data for different date ranges
        }
      );

      if (!response.ok) {
        if (response.status === 404) {
          return apiError(`Repository "${owner}/${repo}" not found`, 404);
        }
        if (response.status === 403) {
          const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
          if (rateLimitRemaining === '0') {
            return apiError('GitHub API rate limit exceeded', 429);
          }
        }
        return apiError(`GitHub API error: ${response.statusText}`, response.status);
      }

      const commits: GitHubCommit[] = await response.json();

      if (commits.length === 0) {
        break;
      }

      allCommits = allCommits.concat(commits);

      // Stop early if we've reached the commit limit
      if (commitLimit && allCommits.length >= commitLimit) {
        allCommits = allCommits.slice(0, commitLimit);
        break;
      }

      // Check if there are more pages
      const linkHeader = response.headers.get('Link');
      if (!linkHeader || !linkHeader.includes('rel="next"')) {
        break;
      }

      page++;
    }

    // Count unique developers by email
    const developerEmails = new Set<string>();
    const developerLogins = new Set<string>();

    for (const commit of allCommits) {
      const authorEmail = commit.commit.author.email;
      if (authorEmail && !authorEmail.includes('noreply.github.com')) {
        developerEmails.add(authorEmail.toLowerCase());
      }

      // Also track by GitHub login if available
      if (commit.author?.login) {
        developerLogins.add(commit.author.login.toLowerCase());
      }
    }

    // Use the larger of the two counts (some devs may not have linked accounts)
    const developersCount = Math.max(developerEmails.size, developerLogins.size);

    return apiResponse({
      commitsCount: allCommits.length,
      developersCount,
      // Indicate if we hit the pagination limit (fetched max pages but might have more)
      isEstimate: page > maxPages,
      // Return date range used (for debugging)
      dateRange: {
        start: startDate || null,
        end: endDate || null,
      },
    });
  } catch (error) {
    gitLogger.error({ err: error }, 'Error fetching period stats');
    return apiError('Failed to fetch period statistics', 500);
  }
}
