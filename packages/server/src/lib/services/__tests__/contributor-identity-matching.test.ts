import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    contributorAlias: {
      findFirst: vi.fn(),
    },
    contributor: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logger', () => {
  const noopLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => noopLogger,
  };
  return {
    logger: noopLogger,
    analysisLogger: noopLogger,
    pipelineLogger: noopLogger,
    gitLogger: noopLogger,
    billingLogger: noopLogger,
  };
});

import { prisma } from '@/lib/db';
import { findContributorMatch } from '../contributor-identity';

const mockAlias = vi.mocked(prisma.contributorAlias.findFirst);
const mockContributor = vi.mocked(prisma.contributor.findFirst);

const WORKSPACE_ID = 'ws-test';

const makeContributor = (overrides = {}) => ({
  id: 'contributor-1',
  workspaceId: WORKSPACE_ID,
  displayName: 'Alice',
  primaryEmail: 'alice@example.com',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('findContributorMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should match contributor by providerId (Strategy 1)', async () => {
    const contributor = makeContributor();
    mockAlias.mockResolvedValueOnce({ contributor } as any);

    const raw = {
      email: 'alice@example.com',
      displayName: 'Alice',
      username: 'alice',
      providerId: 'gh-123',
      providerType: 'github',
      source: 'primary' as const,
    };

    const result = await findContributorMatch(WORKSPACE_ID, raw);

    expect(result).toEqual(contributor);
    expect(mockAlias).toHaveBeenCalledWith({
      where: {
        workspaceId: WORKSPACE_ID,
        providerType: 'github',
        providerId: 'gh-123',
        contributorId: { not: null },
      },
      include: { contributor: true },
    });
    // Should not reach Strategy 2 or 3
    expect(mockContributor).not.toHaveBeenCalled();
  });

  it('should match contributor by primaryEmail (Strategy 2) when no providerId match', async () => {
    const contributor = makeContributor();
    // Strategy 1 returns null
    mockAlias.mockResolvedValueOnce(null);
    // Strategy 2 returns contributor
    mockContributor.mockResolvedValueOnce(contributor as any);

    const raw = {
      email: 'alice@example.com',
      displayName: 'Alice',
      username: 'alice',
      providerId: 'gh-123',
      providerType: 'github',
      source: 'primary' as const,
    };

    const result = await findContributorMatch(WORKSPACE_ID, raw);

    expect(result).toEqual(contributor);
    expect(mockContributor).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE_ID, primaryEmail: 'alice@example.com' },
    });
    // Should not reach Strategy 3
    expect(mockAlias).toHaveBeenCalledTimes(1);
  });

  it('should match contributor by GitHub login (Strategy 3) when no providerId or email match', async () => {
    const contributor = makeContributor();
    // Strategy 1: providerId lookup returns no match
    mockAlias.mockResolvedValueOnce(null);
    // Strategy 2: primaryEmail lookup returns no match
    mockContributor.mockResolvedValueOnce(null);
    // Strategy 3: login lookup returns a match
    mockAlias.mockResolvedValueOnce({ contributor } as any);

    const raw = {
      email: 'alice-new@example.com',
      displayName: 'Alice',
      username: 'alice',
      providerId: 'gh-123',
      providerType: 'github',
      source: 'merged_from' as const,
    };

    const result = await findContributorMatch(WORKSPACE_ID, raw);

    expect(result).toEqual(contributor);
    // Strategy 3 call: username match
    expect(mockAlias).toHaveBeenNthCalledWith(2, {
      where: {
        workspaceId: WORKSPACE_ID,
        providerType: 'github',
        username: 'alice',
        contributorId: { not: null },
      },
      include: { contributor: true },
    });
  });

  it('should NOT match by login when username is undefined', async () => {
    // Strategy 1 skipped (no providerId), Strategy 2 returns null
    mockContributor.mockResolvedValueOnce(null);

    const raw = {
      email: 'unknown@example.com',
      displayName: 'Unknown',
      username: undefined,
      providerId: undefined,
      providerType: 'github',
      source: 'merged_from' as const,
    };

    const result = await findContributorMatch(WORKSPACE_ID, raw);

    expect(result).toBeNull();
    // contributorAlias.findFirst should never be called (no providerId, no username)
    expect(mockAlias).not.toHaveBeenCalled();
  });

  it('should NOT match by login when username is null/falsy', async () => {
    // Strategy 1 skipped (no providerId), Strategy 2 returns null
    mockContributor.mockResolvedValueOnce(null);

    const raw = {
      email: 'unknown@example.com',
      displayName: 'Unknown',
      username: '' as any,   // empty string — falsy
      providerId: undefined,
      providerType: 'github',
      source: 'merged_from' as const,
    };

    const result = await findContributorMatch(WORKSPACE_ID, raw);

    expect(result).toBeNull();
    expect(mockAlias).not.toHaveBeenCalled();
  });

  it('should return null when all strategies fail', async () => {
    // Strategy 1: providerId lookup returns no match
    mockAlias.mockResolvedValueOnce(null);
    // Strategy 2: primaryEmail lookup returns no match
    mockContributor.mockResolvedValueOnce(null);
    // Strategy 3: login lookup returns no match
    mockAlias.mockResolvedValueOnce({ contributor: null } as any);

    const raw = {
      email: 'ghost@example.com',
      displayName: 'Ghost',
      username: 'ghost-user',
      providerId: 'gh-999',
      providerType: 'github',
      source: 'merged_from' as const,
    };

    const result = await findContributorMatch(WORKSPACE_ID, raw);

    expect(result).toBeNull();
  });
});
