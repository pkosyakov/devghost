import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──

vi.mock('@/lib/db', () => ({
  default: {
    repoPublication: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    order: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/api-utils', () => {
  const apiError = vi.fn((msg: string, status: number) =>
    new Response(JSON.stringify({ success: false, error: msg }), { status }),
  );
  return {
    requireAdmin: vi.fn(),
    isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
    apiResponse: vi.fn((data: unknown, status: number = 200) =>
      new Response(JSON.stringify({ success: true, data }), { status }),
    ),
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

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { logger: mockLogger, default: mockLogger };
});

vi.mock('@/lib/audit', () => ({
  auditLog: vi.fn(),
}));

import prisma from '@/lib/db';
import { requireAdmin } from '@/lib/api-utils';
import { GET, POST } from '../route';
import { PATCH, DELETE } from '../[id]/route';

// ── Helpers ──

function mockAdmin() {
  vi.mocked(requireAdmin).mockResolvedValue({
    user: { id: 'admin-1', email: 'admin@test.com', role: 'ADMIN' },
  } as any);
}

function mockRegularUser() {
  vi.mocked(requireAdmin).mockResolvedValue(
    new Response(JSON.stringify({ success: false, error: 'Forbidden' }), { status: 403 }) as any,
  );
}

function mockUnauthenticated() {
  vi.mocked(requireAdmin).mockResolvedValue(
    new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }) as any,
  );
}

function makePatchRequest(id: string, body: Record<string, unknown>) {
  const req = new Request(`http://localhost/api/admin/publications/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return { req, ctx: { params: Promise.resolve({ id }) } };
}

function makeDeleteRequest(id: string) {
  const req = new Request(`http://localhost/api/admin/publications/${id}`, {
    method: 'DELETE',
  });
  return { req, ctx: { params: Promise.resolve({ id }) } };
}

// ── GET /api/admin/publications ──

describe('GET /api/admin/publications', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns paginated publications list', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([
      { id: 'pub-1', slug: 'facebook/react', isActive: true },
    ] as any);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(1);

    const req = new Request('http://localhost/api/admin/publications');
    const res = await GET(req as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.items).toHaveLength(1);
    expect(json.data.total).toBe(1);
    expect(json.data.page).toBe(1);
    expect(json.data.pageSize).toBe(20);
    expect(json.data.totalPages).toBe(1);
  });

  it('supports pagination parameters', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([]);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(100);

    const req = new Request('http://localhost/api/admin/publications?page=3&pageSize=10');
    const res = await GET(req as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.page).toBe(3);
    expect(json.data.pageSize).toBe(10);
    expect(json.data.totalPages).toBe(10);
    expect(prisma.repoPublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it('handles NaN pagination values gracefully', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([]);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(0);

    const req = new Request('http://localhost/api/admin/publications?page=abc&pageSize=xyz');
    const res = await GET(req as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.page).toBe(1);
    expect(json.data.pageSize).toBe(20);
  });

  it('clamps pageSize to max 50', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([]);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(0);

    const req = new Request('http://localhost/api/admin/publications?pageSize=999');
    const res = await GET(req as any);
    const json = await res.json();

    expect(json.data.pageSize).toBe(50);
  });

  it('filters by search term', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([]);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(0);

    const req = new Request('http://localhost/api/admin/publications?search=react');
    await GET(req as any);

    expect(prisma.repoPublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { slug: { contains: 'react', mode: 'insensitive' } },
            { title: { contains: 'react', mode: 'insensitive' } },
          ],
        }),
      }),
    );
  });

  it('filters by publishType', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([]);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(0);

    const req = new Request('http://localhost/api/admin/publications?type=ADMIN');
    await GET(req as any);

    expect(prisma.repoPublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ publishType: 'ADMIN' }),
      }),
    );
  });

  it('returns 401 when unauthenticated', async () => {
    mockUnauthenticated();

    const req = new Request('http://localhost/api/admin/publications');
    const res = await GET(req as any);

    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    mockRegularUser();

    const req = new Request('http://localhost/api/admin/publications');
    const res = await GET(req as any);

    expect(res.status).toBe(403);
  });
});

// ── POST /api/admin/publications ──

describe('POST /api/admin/publications', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates a publication from a completed order', async () => {
    mockAdmin();

    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      id: 'order-1', status: 'COMPLETED',
      selectedRepos: [{ owner: { login: 'facebook', avatarUrl: '' }, name: 'react', full_name: 'facebook/react' }],
    } as any);

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue(null);

    vi.mocked(prisma.repoPublication.create).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', publishType: 'ADMIN',
    } as any);

    const req = new Request('http://localhost/api/admin/publications', {
      method: 'POST',
      body: JSON.stringify({
        orderId: 'order-1',
        repository: 'facebook/react',
        title: 'React Analysis',
        isFeatured: true,
      }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(res.status).toBe(201);
    expect(prisma.repoPublication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        owner: 'facebook',
        repo: 'react',
        slug: 'facebook/react',
        orderId: 'order-1',
        publishedById: 'admin-1',
        publishType: 'ADMIN',
        title: 'React Analysis',
        isFeatured: true,
      }),
    });
  });

  it('defaults isFeatured to false when not provided', async () => {
    mockAdmin();

    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      id: 'order-1', status: 'COMPLETED',
      selectedRepos: [{ owner: { login: 'facebook', avatarUrl: '' }, name: 'react', full_name: 'facebook/react' }],
    } as any);
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.repoPublication.create).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react',
    } as any);

    const req = new Request('http://localhost/api/admin/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'facebook/react' }),
    });
    await POST(req as any);

    expect(prisma.repoPublication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ isFeatured: false }),
    });
  });

  it('rejects when orderId is missing', async () => {
    mockAdmin();

    const req = new Request('http://localhost/api/admin/publications', {
      method: 'POST',
      body: JSON.stringify({ repository: 'facebook/react' }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(400);
  });

  it('rejects when repository is missing', async () => {
    mockAdmin();

    const req = new Request('http://localhost/api/admin/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1' }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(400);
  });

  it('returns 404 when order is not found or not completed', async () => {
    mockAdmin();

    vi.mocked(prisma.order.findFirst).mockResolvedValue(null);

    const req = new Request('http://localhost/api/admin/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'facebook/react' }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(404);
  });

  it('rejects invalid repository format (no slash)', async () => {
    mockAdmin();

    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      id: 'order-1', status: 'COMPLETED',
    } as any);

    const req = new Request('http://localhost/api/admin/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'noslash' }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('rejects duplicate slug', async () => {
    mockAdmin();

    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      id: 'order-1', status: 'COMPLETED',
      selectedRepos: [{ owner: { login: 'facebook', avatarUrl: '' }, name: 'react', full_name: 'facebook/react' }],
    } as any);

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'existing-pub', slug: 'facebook/react',
    } as any);

    const req = new Request('http://localhost/api/admin/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'facebook/react' }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(409);
    expect(prisma.repoPublication.create).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    mockUnauthenticated();

    const req = new Request('http://localhost/api/admin/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'facebook/react' }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin user', async () => {
    mockRegularUser();

    const req = new Request('http://localhost/api/admin/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'facebook/react' }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(403);
  });
});

// ── PATCH /api/admin/publications/[id] ──

describe('PATCH /api/admin/publications/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('updates isActive field', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', isActive: true,
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({
      id: 'pub-1', isActive: false,
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

  it('updates isFeatured field', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react',
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({
      id: 'pub-1', isFeatured: true,
    } as any);

    const { req, ctx } = makePatchRequest('pub-1', { isFeatured: true });
    const res = await PATCH(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.repoPublication.update).toHaveBeenCalledWith({
      where: { id: 'pub-1' },
      data: { isFeatured: true },
    });
  });

  it('updates title, description, and sortOrder', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react',
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({
      id: 'pub-1', title: 'New Title', description: 'New Desc', sortOrder: 5,
    } as any);

    const { req, ctx } = makePatchRequest('pub-1', {
      title: 'New Title',
      description: 'New Desc',
      sortOrder: 5,
    });
    const res = await PATCH(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.repoPublication.update).toHaveBeenCalledWith({
      where: { id: 'pub-1' },
      data: { title: 'New Title', description: 'New Desc', sortOrder: 5 },
    });
  });

  it('updates visibleDevelopers field', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react',
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

  it('filters out disallowed fields (slug, publishedById, orderId)', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react',
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({
      id: 'pub-1', isActive: true,
    } as any);

    const { req, ctx } = makePatchRequest('pub-1', {
      isActive: true,
      slug: 'hacked/slug',
      publishedById: 'other-user',
      orderId: 'other-order',
    });
    const res = await PATCH(req as any, ctx);

    expect(prisma.repoPublication.update).toHaveBeenCalledWith({
      where: { id: 'pub-1' },
      data: { isActive: true },
    });
  });

  it('rejects when no valid fields are provided', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react',
    } as any);

    const { req, ctx } = makePatchRequest('pub-1', { slug: 'hacked', orderId: 'other' });
    const res = await PATCH(req as any, ctx);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
    expect(prisma.repoPublication.update).not.toHaveBeenCalled();
  });

  it('returns 404 when publication not found', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue(null);

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

    expect(res.status).toBe(401);
    expect(prisma.repoPublication.findUnique).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin user', async () => {
    mockRegularUser();

    const { req, ctx } = makePatchRequest('pub-1', { isActive: false });
    const res = await PATCH(req as any, ctx);

    expect(res.status).toBe(403);
    expect(prisma.repoPublication.findUnique).not.toHaveBeenCalled();
  });
});

// ── DELETE /api/admin/publications/[id] ──

describe('DELETE /api/admin/publications/[id]', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('deletes a publication successfully', async () => {
    mockAdmin();

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react',
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
    mockAdmin();

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue(null);

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

    expect(res.status).toBe(401);
    expect(prisma.repoPublication.findUnique).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin user', async () => {
    mockRegularUser();

    const { req, ctx } = makeDeleteRequest('pub-1');
    const res = await DELETE(req as any, ctx);

    expect(res.status).toBe(403);
    expect(prisma.repoPublication.findUnique).not.toHaveBeenCalled();
  });
});
