import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('@/lib/db', () => ({
  default: {
    developerProfile: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    order: {
      findMany: vi.fn(),
    },
    orderMetric: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logger', () => {
  const noop = vi.fn();
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: vi.fn(), child };
  return { logger: mockLogger, default: mockLogger };
});

import prisma from '@/lib/db';
import { logger } from '@/lib/logger';
import { GET as getProfile } from '../[slug]/route';
import { GET as getMetrics } from '../[slug]/metrics/route';

// ── Helpers ────────────────────────────────────────────────────────

const makeCtx = (slug: string) => ({
  params: Promise.resolve({ slug }),
});

function makeRequest(url: string) {
  return new Request(url);
}

/** Mock Prisma Decimal — Number() calls valueOf() under the hood */
function decimal(val: number) {
  return { valueOf: () => val, toString: () => String(val), toNumber: () => val };
}

// ── GET /api/dev/[slug] ───────────────────────────────────────────

describe('GET /api/dev/[slug]', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const PROFILE = {
    id: 'prof-1',
    userId: 'user-1',
    slug: 'johndoe',
    displayName: 'John Doe',
    bio: 'Full-stack developer',
    avatarUrl: 'https://example.com/avatar.jpg',
    isActive: true,
    viewCount: 42,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-06-01'),
    user: {
      email: 'john@test.com',
      name: 'John D',
      githubUsername: 'johndoe-gh',
    },
  };

  it('returns profile data for a valid active slug', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.developerProfile.update).mockResolvedValue({} as any);

    const req = makeRequest('http://localhost/api/dev/johndoe');
    const res = await getProfile(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toEqual({
      slug: 'johndoe',
      displayName: 'John Doe',
      bio: 'Full-stack developer',
      avatarUrl: 'https://example.com/avatar.jpg',
      githubUsername: 'johndoe-gh',
      viewCount: 42,
      createdAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('looks up profile by slug with user include', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.developerProfile.update).mockResolvedValue({} as any);

    const req = makeRequest('http://localhost/api/dev/johndoe');
    await getProfile(req as any, makeCtx('johndoe'));

    expect(prisma.developerProfile.findUnique).toHaveBeenCalledWith({
      where: { slug: 'johndoe' },
      include: {
        user: { select: { email: true, name: true, githubUsername: true } },
      },
    });
  });

  it('increments view count on successful lookup', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.developerProfile.update).mockResolvedValue({} as any);

    const req = makeRequest('http://localhost/api/dev/johndoe');
    await getProfile(req as any, makeCtx('johndoe'));

    expect(prisma.developerProfile.update).toHaveBeenCalledWith({
      where: { id: 'prof-1' },
      data: { viewCount: { increment: 1 } },
    });
  });

  it('logs debug on viewCount increment failure', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.developerProfile.update).mockRejectedValue(new Error('DB write failed'));

    const req = makeRequest('http://localhost/api/dev/johndoe');
    const res = await getProfile(req as any, makeCtx('johndoe'));

    // Response should still be 200 (fire-and-forget)
    expect(res.status).toBe(200);

    // Wait for the catch handler to fire
    await new Promise(r => setTimeout(r, 10));

    expect(logger.debug).toHaveBeenCalled();
  });

  it('returns 404 when slug not found', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(null);

    const req = makeRequest('http://localhost/api/dev/nonexistent');
    const res = await getProfile(req as any, makeCtx('nonexistent'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Not found');
    expect(prisma.developerProfile.update).not.toHaveBeenCalled();
  });

  it('returns 404 when profile is inactive', async () => {
    const inactiveProfile = { ...PROFILE, isActive: false };
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(inactiveProfile as any);

    const req = makeRequest('http://localhost/api/dev/johndoe');
    const res = await getProfile(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Not found');
    expect(prisma.developerProfile.update).not.toHaveBeenCalled();
  });

  it('returns profile without bio/avatarUrl when null', async () => {
    const minimalProfile = {
      ...PROFILE,
      bio: null,
      avatarUrl: null,
      user: { email: 'john@test.com', name: null, githubUsername: null },
    };
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(minimalProfile as any);
    vi.mocked(prisma.developerProfile.update).mockResolvedValue({} as any);

    const req = makeRequest('http://localhost/api/dev/johndoe');
    const res = await getProfile(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.bio).toBeNull();
    expect(json.data.avatarUrl).toBeNull();
    expect(json.data.githubUsername).toBeNull();
  });

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockRejectedValue(new Error('DB connection lost'));

    const req = makeRequest('http://localhost/api/dev/johndoe');
    const res = await getProfile(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
  });
});

// ── GET /api/dev/[slug]/metrics ───────────────────────────────────

describe('GET /api/dev/[slug]/metrics', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const PROFILE = {
    id: 'prof-1',
    userId: 'user-1',
    slug: 'johndoe',
    isActive: true,
    includedOrderIds: null,
    user: { email: 'john@test.com' },
  };

  const ORDERS = [
    {
      id: 'order-1',
      name: 'Project Alpha',
      selectedRepos: [{ full_name: 'org/repo-a', owner: { login: 'org' }, name: 'repo-a' }],
    },
    {
      id: 'order-2',
      name: 'Project Beta',
      selectedRepos: [{ fullName: 'team/repo-b' }],
    },
  ];

  const METRICS = [
    {
      orderId: 'order-1',
      commitCount: 150,
      workDays: 30,
      totalEffortHours: decimal(240),
      avgDailyEffort: decimal(8),
      ghostPercent: decimal(12.5),
      share: decimal(0.65),
    },
    {
      orderId: 'order-2',
      commitCount: 80,
      workDays: 15,
      totalEffortHours: decimal(120),
      avgDailyEffort: decimal(8),
      ghostPercent: null,
      share: decimal(1.0),
    },
  ];

  it('returns metrics for all COMPLETED orders when no includedOrderIds', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue(ORDERS as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue(METRICS as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    const res = await getMetrics(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.orders).toHaveLength(2);
    expect(json.data.summary).toBeDefined();
  });

  it('filters orders by includedOrderIds when set', async () => {
    const profileWithIds = {
      ...PROFILE,
      includedOrderIds: ['order-1'],
    };

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(profileWithIds as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue([ORDERS[0]] as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue([METRICS[0]] as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    await getMetrics(req as any, makeCtx('johndoe'));

    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['order-1'] }, status: 'COMPLETED' },
      select: { id: true, name: true, selectedRepos: true },
    });
  });

  it('queries all user COMPLETED orders when includedOrderIds is null', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue(ORDERS as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue(METRICS as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    await getMetrics(req as any, makeCtx('johndoe'));

    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', status: 'COMPLETED' },
      select: { id: true, name: true, selectedRepos: true },
    });
  });

  it('queries orderMetric with ALL_TIME period and developer email', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue(ORDERS as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue(METRICS as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    await getMetrics(req as any, makeCtx('johndoe'));

    expect(prisma.orderMetric.findMany).toHaveBeenCalledWith({
      where: {
        orderId: { in: ['order-1', 'order-2'] },
        developerEmail: 'john@test.com',
        periodType: 'ALL_TIME',
      },
      select: {
        orderId: true,
        commitCount: true,
        workDays: true,
        totalEffortHours: true,
        avgDailyEffort: true,
        ghostPercent: true,
        share: true,
      },
    });
  });

  it('enriches metrics with order name and repos', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue(ORDERS as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue(METRICS as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    const res = await getMetrics(req as any, makeCtx('johndoe'));
    const json = await res.json();

    // Order 1: full_name field (snake_case)
    expect(json.data.orders[0].orderName).toBe('Project Alpha');
    expect(json.data.orders[0].repos).toEqual(['org/repo-a']);

    // Order 2: fullName field (camelCase)
    expect(json.data.orders[1].orderName).toBe('Project Beta');
    expect(json.data.orders[1].repos).toEqual(['team/repo-b']);
  });

  it('converts Decimal fields to numbers', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue(ORDERS as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue(METRICS as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    const res = await getMetrics(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(json.data.orders[0].totalEffortHours).toBe(240);
    expect(json.data.orders[0].avgDailyEffort).toBe(8);
    expect(json.data.orders[0].ghostPercent).toBe(12.5);
    expect(json.data.orders[0].share).toBe(0.65);
  });

  it('handles null ghostPercent', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue(ORDERS as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue(METRICS as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    const res = await getMetrics(req as any, makeCtx('johndoe'));
    const json = await res.json();

    // Second metric has null ghostPercent
    expect(json.data.orders[1].ghostPercent).toBeNull();
  });

  it('calculates summary correctly', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue(ORDERS as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue(METRICS as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    const res = await getMetrics(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(json.data.summary).toEqual({
      totalOrders: 2,
      totalCommits: 230,    // 150 + 80
      totalWorkDays: 45,    // 30 + 15
      totalEffortHours: 360, // 240 + 120
      avgGhostPercent: 6.25, // (12.5 + 0) / 2
    });
  });

  it('returns empty summary when no metrics exist', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue([] as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    const res = await getMetrics(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(json.data.summary).toEqual({
      totalOrders: 0,
      totalCommits: 0,
      totalWorkDays: 0,
      totalEffortHours: 0,
      avgGhostPercent: null,
    });
    expect(json.data.orders).toEqual([]);
  });

  it('returns 404 when slug not found', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(null);

    const req = makeRequest('http://localhost/api/dev/nonexistent/metrics');
    const res = await getMetrics(req as any, makeCtx('nonexistent'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Not found');
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('returns 404 when profile is inactive', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue({
      ...PROFILE,
      isActive: false,
    } as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    const res = await getMetrics(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('falls back to owner/name when full_name and fullName missing', async () => {
    const ordersWithFallback = [
      {
        id: 'order-3',
        name: 'Project Gamma',
        selectedRepos: [{ owner: { login: 'myorg' }, name: 'my-repo' }],
      },
    ];

    const metricsForOrder3 = [
      {
        orderId: 'order-3',
        commitCount: 10,
        workDays: 2,
        totalEffortHours: decimal(16),
        avgDailyEffort: decimal(8),
        ghostPercent: null,
        share: decimal(1.0),
      },
    ];

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue(ordersWithFallback as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue(metricsForOrder3 as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    const res = await getMetrics(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(json.data.orders[0].repos).toEqual(['myorg/my-repo']);
  });

  it('handles order with no orderName (unknown order)', async () => {
    // Metric references an order that somehow isn't in the map
    const metrics = [
      {
        orderId: 'order-missing',
        commitCount: 5,
        workDays: 1,
        totalEffortHours: decimal(8),
        avgDailyEffort: decimal(8),
        ghostPercent: null,
        share: decimal(1.0),
      },
    ];

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue(metrics as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    const res = await getMetrics(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(json.data.orders[0].orderName).toBe('Unknown');
    expect(json.data.orders[0].repos).toEqual([]);
  });

  it('handles empty selectedRepos array', async () => {
    const ordersEmpty = [
      { id: 'order-1', name: 'Empty', selectedRepos: [] },
    ];
    const metricsEmpty = [
      {
        orderId: 'order-1',
        commitCount: 0,
        workDays: 0,
        totalEffortHours: decimal(0),
        avgDailyEffort: decimal(0),
        ghostPercent: null,
        share: decimal(1.0),
      },
    ];

    vi.mocked(prisma.developerProfile.findUnique).mockResolvedValue(PROFILE as any);
    vi.mocked(prisma.order.findMany).mockResolvedValue(ordersEmpty as any);
    vi.mocked(prisma.orderMetric.findMany).mockResolvedValue(metricsEmpty as any);

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    const res = await getMetrics(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(json.data.orders[0].repos).toEqual([]);
  });

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.developerProfile.findUnique).mockRejectedValue(new Error('DB error'));

    const req = makeRequest('http://localhost/api/dev/johndoe/metrics');
    const res = await getMetrics(req as any, makeCtx('johndoe'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
  });
});
