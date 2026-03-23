import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db', () => ({
  default: {
    comment: { findMany: vi.fn(), count: vi.fn() },
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
import { GET } from '../route';

function makeRequest(params: Record<string, string> = {}): NextRequest {
  const url = new URL('http://localhost/api/comments');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new NextRequest(url);
}

describe('GET /api/comments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 400 when targetType is missing', async () => {
    const req = makeRequest({ targetId: 'pub-1' });
    const res = await GET(req);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('returns 400 when targetId is missing', async () => {
    const req = makeRequest({ targetType: 'PUBLICATION' });
    const res = await GET(req);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('returns 404 for inactive publication', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      isActive: false,
      publishedById: 'user-1',
    } as any);

    const req = makeRequest({ targetType: 'PUBLICATION', targetId: 'pub-1' });
    const res = await GET(req);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(404);
  });

  it('returns 404 when publication does not exist', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue(null);

    const req = makeRequest({ targetType: 'PUBLICATION', targetId: 'pub-nonexistent' });
    const res = await GET(req);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(404);
  });

  it('returns comments for an active publication', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      isActive: true,
      publishedById: 'owner-1',
    } as any);

    // Not authenticated — fine for GET
    vi.mocked(requireUserSession).mockRejectedValue(new Error('Not authenticated'));

    const mockComments = [
      {
        id: 'c-1',
        content: 'Great work!',
        authorId: 'user-2',
        author: { id: 'user-2', name: 'Alice', role: 'USER' },
        createdAt: new Date('2026-02-20'),
        replies: [
          {
            id: 'c-2',
            content: 'Thanks!',
            authorId: 'owner-1',
            author: { id: 'owner-1', name: 'Bob', role: 'USER' },
            createdAt: new Date('2026-02-21'),
          },
        ],
      },
    ];

    vi.mocked(prisma.comment.findMany).mockResolvedValue(mockComments as any);
    vi.mocked(prisma.comment.count).mockResolvedValue(1);

    const req = makeRequest({ targetType: 'PUBLICATION', targetId: 'pub-1' });
    const res = await GET(req);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.comments).toHaveLength(1);
    expect(json.data.total).toBe(1);
    expect(json.data.page).toBe(1);
    expect(json.data.limit).toBe(20);

    // No user authenticated, so canDelete should be false for all
    expect(json.data.comments[0].canDelete).toBe(false);
    expect(json.data.comments[0].replies[0].canDelete).toBe(false);
  });

  it('returns comments for an active profile', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      isActive: true,
      userId: 'profile-owner-1',
    } as any);

    // Not authenticated
    vi.mocked(requireUserSession).mockRejectedValue(new Error('Not authenticated'));

    vi.mocked(prisma.comment.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.comment.count).mockResolvedValue(0);

    const req = makeRequest({ targetType: 'PROFILE', targetId: 'prof-1' });
    const res = await GET(req);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.comments).toHaveLength(0);
    expect(json.data.total).toBe(0);

    expect(prisma.developerProfile.findUnique).toHaveBeenCalledWith({
      where: { id: 'prof-1' },
      select: { isActive: true, userId: true },
    });
  });

  it('sets canDelete=true for comment author', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      isActive: true,
      publishedById: 'owner-1',
    } as any);

    // Authenticated as user-2 (the comment author)
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-2', email: 'alice@test.com', role: 'USER' },
    } as any);

    const mockComments = [
      {
        id: 'c-1',
        content: 'My comment',
        authorId: 'user-2',
        author: { id: 'user-2', name: 'Alice', role: 'USER' },
        createdAt: new Date('2026-02-20'),
        replies: [],
      },
    ];

    vi.mocked(prisma.comment.findMany).mockResolvedValue(mockComments as any);
    vi.mocked(prisma.comment.count).mockResolvedValue(1);

    const req = makeRequest({ targetType: 'PUBLICATION', targetId: 'pub-1' });
    const res = await GET(req);
    const json = await res.json();

    expect(json.data.comments[0].canDelete).toBe(true);
  });

  it('sets canDelete=true for admin user', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      isActive: true,
      publishedById: 'owner-1',
    } as any);

    // Authenticated as admin
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'admin-1', email: 'admin@test.com', role: 'ADMIN' },
    } as any);

    const mockComments = [
      {
        id: 'c-1',
        content: 'Some comment',
        authorId: 'user-2',
        author: { id: 'user-2', name: 'Alice', role: 'USER' },
        createdAt: new Date('2026-02-20'),
        replies: [],
      },
    ];

    vi.mocked(prisma.comment.findMany).mockResolvedValue(mockComments as any);
    vi.mocked(prisma.comment.count).mockResolvedValue(1);

    const req = makeRequest({ targetType: 'PUBLICATION', targetId: 'pub-1' });
    const res = await GET(req);
    const json = await res.json();

    // Admin can delete any comment
    expect(json.data.comments[0].canDelete).toBe(true);
  });

  it('sets canDelete=true for target owner', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      isActive: true,
      publishedById: 'owner-1',
    } as any);

    // Authenticated as the publication owner
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'owner-1', email: 'owner@test.com', role: 'USER' },
    } as any);

    const mockComments = [
      {
        id: 'c-1',
        content: 'Someone else comment',
        authorId: 'user-2',
        author: { id: 'user-2', name: 'Alice', role: 'USER' },
        createdAt: new Date('2026-02-20'),
        replies: [],
      },
    ];

    vi.mocked(prisma.comment.findMany).mockResolvedValue(mockComments as any);
    vi.mocked(prisma.comment.count).mockResolvedValue(1);

    const req = makeRequest({ targetType: 'PUBLICATION', targetId: 'pub-1' });
    const res = await GET(req);
    const json = await res.json();

    // Target owner can delete any comment on their publication
    expect(json.data.comments[0].canDelete).toBe(true);
  });

  it('returns 400 for invalid targetType', async () => {
    const req = makeRequest({ targetType: 'INVALID', targetId: 'pub-1' });
    const res = await GET(req);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });
});
