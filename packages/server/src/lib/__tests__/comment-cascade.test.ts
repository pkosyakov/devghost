import { describe, it, expect, vi, beforeEach } from 'vitest';

// We test the cascade logic as a standalone function to avoid Prisma middleware complexity
import { deleteCommentsForTarget } from '../comment-utils';

vi.mock('@/lib/db', () => ({
  default: {
    comment: {
      deleteMany: vi.fn(),
    },
  },
}));

import prisma from '@/lib/db';

describe('deleteCommentsForTarget', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('deletes all comments for a PUBLICATION target', async () => {
    vi.mocked(prisma.comment.deleteMany).mockResolvedValue({ count: 5 });

    await deleteCommentsForTarget('PUBLICATION', 'pub-1');

    expect(prisma.comment.deleteMany).toHaveBeenCalledWith({
      where: { targetType: 'PUBLICATION', targetId: 'pub-1' },
    });
  });

  it('deletes all comments for a PROFILE target', async () => {
    vi.mocked(prisma.comment.deleteMany).mockResolvedValue({ count: 3 });

    await deleteCommentsForTarget('PROFILE', 'profile-1');

    expect(prisma.comment.deleteMany).toHaveBeenCalledWith({
      where: { targetType: 'PROFILE', targetId: 'profile-1' },
    });
  });
});
