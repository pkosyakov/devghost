import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = vi.hoisted(() => ({
  order: { findUnique: vi.fn() },
  workspace: { findUnique: vi.fn() },
  contributor: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
  contributorAlias: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  user: { findMany: vi.fn() },
  $transaction: vi.fn((fn: any) => fn(mockPrisma)),
}));

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  analysisLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('./workspace-service', () => ({
  ensureWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1', ownerId: 'user-1' }),
}));

import { extractAliasesFromOrder, computeIdentityHealth } from './contributor-identity';

describe('extractAliasesFromOrder', () => {
  it('extracts seed aliases from selectedDevelopers', () => {
    const order = {
      selectedDevelopers: [
        { name: 'John Doe', email: 'john@example.com', login: 'johndoe' },
        { name: 'Jane Smith', email: 'jane@corp.com' },
      ],
      developerMapping: {},
    };

    const aliases = extractAliasesFromOrder(order as any);

    expect(aliases).toHaveLength(2);
    expect(aliases[0]).toMatchObject({
      email: 'john@example.com',
      displayName: 'John Doe',
      username: 'johndoe',
      providerType: 'github',
      source: 'primary',
    });
    expect(aliases[1]).toMatchObject({
      email: 'jane@corp.com',
      displayName: 'Jane Smith',
      username: undefined,
      source: 'primary',
    });
  });

  it('extracts additional alias hints from developerMapping', () => {
    const order = {
      selectedDevelopers: [
        { name: 'John Doe', email: 'john@example.com', login: 'johndoe' },
      ],
      developerMapping: {
        'john@example.com': {
          primary: { name: 'John Doe', email: 'john@example.com' },
          merged_from: [
            { name: 'J. Doe', email: 'jdoe@old.com' },
          ],
        },
      },
    };

    const aliases = extractAliasesFromOrder(order as any);

    expect(aliases.length).toBeGreaterThanOrEqual(2);
    const primary = aliases.find((a: any) => a.email === 'john@example.com');
    const merged = aliases.find((a: any) => a.email === 'jdoe@old.com');
    expect(primary).toBeDefined();
    expect(merged).toBeDefined();
    expect(primary!.source).toBe('primary');
    expect(merged!.source).toBe('merged_from');
  });

  it('deduplicates aliases by email', () => {
    const order = {
      selectedDevelopers: [
        { name: 'John Doe', email: 'john@example.com' },
      ],
      developerMapping: {
        'john@example.com': {
          primary: { name: 'John Doe', email: 'john@example.com' },
          merged_from: [],
        },
      },
    };

    const aliases = extractAliasesFromOrder(order as any);

    const emailCounts = aliases.filter((a: any) => a.email === 'john@example.com');
    expect(emailCounts).toHaveLength(1);
  });
});

describe('computeIdentityHealth', () => {
  it('returns healthy when all aliases resolved', () => {
    const result = computeIdentityHealth({ resolvedCount: 3, unresolvedCount: 0 });
    expect(result).toEqual({ status: 'healthy', unresolvedAliasCount: 0 });
  });

  it('returns attention when some aliases unresolved', () => {
    const result = computeIdentityHealth({ resolvedCount: 2, unresolvedCount: 1 });
    expect(result).toEqual({ status: 'attention', unresolvedAliasCount: 1 });
  });

  it('returns unresolved when no aliases resolved', () => {
    const result = computeIdentityHealth({ resolvedCount: 0, unresolvedCount: 2 });
    expect(result).toEqual({ status: 'unresolved', unresolvedAliasCount: 2 });
  });
});
