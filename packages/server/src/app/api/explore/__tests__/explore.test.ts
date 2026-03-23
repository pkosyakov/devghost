import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    repoPublication: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@/lib/services/publication-metrics', () => ({
  computeRepoMetrics: vi.fn(),
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { logger: mockLogger, default: mockLogger };
});

import prisma from '@/lib/db';
import { computeRepoMetrics } from '@/lib/services/publication-metrics';
import { GET as exploreGET } from '../route';
import { GET as repoDetailGET } from '../[owner]/[repo]/route';

// ── Explore catalog tests ──

describe('GET /api/explore', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns active publications with pagination', async () => {
    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([
      { id: 'pub-1', slug: 'facebook/react', isFeatured: true, title: 'React' },
    ] as any);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(1);

    const req = new Request('http://localhost/api/explore?page=1&pageSize=20');
    const res = await exploreGET(req as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.items).toHaveLength(1);
    expect(json.data.total).toBe(1);
    expect(json.data.page).toBe(1);
    expect(json.data.pageSize).toBe(20);
    expect(json.data.totalPages).toBe(1);
  });

  it('applies search filter', async () => {
    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([]);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(0);

    const req = new Request('http://localhost/api/explore?search=react');
    const res = await exploreGET(req as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.items).toHaveLength(0);
    expect(prisma.repoPublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          OR: expect.arrayContaining([
            expect.objectContaining({ slug: { contains: 'react', mode: 'insensitive' } }),
          ]),
        }),
      }),
    );
  });

  it('applies featured filter', async () => {
    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([]);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(0);

    const req = new Request('http://localhost/api/explore?featured=true');
    const res = await exploreGET(req as any);

    expect(prisma.repoPublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          isFeatured: true,
        }),
      }),
    );
  });

  it('clamps page and pageSize to valid ranges', async () => {
    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([]);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(0);

    const req = new Request('http://localhost/api/explore?page=-5&pageSize=999');
    const res = await exploreGET(req as any);
    const json = await res.json();

    expect(json.data.page).toBe(1);
    expect(json.data.pageSize).toBe(50);
  });

  it('defaults page and pageSize when params are non-numeric', async () => {
    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([]);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(0);

    const req = new Request('http://localhost/api/explore?page=abc&pageSize=xyz');
    const res = await exploreGET(req as any);
    const json = await res.json();

    expect(json.data.page).toBe(1);
    expect(json.data.pageSize).toBe(20);
  });

  it('uses correct ordering: featured desc, sortOrder asc, viewCount desc', async () => {
    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([]);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(0);

    const req = new Request('http://localhost/api/explore');
    await exploreGET(req as any);

    expect(prisma.repoPublication.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { viewCount: 'desc' }],
      }),
    );
  });

  it('calculates totalPages correctly', async () => {
    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue(
      Array(10).fill({ id: 'pub', slug: 'owner/repo' }) as any,
    );
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(25);

    const req = new Request('http://localhost/api/explore?page=1&pageSize=10');
    const res = await exploreGET(req as any);
    const json = await res.json();

    expect(json.data.totalPages).toBe(3);
  });

  it('returns 500 on database error', async () => {
    vi.mocked(prisma.repoPublication.findMany).mockRejectedValue(new Error('DB down'));

    const req = new Request('http://localhost/api/explore');
    const res = await exploreGET(req as any);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
  });
});

// ── Repo detail tests ──

describe('GET /api/explore/[owner]/[repo]', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const makeCtx = (owner: string, repo: string) => ({
    params: Promise.resolve({ owner, repo }),
  });

  it('returns publication data and metrics', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1',
      owner: 'facebook',
      repo: 'react',
      slug: 'facebook/react',
      orderId: 'order-1',
      title: 'React',
      description: 'A JS library',
      isFeatured: true,
      viewCount: 42,
      isActive: true,
      visibleDevelopers: null,
      createdAt: new Date('2025-01-01'),
      publishedBy: { name: 'Test User' },
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({} as any);

    vi.mocked(computeRepoMetrics).mockResolvedValue([
      {
        developerId: 'dev@test.com',
        developerName: 'Dev',
        developerEmail: 'dev@test.com',
        periodType: 'ALL_TIME',
        totalEffortHours: 100,
        actualWorkDays: 20,
        avgDailyEffort: 5,
        ghostPercentRaw: 0.8,
        ghostPercent: 0.75,
        share: 1,
        shareAutoCalculated: true,
        commitCount: 50,
        hasEnoughData: true,
      },
    ] as any);

    const req = new Request('http://localhost/api/explore/facebook/react');
    const res = await repoDetailGET(req as any, makeCtx('facebook', 'react'));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.publication.slug).toBe('facebook/react');
    expect(json.data.publication.title).toBe('React');
    expect(json.data.publication.publishedBy).toBe('Test User');
    expect(json.data.metrics).toHaveLength(1);
    expect(computeRepoMetrics).toHaveBeenCalledWith('order-1', 'facebook/react', null);
  });

  it('returns 404 when publication not found', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue(null);

    const req = new Request('http://localhost/api/explore/no/exist');
    const res = await repoDetailGET(req as any, makeCtx('no', 'exist'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
  });

  it('returns 404 when publication is inactive', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1',
      isActive: false,
      publishedBy: { name: 'User' },
    } as any);

    const req = new Request('http://localhost/api/explore/owner/repo');
    const res = await repoDetailGET(req as any, makeCtx('owner', 'repo'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
  });

  it('increments view count', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1',
      owner: 'facebook',
      repo: 'react',
      slug: 'facebook/react',
      orderId: 'order-1',
      title: null,
      description: null,
      isFeatured: false,
      viewCount: 10,
      isActive: true,
      visibleDevelopers: null,
      createdAt: new Date(),
      publishedBy: { name: 'User' },
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({} as any);
    vi.mocked(computeRepoMetrics).mockResolvedValue([]);

    const req = new Request('http://localhost/api/explore/facebook/react');
    await repoDetailGET(req as any, makeCtx('facebook', 'react'));

    expect(prisma.repoPublication.update).toHaveBeenCalledWith({
      where: { id: 'pub-1' },
      data: { viewCount: { increment: 1 } },
    });
  });

  it('passes visibleDevelopers to computeRepoMetrics', async () => {
    const devList = ['dev1@test.com', 'dev2@test.com'];

    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1',
      owner: 'facebook',
      repo: 'react',
      slug: 'facebook/react',
      orderId: 'order-1',
      title: 'React',
      description: null,
      isFeatured: false,
      viewCount: 5,
      isActive: true,
      visibleDevelopers: devList,
      createdAt: new Date(),
      publishedBy: { name: 'User' },
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({} as any);
    vi.mocked(computeRepoMetrics).mockResolvedValue([]);

    const req = new Request('http://localhost/api/explore/facebook/react');
    await repoDetailGET(req as any, makeCtx('facebook', 'react'));

    expect(computeRepoMetrics).toHaveBeenCalledWith('order-1', 'facebook/react', devList);
  });

  it('uses slug as title fallback when title is null', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1',
      owner: 'facebook',
      repo: 'react',
      slug: 'facebook/react',
      orderId: 'order-1',
      title: null,
      description: null,
      isFeatured: false,
      viewCount: 0,
      isActive: true,
      visibleDevelopers: null,
      createdAt: new Date(),
      publishedBy: { name: 'User' },
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({} as any);
    vi.mocked(computeRepoMetrics).mockResolvedValue([]);

    const req = new Request('http://localhost/api/explore/facebook/react');
    const res = await repoDetailGET(req as any, makeCtx('facebook', 'react'));
    const json = await res.json();

    expect(json.data.publication.title).toBe('facebook/react');
  });

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockRejectedValue(new Error('DB error'));

    const req = new Request('http://localhost/api/explore/facebook/react');
    const res = await repoDetailGET(req as any, makeCtx('facebook', 'react'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
  });
});
