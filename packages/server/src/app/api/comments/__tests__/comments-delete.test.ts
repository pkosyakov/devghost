import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  default: {
    comment: { findUnique: vi.fn(), delete: vi.fn() },
    repoPublication: { findUnique: vi.fn() },
    developerProfile: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn(),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
  apiResponse: vi.fn((data: unknown, status: number = 200) =>
    new Response(JSON.stringify({ success: true, data }), { status }),
  ),
  apiError: vi.fn((msg: string, status: number) =>
    new Response(JSON.stringify({ success: false, error: msg }), { status }),
  ),
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { logger: mockLogger, default: mockLogger };
});

import prisma from '@/lib/db';
import { requireUserSession } from '@/lib/api-utils';
import { DELETE } from '../[id]/route';

function makeDeleteRequest(): NextRequest {
  return new NextRequest(new URL('http://localhost/api/comments/comment-1'), {
    method: 'DELETE',
  });
}

const mockComment = {
  id: 'comment-1',
  content: 'Test comment',
  authorId: 'user-1',
  targetType: 'PUBLICATION',
  targetId: 'pub-1',
  parentId: null,
  createdAt: new Date('2026-02-26'),
  updatedAt: new Date('2026-02-26'),
};

describe('DELETE /api/comments/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows author to delete own comment', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'user@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.comment.findUnique).mockResolvedValue(mockComment as any);
    vi.mocked(prisma.comment.delete).mockResolvedValue(mockComment as any);

    const req = makeDeleteRequest();
    const res = await DELETE(req as any, { params: Promise.resolve({ id: 'comment-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);
    expect(prisma.comment.delete).toHaveBeenCalledWith({ where: { id: 'comment-1' } });
  });

  it('allows admin to delete any comment', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@test.com', role: 'ADMIN' },
    } as any);

    vi.mocked(prisma.comment.findUnique).mockResolvedValue(mockComment as any);
    vi.mocked(prisma.comment.delete).mockResolvedValue(mockComment as any);

    const req = makeDeleteRequest();
    const res = await DELETE(req as any, { params: Promise.resolve({ id: 'comment-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);
    expect(prisma.comment.delete).toHaveBeenCalledWith({ where: { id: 'comment-1' } });
  });

  it('allows publication owner to delete comment on their publication', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'owner-1', email: 'owner@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.comment.findUnique).mockResolvedValue(mockComment as any);
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1',
      publishedById: 'owner-1',
    } as any);
    vi.mocked(prisma.comment.delete).mockResolvedValue(mockComment as any);

    const req = makeDeleteRequest();
    const res = await DELETE(req as any, { params: Promise.resolve({ id: 'comment-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);
  });

  it('allows profile owner to delete comment on their profile', async () => {
    const profileComment = {
      ...mockComment,
      targetType: 'PROFILE',
      targetId: 'prof-1',
    };

    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'profile-owner-1', email: 'profowner@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.comment.findUnique).mockResolvedValue(profileComment as any);
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1',
      userId: 'profile-owner-1',
    } as any);
    vi.mocked(prisma.comment.delete).mockResolvedValue(profileComment as any);

    const req = makeDeleteRequest();
    const res = await DELETE(req as any, { params: Promise.resolve({ id: 'comment-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.deleted).toBe(true);
  });

  it('rejects deletion by non-author non-admin non-owner — 403', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'random-user', email: 'random@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.comment.findUnique).mockResolvedValue(mockComment as any);
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1',
      publishedById: 'owner-1',
    } as any);

    const req = makeDeleteRequest();
    const res = await DELETE(req as any, { params: Promise.resolve({ id: 'comment-1' }) });
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.success).toBe(false);
    expect(prisma.comment.delete).not.toHaveBeenCalled();
  });

  it('returns 404 for non-existent comment', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'user@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.comment.findUnique).mockResolvedValue(null);

    const req = makeDeleteRequest();
    const res = await DELETE(req as any, { params: Promise.resolve({ id: 'nonexistent' }) });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(prisma.comment.delete).not.toHaveBeenCalled();
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireUserSession).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }) as any,
    );

    const req = makeDeleteRequest();
    const res = await DELETE(req as any, { params: Promise.resolve({ id: 'comment-1' }) });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
    expect(prisma.comment.delete).not.toHaveBeenCalled();
  });
});
