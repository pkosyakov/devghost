import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockOrderMetricFindMany = vi.fn();
const mockDailyEffortFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    orderMetric: {
      findMany: (...args: unknown[]) => mockOrderMetricFindMany(...args),
    },
    dailyEffort: {
      findMany: (...args: unknown[]) => mockDailyEffortFindMany(...args),
    },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn(),
  isErrorResponse: vi.fn((value: unknown) => value instanceof Response),
  apiError: vi.fn((message: string, status: number) =>
    new Response(JSON.stringify({ success: false, error: message }), { status })),
  apiResponse: vi.fn((data: unknown) =>
    new Response(JSON.stringify({ success: true, data }), { status: 200 })),
}));

import { requireUserSession } from '@/lib/api-utils';
import { GET } from '../route';

function makeRequest(query = ''): NextRequest {
  const url = query
    ? `http://localhost/api/orders/order-1/metrics?${query}`
    : 'http://localhost/api/orders/order-1/metrics';
  return new NextRequest(new URL(url), { method: 'GET' });
}

describe('GET /api/orders/[id]/metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrderMetricFindMany.mockResolvedValue([]);
    mockDailyEffortFindMany.mockResolvedValue([]);
  });

  it('scopes metrics to owner for regular users', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', role: 'USER' },
    } as never);

    const res = await GET(makeRequest('period=ALL_TIME'), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockOrderMetricFindMany).toHaveBeenCalledWith({
      where: {
        orderId: 'order-1',
        periodType: 'ALL_TIME',
        order: { userId: 'user-1' },
      },
    });
    expect(json.data).toEqual([]);
  });

  it('allows admin to fetch metrics for any order', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
    } as never);

    const res = await GET(makeRequest('period=ALL_TIME'), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(mockOrderMetricFindMany).toHaveBeenCalledWith({
      where: {
        orderId: 'order-1',
        periodType: 'ALL_TIME',
      },
    });
    expect(json.data).toEqual([]);
  });

  it('includes FTE fields in metric response', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', role: 'USER' },
    } as never);

    mockOrderMetricFindMany.mockResolvedValue([
      {
        developerEmail: 'dev@test.com',
        developerName: 'Dev',
        periodType: 'ALL_TIME',
        year: null,
        month: null,
        commitCount: 10,
        workDays: 5,
        totalEffortHours: 15,
        avgDailyEffort: 3.0,
        ghostPercentRaw: 100,
        ghostPercent: 100,
        share: 1.0,
        shareAutoCalculated: true,
        fteWorkDays: 20,
        fteAvgDailyEffort: 0.75,
        fteGhostPercentRaw: 25,
        fteGhostPercent: 25,
      },
    ]);
    mockDailyEffortFindMany.mockResolvedValue([]);

    const res = await GET(makeRequest('period=ALL_TIME'), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();

    expect(json.data[0].fteWorkDays).toBe(20);
    expect(json.data[0].fteAvgDailyEffort).toBe(0.75);
    expect(json.data[0].fteGhostPercentRaw).toBe(25);
    expect(json.data[0].fteGhostPercent).toBe(25);
  });

  it('defaults FTE fields to 0/null for legacy metrics', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', role: 'USER' },
    } as never);

    mockOrderMetricFindMany.mockResolvedValue([
      {
        developerEmail: 'dev@test.com',
        developerName: 'Dev',
        periodType: 'ALL_TIME',
        year: null,
        month: null,
        commitCount: 5,
        workDays: 3,
        totalEffortHours: 9,
        avgDailyEffort: 3.0,
        ghostPercentRaw: 100,
        ghostPercent: 100,
        share: 1.0,
        shareAutoCalculated: true,
      },
    ]);
    mockDailyEffortFindMany.mockResolvedValue([]);

    const res = await GET(makeRequest('period=ALL_TIME'), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();

    expect(json.data[0].fteWorkDays).toBe(0);
    expect(json.data[0].fteAvgDailyEffort).toBe(0);
    expect(json.data[0].fteGhostPercentRaw).toBeNull();
    expect(json.data[0].fteGhostPercent).toBeNull();
  });
});

