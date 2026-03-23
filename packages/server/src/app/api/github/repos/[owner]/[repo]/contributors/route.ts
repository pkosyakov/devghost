import { NextRequest } from 'next/server';
import { apiResponse, apiError } from '@/lib/api-utils';
import { isValidGitHubOwner, isValidGitHubRepo, getAuthenticatedGitHubUser } from '@/lib/github-client';
import { gitLogger } from '@/lib/logger';

// GET /api/github/repos/[owner]/[repo]/contributors - Get contributors count
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  try {
    const user = await getAuthenticatedGitHubUser();
    if (!user) {
      return apiError('Unauthorized', 401);
    }

    if (!user.githubAccessToken) {
      return apiError('GitHub account not connected', 401);
    }

    const { owner, repo } = await params;

    // Security: Validate owner/repo format to prevent path traversal
    if (!isValidGitHubOwner(owner)) {
      return apiError('Invalid repository owner format', 400);
    }
    if (!isValidGitHubRepo(repo)) {
      return apiError('Invalid repository name format', 400);
    }

    // Fetch contributors from GitHub API (just get count via per_page=1 and anon=1)
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=1&anon=1`,
      {
        headers: {
          Authorization: `token ${user.githubAccessToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'DevGhost',
        },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return apiResponse({ count: 0 });
      }
      return apiError(`GitHub API error: ${response.statusText}`, response.status);
    }

    // Parse Link header to get total count
    const linkHeader = response.headers.get('Link');
    let count = 1;

    if (linkHeader) {
      // Parse last page from Link header: <url>; rel="last"
      const lastMatch = linkHeader.match(/&page=(\d+)[^>]*>;\s*rel="last"/);
      if (lastMatch) {
        count = parseInt(lastMatch[1], 10);
      }
    } else {
      // No pagination means single page - count the response
      const contributors = await response.json();
      count = Array.isArray(contributors) ? contributors.length : 0;
    }

    return apiResponse({ count });
  } catch (error) {
    gitLogger.error({ err: error }, 'Error fetching contributors');
    return apiError('Failed to fetch contributors', 500);
  }
}
