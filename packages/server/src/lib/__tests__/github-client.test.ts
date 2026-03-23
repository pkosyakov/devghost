import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubClient, GitHubApiError } from '@/lib/github-client';

describe('GitHubClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('includes correct headers in requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });
    global.fetch = mockFetch;

    const client = new GitHubClient('test-token');
    await client.get('/user');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'token test-token',
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'DevGhost',
        }),
      })
    );
  });

  it('throws GitHubApiError on 401', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const client = new GitHubClient('invalid-token');

    await expect(client.get('/user')).rejects.toThrow(GitHubApiError);
    try {
      await client.get('/user');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      expect((error as GitHubApiError).status).toBe(401);
      expect((error as GitHubApiError).code).toBe('TOKEN_EXPIRED');
    }
  });

  it('throws GitHubApiError on 403 rate limit', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Headers({ 'X-RateLimit-Remaining': '0' }),
    });

    const client = new GitHubClient('test-token');

    try {
      await client.get('/user');
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubApiError);
      expect((error as GitHubApiError).status).toBe(403);
      expect((error as GitHubApiError).code).toBe('RATE_LIMITED');
    }
  });

  it('returns data on successful request', async () => {
    const mockData = { login: 'testuser', id: 123 };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData),
    });

    const client = new GitHubClient('test-token');
    const result = await client.get('/user');

    expect(result).toEqual(mockData);
  });
});
