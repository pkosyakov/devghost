import { NextRequest } from 'next/server';
import { apiResponse, apiError } from '@/lib/api-utils';
import { isValidGitHubOwner, isValidGitHubRepo } from '@/lib/github-client';
import { checkRateLimit } from '@/lib/rate-limit';
import { gitLogger } from '@/lib/logger';

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  clone_url: string;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  created_at: string;
  pushed_at: string;
  size: number;
  private: boolean;
  default_branch: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

/**
 * Parse GitHub repository input (URL or owner/repo format)
 * Supports:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - github.com/owner/repo
 * - owner/repo
 */
function parseRepoInput(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim();

  // Try to parse as URL
  const urlPatterns = [
    /^https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/,
    /^github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/,
  ];

  for (const pattern of urlPatterns) {
    const match = trimmed.match(pattern);
    if (match) {
      return { owner: match[1], repo: match[2] };
    }
  }

  // Try to parse as owner/repo format
  const shortPattern = /^([^\/]+)\/([^\/]+)$/;
  const shortMatch = trimmed.match(shortPattern);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2] };
  }

  return null;
}

// GET /api/github/public?repo=owner/repo
// Validates and returns metadata for a public GitHub repository
// Does NOT require authentication
export async function GET(request: NextRequest) {
  // Rate limit: 3 req/hour per IP (unauthenticated endpoint)
  const rateLimited = await checkRateLimit(request, 'analysis');
  if (rateLimited) return rateLimited;

  try {
    const searchParams = request.nextUrl.searchParams;
    const repoInput = searchParams.get('repo');

    if (!repoInput) {
      return apiError('Missing "repo" parameter. Use format: owner/repo or GitHub URL', 400);
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
      return apiError(
        'Invalid repository format. Use: owner/repo or https://github.com/owner/repo',
        400
      );
    }

    const { owner, repo } = parsed;

    // Security: Validate owner/repo format to prevent path traversal
    if (!isValidGitHubOwner(owner)) {
      return apiError('Invalid repository owner format', 400);
    }
    if (!isValidGitHubRepo(repo)) {
      return apiError('Invalid repository name format', 400);
    }

    // Fetch repository from GitHub API (no auth required for public repos)
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'DevGhost',
        },
        // Add cache to reduce rate limit impact
        next: { revalidate: 300 }, // Cache for 5 minutes
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return apiError(
          `Repository "${owner}/${repo}" not found. Make sure it exists and is public.`,
          404
        );
      }
      if (response.status === 403) {
        const rateLimitRemaining = response.headers.get('X-RateLimit-Remaining');
        const rateLimitReset = response.headers.get('X-RateLimit-Reset');

        if (rateLimitRemaining === '0') {
          const resetTime = rateLimitReset
            ? new Date(parseInt(rateLimitReset) * 1000).toLocaleTimeString()
            : 'soon';
          return apiError(
            `GitHub API rate limit exceeded. Try again after ${resetTime}. Connect your GitHub account for higher limits.`,
            429
          );
        }
        return apiError('GitHub API access forbidden', 403);
      }
      return apiError(`GitHub API error: ${response.statusText}`, response.status);
    }

    const repoData: GitHubRepo = await response.json();

    // Check if repository is private
    if (repoData.private) {
      return apiError(
        `Repository "${owner}/${repo}" is private. Connect your GitHub account to access private repositories.`,
        403
      );
    }

    // Fetch contributors count (using pagination trick for efficiency)
    let contributorsCount: number | null = null;
    try {
      const contribResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=1&anon=1`,
        {
          headers: {
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'DevGhost',
          },
          next: { revalidate: 300 },
        }
      );
      if (contribResponse.ok) {
        // Parse Link header to get total count
        const linkHeader = contribResponse.headers.get('Link');
        if (linkHeader) {
          const lastMatch = linkHeader.match(/page=(\d+)>; rel="last"/);
          if (lastMatch) {
            contributorsCount = parseInt(lastMatch[1], 10);
          }
        }
        // If no pagination, count from response
        if (contributorsCount === null) {
          const contribs = await contribResponse.json();
          contributorsCount = Array.isArray(contribs) ? contribs.length : null;
        }
      }
    } catch {
      // Ignore contributor fetch errors
    }

    // Return repository in the same format as /api/github/repos
    return apiResponse({
      repository: {
        id: repoData.id,
        name: repoData.name,
        fullName: repoData.full_name,
        description: repoData.description,
        url: repoData.html_url,
        cloneUrl: repoData.clone_url,
        language: repoData.language,
        stars: repoData.stargazers_count,
        updatedAt: repoData.updated_at,
        createdAt: repoData.created_at,
        pushedAt: repoData.pushed_at,
        sizeKb: repoData.size,
        isPrivate: repoData.private,
        defaultBranch: repoData.default_branch,
        contributorsCount,
        owner: {
          login: repoData.owner.login,
          avatarUrl: repoData.owner.avatar_url,
        },
        source: 'public' as const,
      },
    });
  } catch (error) {
    gitLogger.error({ err: error }, 'Error fetching public GitHub repo');
    return apiError('Failed to fetch repository information', 500);
  }
}
