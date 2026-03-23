import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('@/lib/db', () => ({
  default: {
    developerProfile: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/api-utils', () => {
  const apiError = vi.fn((msg: string, status: number) =>
    new Response(JSON.stringify({ success: false, error: msg }), { status }),
  );
  return {
    requireUserSession: vi.fn(),
    isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
    apiResponse: vi.fn((data: unknown, status: number = 200) =>
      new Response(JSON.stringify({ success: true, data }), { status }),
    ),
    apiError,
    parseBody: vi.fn(async (request: Request, schema: any) => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
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

import prisma from '@/lib/db';
import { requireUserSession } from '@/lib/api-utils';
import { GET, POST, PATCH } from '../route';

// ── Helpers ────────────────────────────────────────────────────────

const USER_SESSION = {
  user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
};

function mockAuthenticated() {
  vi.mocked(requireUserSession).mockResolvedValue(USER_SESSION as any);
}

function mockUnauthenticated() {
  vi.mocked(requireUserSession).mockResolvedValue(
    new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }) as any,
  );
}

function makeRequest(method: string, body?: Record<string, unknown>) {
  return new Request('http://localhost/api/profile', {
    method,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// ── GET /api/profile ───────────────────────────────────────────────

describe('GET /api/profile', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns existing profile', async () => {
    mockAuthenticated();

    const profileData = {
      id: 'prof-1',
      userId: 'user-1',
      slug: 'johndoe',
      displayName: 'John Doe',
      bio: 'A developer',
      avatarUrl: 'https://example.com/avatar.jpg',
      includedOrderIds: ['order-1', 'order-2'],
      isActive: true,
      viewCount: 42,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-06-01'),
    };

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(profileData as any);

    const res = await GET(makeRequest('GET') as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.slug).toBe('johndoe');
    expect(json.data.displayName).toBe('John Doe');
    expect(prisma.developerProfile.findUnique).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
  });

  it('returns null when profile does not exist', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(null);

    const res = await GET(makeRequest('GET') as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data).toBeNull();
  });

  it('returns 401 when not authenticated', async () => {
    mockUnauthenticated();

    const res = await GET(makeRequest('GET') as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(401);
    expect(prisma.developerProfile.findUnique).not.toHaveBeenCalled();
  });

  it('returns 500 on unexpected error', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockRejectedValue(new Error('DB connection lost'));

    const res = await GET(makeRequest('GET') as any);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
  });
});

// ── POST /api/profile ──────────────────────────────────────────────

describe('POST /api/profile', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates a new profile with upsert', async () => {
    mockAuthenticated();

    const createdProfile = {
      id: 'prof-1',
      userId: 'user-1',
      slug: 'johndoe',
      displayName: 'John Doe',
      bio: 'A developer',
      avatarUrl: null,
      includedOrderIds: ['order-1'],
      isActive: true,
    };

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(null); // slug not taken
    vi.mocked(prisma.developerProfile.upsert).mockResolvedValue(createdProfile as any);

    const res = await POST(makeRequest('POST', {
      slug: 'johndoe',
      displayName: 'John Doe',
      bio: 'A developer',
      includedOrderIds: ['order-1'],
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.slug).toBe('johndoe');
    expect(prisma.developerProfile.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      update: {
        slug: 'johndoe',
        displayName: 'John Doe',
        bio: 'A developer',
        avatarUrl: undefined,
        includedOrderIds: ['order-1'],
      },
      create: {
        userId: 'user-1',
        slug: 'johndoe',
        displayName: 'John Doe',
        bio: 'A developer',
        avatarUrl: undefined,
        includedOrderIds: ['order-1'],
      },
    });
  });

  it('allows updating own slug (upsert for existing profile)', async () => {
    mockAuthenticated();

    // Slug found, but belongs to the same user
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1', slug: 'johndoe',
    } as any);

    vi.mocked(prisma.developerProfile.upsert).mockResolvedValue({
      id: 'prof-1', userId: 'user-1', slug: 'johndoe', displayName: 'Updated Name',
    } as any);

    const res = await POST(makeRequest('POST', {
      slug: 'johndoe',
      displayName: 'Updated Name',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.developerProfile.upsert).toHaveBeenCalled();
  });

  it('rejects when slug is missing', async () => {
    mockAuthenticated();

    const res = await POST(makeRequest('POST', {
      displayName: 'John Doe',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
    expect(json.error).toContain('slug');
    expect(prisma.developerProfile.upsert).not.toHaveBeenCalled();
  });

  it('rejects when displayName is missing', async () => {
    mockAuthenticated();

    const res = await POST(makeRequest('POST', {
      slug: 'johndoe',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
    expect(json.error).toContain('displayName');
    expect(prisma.developerProfile.upsert).not.toHaveBeenCalled();
  });

  it('rejects invalid slug format — too short (2 chars)', async () => {
    mockAuthenticated();

    const res = await POST(makeRequest('POST', {
      slug: 'ab',
      displayName: 'John',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/[Ss]lug/);
  });

  it('rejects invalid slug format — uppercase letters', async () => {
    mockAuthenticated();

    const res = await POST(makeRequest('POST', {
      slug: 'JohnDoe',
      displayName: 'John',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('rejects invalid slug format — starts with hyphen', async () => {
    mockAuthenticated();

    const res = await POST(makeRequest('POST', {
      slug: '-johndoe',
      displayName: 'John',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('rejects invalid slug format — ends with hyphen', async () => {
    mockAuthenticated();

    const res = await POST(makeRequest('POST', {
      slug: 'johndoe-',
      displayName: 'John',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('rejects invalid slug format — special characters', async () => {
    mockAuthenticated();

    const res = await POST(makeRequest('POST', {
      slug: 'john_doe',
      displayName: 'John',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('accepts valid slug with hyphens', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.developerProfile.upsert).mockResolvedValue({
      id: 'prof-1', slug: 'john-doe-dev', displayName: 'John',
    } as any);

    const res = await POST(makeRequest('POST', {
      slug: 'john-doe-dev',
      displayName: 'John',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
  });

  it('accepts minimum valid slug (3 chars)', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.developerProfile.upsert).mockResolvedValue({
      id: 'prof-1', slug: 'abc', displayName: 'John',
    } as any);

    const res = await POST(makeRequest('POST', {
      slug: 'abc',
      displayName: 'John',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
  });

  it('rejects slug longer than 30 chars', async () => {
    mockAuthenticated();

    const longSlug = 'a' + 'b'.repeat(29) + 'c'; // 31 chars
    const res = await POST(makeRequest('POST', {
      slug: longSlug,
      displayName: 'John',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
  });

  it('rejects slug taken by another user', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-2', userId: 'other-user', slug: 'taken-slug',
    } as any);

    const res = await POST(makeRequest('POST', {
      slug: 'taken-slug',
      displayName: 'John',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(409);
    expect(json.error).toMatch(/taken/i);
    expect(prisma.developerProfile.upsert).not.toHaveBeenCalled();
  });

  it('returns 401 when not authenticated', async () => {
    mockUnauthenticated();

    const res = await POST(makeRequest('POST', {
      slug: 'johndoe',
      displayName: 'John Doe',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(401);
    expect(prisma.developerProfile.upsert).not.toHaveBeenCalled();
  });

  it('returns 500 on unexpected error', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.developerProfile.upsert).mockRejectedValue(new Error('DB write error'));

    const res = await POST(makeRequest('POST', {
      slug: 'johndoe',
      displayName: 'John',
    }) as any);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
  });
});

// ── PATCH /api/profile ─────────────────────────────────────────────

describe('PATCH /api/profile', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('updates displayName', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1', slug: 'johndoe', displayName: 'Old Name',
    } as any);

    vi.mocked(prisma.developerProfile.update).mockResolvedValue({
      id: 'prof-1', slug: 'johndoe', displayName: 'New Name',
    } as any);

    const res = await PATCH(makeRequest('PATCH', { displayName: 'New Name' }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.developerProfile.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { displayName: 'New Name' },
    });
  });

  it('updates bio', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1', slug: 'johndoe',
    } as any);

    vi.mocked(prisma.developerProfile.update).mockResolvedValue({
      id: 'prof-1', bio: 'New bio text',
    } as any);

    const res = await PATCH(makeRequest('PATCH', { bio: 'New bio text' }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.developerProfile.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { bio: 'New bio text' },
    });
  });

  it('updates avatarUrl', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1',
    } as any);

    vi.mocked(prisma.developerProfile.update).mockResolvedValue({
      id: 'prof-1', avatarUrl: 'https://example.com/new.jpg',
    } as any);

    const res = await PATCH(makeRequest('PATCH', { avatarUrl: 'https://example.com/new.jpg' }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.developerProfile.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { avatarUrl: 'https://example.com/new.jpg' },
    });
  });

  it('updates isActive', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1',
    } as any);

    vi.mocked(prisma.developerProfile.update).mockResolvedValue({
      id: 'prof-1', isActive: false,
    } as any);

    const res = await PATCH(makeRequest('PATCH', { isActive: false }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.developerProfile.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { isActive: false },
    });
  });

  it('updates includedOrderIds', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1',
    } as any);

    vi.mocked(prisma.developerProfile.update).mockResolvedValue({
      id: 'prof-1', includedOrderIds: ['order-1', 'order-3'],
    } as any);

    const res = await PATCH(makeRequest('PATCH', { includedOrderIds: ['order-1', 'order-3'] }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.developerProfile.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { includedOrderIds: ['order-1', 'order-3'] },
    });
  });

  it('updates multiple allowed fields at once', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1',
    } as any);

    vi.mocked(prisma.developerProfile.update).mockResolvedValue({
      id: 'prof-1', displayName: 'New', bio: 'Updated bio',
    } as any);

    const res = await PATCH(makeRequest('PATCH', {
      displayName: 'New',
      bio: 'Updated bio',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.developerProfile.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { displayName: 'New', bio: 'Updated bio' },
    });
  });

  it('updates slug with valid format', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique)
      .mockResolvedValueOnce({ id: 'prof-1', userId: 'user-1' } as any) // profile lookup
      .mockResolvedValueOnce(null); // slug uniqueness check — not taken

    vi.mocked(prisma.developerProfile.update).mockResolvedValue({
      id: 'prof-1', slug: 'new-slug',
    } as any);

    const res = await PATCH(makeRequest('PATCH', { slug: 'new-slug' }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.developerProfile.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { slug: 'new-slug' },
    });
  });

  it('allows keeping own slug', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique)
      .mockResolvedValueOnce({ id: 'prof-1', userId: 'user-1', slug: 'my-slug' } as any)
      .mockResolvedValueOnce({ id: 'prof-1', userId: 'user-1', slug: 'my-slug' } as any);

    vi.mocked(prisma.developerProfile.update).mockResolvedValue({
      id: 'prof-1', slug: 'my-slug',
    } as any);

    const res = await PATCH(makeRequest('PATCH', { slug: 'my-slug' }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
  });

  it('rejects slug taken by another user', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique)
      .mockResolvedValueOnce({ id: 'prof-1', userId: 'user-1' } as any)
      .mockResolvedValueOnce({ id: 'prof-2', userId: 'other-user', slug: 'taken' } as any);

    const res = await PATCH(makeRequest('PATCH', { slug: 'taken' }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(409);
    expect(json.error).toMatch(/taken/i);
    expect(prisma.developerProfile.update).not.toHaveBeenCalled();
  });

  it('rejects invalid slug format in PATCH', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1',
    } as any);

    const res = await PATCH(makeRequest('PATCH', { slug: 'INVALID' }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/[Ss]lug/i);
    expect(prisma.developerProfile.update).not.toHaveBeenCalled();
  });

  it('rejects empty update — no valid fields provided', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1',
    } as any);

    const res = await PATCH(makeRequest('PATCH', { unknownField: 'value' }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/no.*(valid|update)|nothing/i);
    expect(prisma.developerProfile.update).not.toHaveBeenCalled();
  });

  it('rejects empty body', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1',
    } as any);

    const res = await PATCH(makeRequest('PATCH', {}) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(400);
    expect(prisma.developerProfile.update).not.toHaveBeenCalled();
  });

  it('returns 404 when profile does not exist', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(null);

    const res = await PATCH(makeRequest('PATCH', { displayName: 'New Name' }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
    expect(prisma.developerProfile.update).not.toHaveBeenCalled();
  });

  it('returns 401 when not authenticated', async () => {
    mockUnauthenticated();

    const res = await PATCH(makeRequest('PATCH', { displayName: 'New Name' }) as any);
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(res.status).toBe(401);
    expect(prisma.developerProfile.findUnique).not.toHaveBeenCalled();
  });

  it('returns 500 on unexpected error', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1',
    } as any);

    vi.mocked(prisma.developerProfile.update).mockRejectedValue(new Error('DB error'));

    const res = await PATCH(makeRequest('PATCH', { displayName: 'New' }) as any);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
  });

  it('filters out disallowed fields like id, userId, viewCount, createdAt', async () => {
    mockAuthenticated();

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      id: 'prof-1', userId: 'user-1',
    } as any);

    vi.mocked(prisma.developerProfile.update).mockResolvedValue({
      id: 'prof-1', displayName: 'Valid',
    } as any);

    const res = await PATCH(makeRequest('PATCH', {
      displayName: 'Valid',
      id: 'hacked-id',
      userId: 'hacked-user',
      viewCount: 9999,
      createdAt: '2020-01-01',
    }) as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.developerProfile.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { displayName: 'Valid' },
    });
  });
});
