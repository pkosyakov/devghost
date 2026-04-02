import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetOrderWithAuth = vi.fn();
const mockJobFindFirst = vi.fn();
const mockJobUpdateMany = vi.fn();
const mockOrderMetricCount = vi.fn();
const mockOrderUpdate = vi.fn();
const mockRequestCancel = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    analysisJob: {
      findFirst: (...args: unknown[]) => mockJobFindFirst(...args),
      updateMany: (...args: unknown[]) => mockJobUpdateMany(...args),
    },
    orderMetric: {
      count: (...args: unknown[]) => mockOrderMetricCount(...args),
    },
    order: {
      update: (...args: unknown[]) => mockOrderUpdate(...args),
    },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  getOrderWithAuth: (...args: unknown[]) => mockGetOrderWithAuth(...args),
  orderAuthError: vi.fn((result: { error: string; status: number }) =>
    new Response(JSON.stringify({ success: false, error: result.error }), { status: result.status }),
  ),
  apiResponse: vi.fn((data: unknown, status = 200) =>
    new Response(JSON.stringify({ success: true, data }), { status }),
  ),
  apiError: vi.fn((message: string, status = 400) =>
    new Response(JSON.stringify({ success: false, error: message }), { status }),
  ),
}));

vi.mock('@/lib/services/job-registry', () => ({
  requestCancel: (...args: unknown[]) => mockRequestCancel(...args),
}));

const mockReleaseReservedCredits = vi.fn().mockResolvedValue(0);

vi.mock('@/lib/services/credit-service', () => ({
  isBillingEnabled: vi.fn(() => true),
  releaseReservedCredits: (...args: unknown[]) => mockReleaseReservedCredits(...args),
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { analysisLogger: mockLogger, billingLogger: mockLogger };
});

import { POST } from '../route';

function makeRequest(): NextRequest {
  return new NextRequest(new URL('http://localhost/api/orders/order-1/jobs/job-1/cancel'), {
    method: 'POST',
  });
}

const params = { params: Promise.resolve({ id: 'order-1', jobId: 'job-1' }) };

describe('POST /api/orders/[id]/jobs/[jobId]/cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrderWithAuth.mockResolvedValue({
      success: true,
      order: { id: 'order-1', status: 'PROCESSING', userId: 'user-1' },
    });
    mockOrderMetricCount.mockResolvedValue(0);
    mockJobUpdateMany.mockResolvedValue({ count: 1 });
    mockOrderUpdate.mockResolvedValue({});
  });

  it('cancels RUNNING modal job via DB status flip only', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'RUNNING',
      type: 'analysis',
      executionMode: 'modal',
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(mockJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-1',
        }),
        data: expect.objectContaining({
          status: 'CANCELLED',
          currentStep: 'cancelled',
        }),
      }),
    );
    expect(mockOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1' },
        data: expect.objectContaining({ status: 'READY_FOR_ANALYSIS' }),
      }),
    );
  });

  it('signals local worker cancellation for local RUNNING jobs', async () => {
    mockOrderMetricCount.mockResolvedValue(2);
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'RUNNING',
      type: 'analysis',
      executionMode: 'local',
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    expect(mockRequestCancel).toHaveBeenCalledWith('job-1');
    expect(mockOrderUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
  });

  it('allows cancellation in LLM_COMPLETE post-processing stage', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'LLM_COMPLETE',
      type: 'analysis',
      executionMode: 'modal',
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    expect(mockJobUpdateMany).toHaveBeenCalled();
  });

  it('returns 400 for non-cancellable status', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'COMPLETED',
      type: 'analysis',
      executionMode: 'modal',
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(400);
    expect(mockJobUpdateMany).not.toHaveBeenCalled();
  });

  it('releases reserved credits on successful cancel', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'RUNNING',
      type: 'analysis',
      executionMode: 'modal',
    });
    mockReleaseReservedCredits.mockResolvedValue(5);

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    expect(mockReleaseReservedCredits).toHaveBeenCalledWith('user-1', 'job-1', 'order-1');
  });

  it('skips credit release when billing is disabled', async () => {
    const { isBillingEnabled } = await import('@/lib/services/credit-service');
    vi.mocked(isBillingEnabled).mockReturnValue(false);

    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'RUNNING',
      type: 'analysis',
      executionMode: 'modal',
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    expect(mockReleaseReservedCredits).not.toHaveBeenCalled();

    vi.mocked(isBillingEnabled).mockReturnValue(true);
  });

  it('still returns 200 if releaseReservedCredits throws', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'RUNNING',
      type: 'analysis',
      executionMode: 'modal',
    });
    mockReleaseReservedCredits.mockRejectedValueOnce(new Error('DB down'));

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.status).toBe('CANCELLED');
  });

  it('returns 409 if status changed before cancel update', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'RUNNING',
      type: 'analysis',
      executionMode: 'modal',
    });
    mockJobUpdateMany.mockResolvedValue({ count: 0 });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(409);
  });
});
