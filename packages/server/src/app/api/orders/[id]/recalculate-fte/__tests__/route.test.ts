import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetOrderWithAuth = vi.fn();
const mockRecalculateFteForOrder = vi.fn();

vi.mock('@/lib/api-utils', () => ({
  getOrderWithAuth: (...args: unknown[]) => mockGetOrderWithAuth(...args),
  apiResponse: vi.fn((data: unknown) =>
    new Response(JSON.stringify({ success: true, data }), { status: 200 })),
  apiError: vi.fn((message: string, status: number) =>
    new Response(JSON.stringify({ success: false, error: message }), { status })),
}));

vi.mock('@/lib/services/ghost-metrics-service', () => ({
  getGhostMetricsService: () => ({
    recalculateFteForOrder: (...args: unknown[]) => mockRecalculateFteForOrder(...args),
  }),
}));

import { POST } from '../route';

describe('POST /api/orders/[id]/recalculate-fte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns auth error when getOrderWithAuth fails', async () => {
    mockGetOrderWithAuth.mockResolvedValue({
      success: false,
      error: 'Unauthorized',
      status: 401,
    });

    const res = await POST(new Request('http://localhost'), {
      params: Promise.resolve({ id: 'order-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized');
  });

  it('rejects non-COMPLETED orders with 400', async () => {
    mockGetOrderWithAuth.mockResolvedValue({
      success: true,
      order: { id: 'order-1', userId: 'user-1', status: 'PROCESSING' },
    });

    const res = await POST(new Request('http://localhost'), {
      params: Promise.resolve({ id: 'order-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toMatch(/completed/i);
  });

  it('calls recalculateFteForOrder and returns updated count', async () => {
    mockGetOrderWithAuth.mockResolvedValue({
      success: true,
      order: { id: 'order-1', userId: 'user-1', status: 'COMPLETED' },
    });
    mockRecalculateFteForOrder.mockResolvedValue(3);

    const res = await POST(new Request('http://localhost'), {
      params: Promise.resolve({ id: 'order-1' }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.updated).toBe(3);
    expect(mockRecalculateFteForOrder).toHaveBeenCalledWith('order-1', 'user-1');
  });

  it('passes correct select to getOrderWithAuth', async () => {
    mockGetOrderWithAuth.mockResolvedValue({
      success: false,
      error: 'Not found',
      status: 404,
    });

    await POST(new Request('http://localhost'), {
      params: Promise.resolve({ id: 'order-1' }),
    });

    expect(mockGetOrderWithAuth).toHaveBeenCalledWith('order-1', {
      select: { id: true, userId: true, status: true },
    });
  });
});
