import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';
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
  size: number; // Size in KB
  private: boolean;
  owner: {
    login: string;
    avatar_url: string;
  };
}

// GET /api/github/repos - Get user's GitHub repositories
export async function GET(request: NextRequest) {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;

    const user = await prisma.user.findUnique({
      where: { id: result.user.id },
      select: { id: true, githubAccessToken: true },
    });
    if (!user) return apiError('User not found', 404);

    if (!user.githubAccessToken) {
      return apiError('GitHub account not connected. Please connect your GitHub account first.', 401);
    }

    const searchParams = request.nextUrl.searchParams;
    const page = searchParams.get('page') || '1';
    const perPage = searchParams.get('per_page') || '30';
    const sort = searchParams.get('sort') || 'updated';
    const direction = searchParams.get('direction') || 'desc';

    // Fetch repositories from GitHub API
    const response = await fetch(
      `https://api.github.com/user/repos?page=${page}&per_page=${perPage}&sort=${sort}&direction=${direction}`,
      {
        headers: {
          Authorization: `token ${user.githubAccessToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'DevGhost',
        },
      }
    );

    if (!response.ok) {
      if (response.status === 401) {
        // Token expired or revoked
        await prisma.user.update({
          where: { id: user.id },
          data: { githubAccessToken: null },
        });
        return apiError('GitHub token expired. Please reconnect your GitHub account.', 401);
      }
      return apiError(`GitHub API error: ${response.statusText}`, response.status);
    }

    const repos: GitHubRepo[] = await response.json();

    // Get pagination info from headers
    const linkHeader = response.headers.get('Link');
    const hasNextPage = linkHeader?.includes('rel="next"') || false;
    const hasPrevPage = linkHeader?.includes('rel="prev"') || false;

    return apiResponse({
      repositories: repos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        url: repo.html_url,
        cloneUrl: repo.clone_url,
        language: repo.language,
        stars: repo.stargazers_count,
        updatedAt: repo.updated_at,
        createdAt: repo.created_at,
        pushedAt: repo.pushed_at,
        sizeKb: repo.size,
        isPrivate: repo.private,
        owner: {
          login: repo.owner.login,
          avatarUrl: repo.owner.avatar_url,
        },
      })),
      pagination: {
        page: parseInt(page),
        pageSize: parseInt(perPage),
        // GitHub API doesn't provide total count, estimate based on hasNextPage
        totalPages: hasNextPage ? parseInt(page) + 1 : parseInt(page),
        hasNextPage,
        hasPrevPage,
      },
    });
  } catch (error) {
    gitLogger.error({ err: error }, 'Error fetching GitHub repos');
    return apiError('Failed to fetch GitHub repositories', 500);
  }
}
