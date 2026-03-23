import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    repoPublication: {
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
import { GET } from '../[token]/route';

describe('GET /api/share/[token]', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const makeCtx = (token: string) => ({
    params: Promise.resolve({ token }),
  });

  it('returns publication data and metrics for valid share token', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1',
      owner: 'facebook',
      repo: 'react',
      slug: 'facebook/react',
      orderId: 'order-1',
      title: 'React',
      description: 'A JS library',
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

    const req = new Request('http://localhost/api/share/abc123token');
    const res = await GET(req as any, makeCtx('abc123token'));
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.publication.slug).toBe('facebook/react');
    expect(json.data.publication.title).toBe('React');
    expect(json.data.publication.publishedBy).toBe('Test User');
    expect(json.data.metrics).toHaveLength(1);
    expect(computeRepoMetrics).toHaveBeenCalledWith('order-1', 'facebook/react', null);
  });

  it('returns 404 when share token not found', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue(null);

    const req = new Request('http://localhost/api/share/invalidtoken');
    const res = await GET(req as any, makeCtx('invalidtoken'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(json.error).toBe('Not found');
  });

  it('returns 404 when publication is inactive', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue({
      id: 'pub-1',
      isActive: false,
      publishedBy: { name: 'User' },
    } as any);

    const req = new Request('http://localhost/api/share/tok123');
    const res = await GET(req as any, makeCtx('tok123'));
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
      title: 'React',
      description: null,
      viewCount: 10,
      isActive: true,
      visibleDevelopers: null,
      createdAt: new Date(),
      publishedBy: { name: 'User' },
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({} as any);
    vi.mocked(computeRepoMetrics).mockResolvedValue([]);

    const req = new Request('http://localhost/api/share/tok123');
    await GET(req as any, makeCtx('tok123'));

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
      viewCount: 5,
      isActive: true,
      visibleDevelopers: devList,
      createdAt: new Date(),
      publishedBy: { name: 'User' },
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({} as any);
    vi.mocked(computeRepoMetrics).mockResolvedValue([]);

    const req = new Request('http://localhost/api/share/tok456');
    await GET(req as any, makeCtx('tok456'));

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
      viewCount: 0,
      isActive: true,
      visibleDevelopers: null,
      createdAt: new Date(),
      publishedBy: { name: 'User' },
    } as any);

    vi.mocked(prisma.repoPublication.update).mockResolvedValue({} as any);
    vi.mocked(computeRepoMetrics).mockResolvedValue([]);

    const req = new Request('http://localhost/api/share/tok789');
    const res = await GET(req as any, makeCtx('tok789'));
    const json = await res.json();

    expect(json.data.publication.title).toBe('facebook/react');
  });

  it('looks up by shareToken, not by slug', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockResolvedValue(null);

    const req = new Request('http://localhost/api/share/unique-token-xyz');
    await GET(req as any, makeCtx('unique-token-xyz'));

    expect(prisma.repoPublication.findUnique).toHaveBeenCalledWith({
      where: { shareToken: 'unique-token-xyz' },
      include: expect.any(Object),
    });
  });

  it('returns 500 on unexpected error', async () => {
    vi.mocked(prisma.repoPublication.findUnique).mockRejectedValue(new Error('DB error'));

    const req = new Request('http://localhost/api/share/tok123');
    const res = await GET(req as any, makeCtx('tok123'));
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.success).toBe(false);
  });
});
