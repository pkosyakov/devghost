/**
 * GitHub API Client
 * Centralizes authentication, headers, and error handling for GitHub API calls
 */

import prisma from '@/lib/db';
import { auth } from '@/lib/auth';

// ==================== Validation ====================

export const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
export const GITHUB_REPO_REGEX = /^[a-zA-Z0-9._-]{1,100}$/;

export function isValidGitHubOwner(owner: string): boolean {
  return GITHUB_OWNER_REGEX.test(owner) && !owner.includes('--');
}

export function isValidGitHubRepo(repo: string): boolean {
  return GITHUB_REPO_REGEX.test(repo);
}

export function isValidRepoFullName(fullName: string): boolean {
  const parts = fullName.split('/');
  if (parts.length !== 2) return false;
  return isValidGitHubOwner(parts[0]) && isValidGitHubRepo(parts[1]);
}

// ==================== Authenticated User Helper ====================

/**
 * Get the authenticated user with their GitHub token.
 * Looks up by session user ID first, then by email as fallback.
 */
export async function getAuthenticatedGitHubUser() {
  const session = await auth();
  if (!session?.user) return null;

  let user = null;
  if (session.user.id) {
    user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, githubAccessToken: true },
    });
  }

  if (!user && session.user.email) {
    user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { id: true, githubAccessToken: true },
    });
  }

  return user;
}

// ==================== Error Types ====================

export type GitHubErrorCode =
  | 'TOKEN_EXPIRED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNKNOWN';

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: GitHubErrorCode
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export class GitHubClient {
  private baseUrl = 'https://api.github.com';

  constructor(private token: string) {}

  private getHeaders(): HeadersInit {
    return {
      Authorization: `token ${this.token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'DevGhost',
    };
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
      return response.json();
    }

    let code: GitHubErrorCode = 'UNKNOWN';
    let message = response.statusText;

    switch (response.status) {
      case 401:
        code = 'TOKEN_EXPIRED';
        message = 'GitHub token is invalid or expired';
        break;
      case 403:
        const remaining = response.headers.get('X-RateLimit-Remaining');
        if (remaining === '0') {
          code = 'RATE_LIMITED';
          message = 'GitHub API rate limit exceeded';
        } else {
          code = 'FORBIDDEN';
          message = 'Access forbidden';
        }
        break;
      case 404:
        code = 'NOT_FOUND';
        message = 'Resource not found';
        break;
    }

    throw new GitHubApiError(message, response.status, code);
  }

  async get<T>(path: string): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    return this.handleResponse<T>(response);
  }

  /**
   * POST is restricted to /graphql read queries only.
   * SECURITY: We must never modify client repositories via their token.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    // Only allow POST for GraphQL queries (read-only)
    const normalizedPath = path.startsWith('http') ? new URL(path).pathname : path;
    if (normalizedPath !== '/graphql') {
      throw new Error(`SECURITY: POST to ${normalizedPath} is blocked. Only /graphql is allowed.`);
    }
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return this.handleResponse<T>(response);
  }

  /**
   * Fetch all pages of a paginated GitHub API endpoint
   */
  async paginate<T>(path: string, options?: { maxPages?: number }): Promise<T[]> {
    const maxPages = options?.maxPages ?? 10;
    const results: T[] = [];
    let url: string | null = path.startsWith('http')
      ? path
      : `${this.baseUrl}${path}`;
    let page = 0;

    while (url && page < maxPages) {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        await this.handleResponse(response);
      }

      const data = await response.json();
      results.push(...(Array.isArray(data) ? data : [data]));

      // Check for next page in Link header
      const linkHeader = response.headers.get('Link');
      url = this.parseNextLink(linkHeader);
      page++;
    }

    return results;
  }

  /**
   * Get total commit count on default branch via per_page=1 + Link header.
   * Includes merge commits — use as an upper-bound estimate.
   */
  async getCommitCount(owner: string, repo: string): Promise<number | null> {
    const url = `${this.baseUrl}/repos/${owner}/${repo}/commits?per_page=1`;
    const response = await fetch(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });
    if (!response.ok) return null;

    const linkHeader = response.headers.get('Link');
    if (!linkHeader) {
      // Single page — count the items (0 or 1)
      const data = await response.json();
      return Array.isArray(data) ? data.length : null;
    }

    // Consume body to free the connection
    await response.text();

    // Parse rel="last" to get total pages (= total commits with per_page=1)
    const lastMatch = linkHeader.match(/<[^>]+[?&]page=(\d+)[^>]*>;\s*rel="last"/);
    return lastMatch ? parseInt(lastMatch[1]!, 10) : null;
  }

  private parseNextLink(linkHeader: string | null): string | null {
    if (!linkHeader) return null;

    const links = linkHeader.split(',');
    for (const link of links) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match) {
        return match[1];
      }
    }
    return null;
  }
}

/**
 * Factory function to create a GitHubClient from a user's stored token
 */
export async function createGitHubClient(
  userId: string,
  prisma: { user: { findUnique: Function } }
): Promise<GitHubClient | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { githubAccessToken: true },
  });

  if (!user?.githubAccessToken) {
    return null;
  }

  return new GitHubClient(user.githubAccessToken);
}
