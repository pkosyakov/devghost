import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma — use vi.hoisted so the variable is available when vi.mock factory runs
const mockPrisma = vi.hoisted(() => ({
  workspace: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: mockPrisma,
}));

import { ensureWorkspaceForUser } from './workspace-service';

describe('ensureWorkspaceForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing workspace if found', async () => {
    const existing = { id: 'ws-1', ownerId: 'user-1', name: 'My Workspace' };
    mockPrisma.workspace.findUnique.mockResolvedValue(existing);

    const result = await ensureWorkspaceForUser('user-1');

    expect(result).toEqual(existing);
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled();
  });

  it('creates new workspace if none exists', async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(null);
    const created = { id: 'ws-2', ownerId: 'user-2', name: 'My Workspace' };
    mockPrisma.workspace.create.mockResolvedValue(created);

    const result = await ensureWorkspaceForUser('user-2');

    expect(result).toEqual(created);
    expect(mockPrisma.workspace.create).toHaveBeenCalledWith({
      data: { ownerId: 'user-2' },
    });
  });

  it('handles race condition (unique constraint) by re-fetching', async () => {
    mockPrisma.workspace.findUnique.mockResolvedValueOnce(null);
    const prismaError = new Error('Unique constraint failed');
    (prismaError as any).code = 'P2002';
    mockPrisma.workspace.create.mockRejectedValue(prismaError);
    const existing = { id: 'ws-3', ownerId: 'user-3', name: 'My Workspace' };
    mockPrisma.workspace.findUnique.mockResolvedValueOnce(existing);

    const result = await ensureWorkspaceForUser('user-3');

    expect(result).toEqual(existing);
  });
});
