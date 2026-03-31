import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    contributor: { findFirst: vi.fn(), create: vi.fn() },
    contributorAlias: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
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

vi.mock('../workspace-service', () => ({
  ensureWorkspaceForUser: vi.fn(),
}));

import { prisma } from '@/lib/db';
import { ensureWorkspaceForUser } from '../workspace-service';
import { extractAliasesFromOrder, projectContributorsFromOrder } from '../contributor-identity';

// ─── extractAliasesFromOrder — flat seed ───

describe('extractAliasesFromOrder — flat seed', () => {
  it('should extract all selectedDevelopers as primary aliases', () => {
    const order = {
      selectedDevelopers: [
        { email: 'alice@example.com', name: 'Alice', login: 'alice', id: '123' },
        { email: 'bob@example.com', name: 'Bob', login: null },
      ],
      developerMapping: {},
    };

    const aliases = extractAliasesFromOrder(order);
    expect(aliases).toHaveLength(2);
    expect(aliases.every(a => a.source === 'primary')).toBe(true);
  });

  it('should work with empty developerMapping', () => {
    const order = {
      selectedDevelopers: [
        { email: 'dev@example.com', name: 'Dev', login: 'devuser' },
      ],
      developerMapping: {},
    };

    const aliases = extractAliasesFromOrder(order);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].source).toBe('primary');
    expect(aliases[0].email).toBe('dev@example.com');
    expect(aliases[0].username).toBe('devuser');
  });

  it('should work with null/undefined developerMapping', () => {
    const order = {
      selectedDevelopers: [
        { email: 'dev@example.com', name: 'Dev', login: null },
      ],
      developerMapping: null,
    };

    const aliases = extractAliasesFromOrder(order);
    expect(aliases).toHaveLength(1);
  });

  it('should deduplicate by email case-insensitively', () => {
    const order = {
      selectedDevelopers: [
        { email: 'Dev@Example.com', name: 'Dev', login: null },
        { email: 'dev@example.com', name: 'Dev', login: null },
      ],
      developerMapping: {},
    };

    const aliases = extractAliasesFromOrder(order);
    expect(aliases).toHaveLength(1);
  });
});

// ─── projectContributorsFromOrder — flat seed ───

describe('projectContributorsFromOrder — flat seed', () => {
  const workspaceId = 'ws-1';
  const orderId = 'order-1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ensureWorkspaceForUser).mockResolvedValue({ id: workspaceId } as any);
  });

  it('should create new Contributor for each primary candidate with no match', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: orderId,
      userId: 'user-1',
      selectedDevelopers: [
        { email: 'alice@example.com', name: 'Alice', login: 'alice' },
        { email: 'bob@example.com', name: 'Bob', login: null },
      ],
      developerMapping: {},
    } as any);

    // No existing aliases or contributors
    vi.mocked(prisma.contributorAlias.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.contributor.findFirst).mockResolvedValue(null);
    (vi.mocked(prisma.contributor.create) as any).mockImplementation(async ({ data }: any) => ({
      id: `c-${data.primaryEmail}`,
      ...data,
    }));
    vi.mocked(prisma.contributorAlias.create).mockResolvedValue({} as any);

    await projectContributorsFromOrder(orderId);

    // Workspace resolved for correct user
    expect(ensureWorkspaceForUser).toHaveBeenCalledWith('user-1');

    // Should create 2 contributors (not UNRESOLVED)
    expect(prisma.contributor.create).toHaveBeenCalledTimes(2);

    // All alias creates should be AUTO_MERGED with contributor link
    const aliasCalls = vi.mocked(prisma.contributorAlias.create).mock.calls;
    expect(aliasCalls).toHaveLength(2);
    for (const [{ data }] of aliasCalls) {
      expect(data.resolveStatus).toBe('AUTO_MERGED');
      expect(data.contributorId).toBeTruthy();
    }
  });

  it('should NOT create UNRESOLVED aliases for primary seeds', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: orderId,
      userId: 'user-1',
      selectedDevelopers: [
        { email: 'new@example.com', name: 'New Person', login: null },
      ],
      developerMapping: {},
    } as any);

    vi.mocked(prisma.contributorAlias.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.contributor.findFirst).mockResolvedValue(null);
    (vi.mocked(prisma.contributor.create) as any).mockImplementation(async ({ data }: any) => ({
      id: 'c-new', ...data,
    }));
    vi.mocked(prisma.contributorAlias.create).mockResolvedValue({} as any);

    await projectContributorsFromOrder(orderId);

    const aliasCalls = vi.mocked(prisma.contributorAlias.create).mock.calls;
    for (const [{ data }] of aliasCalls) {
      expect(data.resolveStatus).not.toBe('UNRESOLVED');
    }
  });
});
