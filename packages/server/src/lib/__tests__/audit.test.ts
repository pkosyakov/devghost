import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma
vi.mock('@/lib/db', () => ({
  default: {
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'test-id' }),
    },
  },
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
  },
}));

import { auditLog } from '../audit';
import prisma from '@/lib/db';

describe('auditLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates audit log entry with all fields', async () => {
    await auditLog({
      userId: 'user-1',
      action: 'admin.user.block',
      targetType: 'User',
      targetId: 'user-2',
      details: { reason: 'spam' },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        action: 'admin.user.block',
        targetType: 'User',
        targetId: 'user-2',
        details: { reason: 'spam' },
      },
    });
  });

  it('creates audit log entry with minimal fields', async () => {
    await auditLog({ action: 'auth.login' });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: undefined,
        action: 'auth.login',
        targetType: undefined,
        targetId: undefined,
        details: {},
      },
    });
  });

  it('does not throw on DB error (fire-and-forget)', async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(new Error('DB down'));

    await expect(
      auditLog({ action: 'auth.login' })
    ).resolves.toBeUndefined();
  });
});
