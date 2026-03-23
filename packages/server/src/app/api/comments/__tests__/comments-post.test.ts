import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    comment: { findMany: vi.fn(), create: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
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
import { POST } from '../route';

function makePostRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/api/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/comments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireUserSession).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }) as any,
    );

    const req = makePostRequest({
      targetType: 'PUBLICATION',
      targetId: 'pub-1',
      content: 'Hello',
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.success).toBe(false);
  });

  it('creates a root comment on active publication', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'user@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      isActive: true,
      publishedById: 'owner-1',
    } as any);

    const createdComment = {
      id: 'comment-1',
      content: 'Great project!',
      targetType: 'PUBLICATION',
      targetId: 'pub-1',
      authorId: 'user-1',
      parentId: null,
      createdAt: new Date('2026-02-26'),
      updatedAt: new Date('2026-02-26'),
      author: { id: 'user-1', name: 'TestUser', role: 'USER' },
    };
    vi.mocked(prisma.comment.create).mockResolvedValue(createdComment as any);

    const req = makePostRequest({
      targetType: 'PUBLICATION',
      targetId: 'pub-1',
      content: 'Great project!',
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('comment-1');
    expect(json.data.content).toBe('Great project!');

    expect(prisma.comment.create).toHaveBeenCalledWith({
      data: {
        content: 'Great project!',
        targetType: 'PUBLICATION',
        targetId: 'pub-1',
        authorId: 'user-1',
        parentId: undefined,
      },
      include: {
        author: { select: { id: true, name: true, role: true } },
      },
    });
  });

  it('rejects comment on inactive publication', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'user@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      isActive: false,
      publishedById: 'owner-1',
    } as any);

    const req = makePostRequest({
      targetType: 'PUBLICATION',
      targetId: 'pub-inactive',
      content: 'Should fail',
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
  });

  it('creates a reply to existing root comment', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-2', email: 'user2@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      isActive: true,
      publishedById: 'owner-1',
    } as any);

    // Parent is a root comment (parentId = null) on the same target
    vi.mocked(prisma.comment.findUnique).mockResolvedValue({
      id: 'parent-1',
      parentId: null,
      targetType: 'PUBLICATION',
      targetId: 'pub-1',
    } as any);

    const createdReply = {
      id: 'reply-1',
      content: 'Thanks for the feedback!',
      targetType: 'PUBLICATION',
      targetId: 'pub-1',
      authorId: 'user-2',
      parentId: 'parent-1',
      createdAt: new Date('2026-02-26'),
      updatedAt: new Date('2026-02-26'),
      author: { id: 'user-2', name: 'User2', role: 'USER' },
    };
    vi.mocked(prisma.comment.create).mockResolvedValue(createdReply as any);

    const req = makePostRequest({
      targetType: 'PUBLICATION',
      targetId: 'pub-1',
      content: 'Thanks for the feedback!',
      parentId: 'parent-1',
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(res.status).toBe(201);
    expect(json.success).toBe(true);
    expect(json.data.parentId).toBe('parent-1');
  });

  it('rejects reply to a reply (nesting > 1 level)', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-2', email: 'user2@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      isActive: true,
      publishedById: 'owner-1',
    } as any);

    // Parent is itself a reply (parentId is NOT null)
    vi.mocked(prisma.comment.findUnique).mockResolvedValue({
      id: 'reply-1',
      parentId: 'parent-1',
      targetType: 'PUBLICATION',
      targetId: 'pub-1',
    } as any);

    const req = makePostRequest({
      targetType: 'PUBLICATION',
      targetId: 'pub-1',
      content: 'Nested reply should fail',
      parentId: 'reply-1',
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
  });

  it('rejects empty content', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'user@test.com', role: 'USER' },
    } as any);

    const req = makePostRequest({
      targetType: 'PUBLICATION',
      targetId: 'pub-1',
      content: '   ',
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
  });

  it('rejects content over 1000 characters', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'user@test.com', role: 'USER' },
    } as any);

    const longContent = 'a'.repeat(1001);
    const req = makePostRequest({
      targetType: 'PUBLICATION',
      targetId: 'pub-1',
      content: longContent,
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
  });
});
