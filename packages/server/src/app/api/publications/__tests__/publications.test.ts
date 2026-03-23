import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    repoPublication: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    order: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/api-utils', () => {
  const apiError = vi.fn((msg: string, status: number) => new Response(JSON.stringify({ success: false, error: msg }), { status }));
  return {
    requireUserSession: vi.fn(),
    isErrorResponse: vi.fn((r: any) => r instanceof Response),
    apiResponse: vi.fn((data: any, status: number = 200) => new Response(JSON.stringify({ success: true, data }), { status })),
    apiError,
    parseBody: vi.fn(async (request: Request, schema: any) => {
      let body: unknown;
      try { body = await request.json(); } catch {
        return { success: false, error: apiError('Invalid JSON body', 400) };
      }
      const result = schema.safeParse(body);
      if (!result.success) {
        const message = result.error.errors.map((e: any) => e.message).join(', ');
        return { success: false, error: apiError(message, 400) };
      }
      return { success: true, data: result.data };
    }),
  };
});

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn(() => 'new-generated-token'),
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { logger: mockLogger, default: mockLogger };
});

import prisma from '@/lib/db';
import { requireUserSession } from '@/lib/api-utils';
import { GET, POST } from '../route';
import { PATCH, DELETE } from '../[id]/route';

describe('GET /api/publications', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns user publications', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([
      { id: 'pub-1', slug: 'owner/repo', isActive: true },
    ] as any);

    const req = new Request('http://localhost/api/publications');
    const res = await GET(req as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireUserSession).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }) as any
    );

    const req = new Request('http://localhost/api/publications');
    const res = await GET(req as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/publications', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates a publication from a completed order', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      id: 'order-1', userId: 'user-1', status: 'COMPLETED',
      selectedRepos: [{ owner: { login: 'facebook', avatarUrl: '' }, name: 'react', full_name: 'facebook/react' }],
    } as any);

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue(null);

    vi.mocked(prisma.repoPublication.create).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', shareToken: 'tok-123',
    } as any);

    const req = new Request('http://localhost/api/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'facebook/react' }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(res.status).toBe(201);
    expect(prisma.repoPublication.create).toHaveBeenCalled();
  });

  it('rejects duplicate publication for the same repository', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      id: 'order-1', userId: 'user-1', status: 'COMPLETED',
      selectedRepos: [{ owner: { login: 'facebook', avatarUrl: '' }, name: 'react', full_name: 'facebook/react' }],
    } as any);

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'existing-pub', slug: 'facebook/react',
    } as any);

    const req = new Request('http://localhost/api/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'facebook/react' }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(409);
    expect(prisma.repoPublication.create).not.toHaveBeenCalled();
  });

  it('rejects when orderId is missing', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
    } as any);

    const req = new Request('http://localhost/api/publications', {
      method: 'POST',
      body: JSON.stringify({ repository: 'facebook/react' }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('rejects when repository is missing', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
    } as any);

    const req = new Request('http://localhost/api/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1' }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('rejects when order is not found or not completed', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.order.findFirst).mockResolvedValue(null);

    const req = new Request('http://localhost/api/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'facebook/react' }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(404);
  });

  it('rejects invalid repository format', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      id: 'order-1', userId: 'user-1', status: 'COMPLETED',
      selectedRepos: [],
    } as any);

    const req = new Request('http://localhost/api/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'invalid-no-slash' }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('rejects when repository not found in order', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      id: 'order-1', userId: 'user-1', status: 'COMPLETED',
      selectedRepos: [{ owner: { login: 'facebook', avatarUrl: '' }, name: 'react', full_name: 'facebook/react' }],
    } as any);

    const req = new Request('http://localhost/api/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'google/angular' }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });
});

// ── Helpers for [id] route tests ──

function makePatchRequest(id: string, body: Record<string, unknown>) {
  const req = new Request(`http://localhost/api/publications/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return { req, ctx: { params: Promise.resolve({ id }) } };
}

function makeDeleteRequest(id: string) {
  const req = new Request(`http://localhost/api/publications/${id}`, {
    method: 'DELETE',
  });
  return { req, ctx: { params: Promise.resolve({ id }) } };
}

function mockAuthenticatedUser() {
  vi.mocked(requireUserSession).mockResolvedValue({
    user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
  } as any);
}

function mockUnauthenticated() {
  vi.mocked(requireUserSession).mockResolvedValue(
    new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }) as any
  );
}

describe('PATCH /api/publications/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('updates isActive field successfully', async () => {
    mockAuthenticatedUser();

    vi.mocked(prisma.repoPublication.findFirst).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', publishedById: 'user-1', isActive: true,
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', isActive: false,
    } as any);

    const { req, ctx } = makePatchRequest('pub-1', { isActive: false });
    const res = await PATCH(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.repoPublication.update).toHaveBeenCalledWith({
      where: { id: 'pub-1' },
      data: { isActive: false },
    });
  });

  it('updates visibleDevelopers field successfully', async () => {
    mockAuthenticatedUser();

    vi.mocked(prisma.repoPublication.findFirst).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', publishedById: 'user-1',
    } as any);

    const devList = ['dev1@test.com', 'dev2@test.com'];
    vi.mocked(prisma.repoPublication.update).mockResolvedValue({
      id: 'pub-1', visibleDevelopers: devList,
    } as any);

    const { req, ctx } = makePatchRequest('pub-1', { visibleDevelopers: devList });
    const res = await PATCH(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.repoPublication.update).toHaveBeenCalledWith({
      where: { id: 'pub-1' },
      data: { visibleDevelopers: devList },
    });
  });

  it('filters out disallowed fields', async () => {
    mockAuthenticatedUser();

    vi.mocked(prisma.repoPublication.findFirst).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', publishedById: 'user-1',
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({
      id: 'pub-1', isActive: true,
    } as any);

    const { req, ctx } = makePatchRequest('pub-1', {
      isActive: true,
      slug: 'hacked/slug',
      publishedById: 'other-user',
    });
    const res = await PATCH(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(true);
    // Only isActive should be passed, not slug or publishedById
    expect(prisma.repoPublication.update).toHaveBeenCalledWith({
      where: { id: 'pub-1' },
      data: { isActive: true },
    });
  });

  it('rejects when no valid fields are provided', async () => {
    mockAuthenticatedUser();

    vi.mocked(prisma.repoPublication.findFirst).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', publishedById: 'user-1',
    } as any);

    const { req, ctx } = makePatchRequest('pub-1', { slug: 'hacked/slug', title: 'ignored' });
    const res = await PATCH(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
    expect(prisma.repoPublication.update).not.toHaveBeenCalled();
  });

  it('returns 404 when publication not found', async () => {
    mockAuthenticatedUser();

    vi.mocked(prisma.repoPublication.findFirst).mockResolvedValue(null);

    const { req, ctx } = makePatchRequest('nonexistent', { isActive: false });
    const res = await PATCH(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(404);
    expect(prisma.repoPublication.update).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    mockUnauthenticated();

    const { req, ctx } = makePatchRequest('pub-1', { isActive: false });
    const res = await PATCH(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(401);
    expect(prisma.repoPublication.findFirst).not.toHaveBeenCalled();
  });

  it('regenerates shareToken when regenerateToken is true', async () => {
    mockAuthenticatedUser();

    vi.mocked(prisma.repoPublication.findFirst).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', publishedById: 'user-1', shareToken: 'old-token',
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', shareToken: 'new-generated-token',
    } as any);

    const { req, ctx } = makePatchRequest('pub-1', { regenerateToken: true });
    const res = await PATCH(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.repoPublication.update).toHaveBeenCalledWith({
      where: { id: 'pub-1' },
      data: { shareToken: 'new-generated-token' },
    });
  });
});

describe('DELETE /api/publications/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('deletes a publication successfully', async () => {
    mockAuthenticatedUser();

    vi.mocked(prisma.repoPublication.findFirst).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', publishedById: 'user-1',
    } as any);

    vi.mocked(prisma.repoPublication.delete).mockResolvedValue({
      id: 'pub-1',
    } as any);

    const { req, ctx } = makeDeleteRequest('pub-1');
    const res = await DELETE(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data).toEqual({ deleted: true });
    expect(prisma.repoPublication.delete).toHaveBeenCalledWith({
      where: { id: 'pub-1' },
    });
  });

  it('returns 404 when publication not found', async () => {
    mockAuthenticatedUser();

    vi.mocked(prisma.repoPublication.findFirst).mockResolvedValue(null);

    const { req, ctx } = makeDeleteRequest('nonexistent');
    const res = await DELETE(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(404);
    expect(prisma.repoPublication.delete).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    mockUnauthenticated();

    const { req, ctx } = makeDeleteRequest('pub-1');
    const res = await DELETE(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(401);
    expect(prisma.repoPublication.findFirst).not.toHaveBeenCalled();
  });
});
