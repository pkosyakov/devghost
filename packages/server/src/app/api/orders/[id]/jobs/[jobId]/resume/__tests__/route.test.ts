import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetOrderWithAuth = vi.fn();
const mockJobFindFirst = vi.fn();
const mockJobUpdateMany = vi.fn();
const mockOrderUpdateMany = vi.fn();
const mockEventFindFirst = vi.fn();
const mockAppendJobEvent = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    analysisJob: {
      findFirst: (...args: unknown[]) => mockJobFindFirst(...args),
      updateMany: (...args: unknown[]) => mockJobUpdateMany(...args),
      update: vi.fn(),
    },
    order: {
      updateMany: (...args: unknown[]) => mockOrderUpdateMany(...args),
    },
    analysisJobEvent: {
      findFirst: (...args: unknown[]) => mockEventFindFirst(...args),
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

vi.mock('@/lib/services/job-event-service', () => ({
  appendJobEvent: (...args: unknown[]) => mockAppendJobEvent(...args),
}));

const mockClaimAndTriggerModal = vi.fn().mockResolvedValue(true);

vi.mock('@/lib/services/modal-trigger', () => ({
  claimAndTriggerModal: (...args: unknown[]) => mockClaimAndTriggerModal(...args),
}));

vi.mock('@/lib/logger', () => {
  const noop = () => {};
  const child = () => mockLogger;
  const mockLogger = { info: noop, warn: noop, error: noop, debug: noop, child };
  return { analysisLogger: mockLogger };
});

import { POST } from '../route';

function makeRequest(): NextRequest {
  return new NextRequest(new URL('http://localhost/api/orders/order-1/jobs/job-1/resume'), {
    method: 'POST',
  });
}

const params = { params: Promise.resolve({ id: 'order-1', jobId: 'job-1' }) };

describe('POST /api/orders/[id]/jobs/[jobId]/resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrderWithAuth.mockResolvedValue({
      success: true,
      order: { id: 'order-1', status: 'PROCESSING' },
    });
    mockJobUpdateMany.mockResolvedValue({ count: 1 });
    mockOrderUpdateMany.mockResolvedValue({ count: 1 });
    mockAppendJobEvent.mockResolvedValue(undefined);
  });

  it('returns 404 when job not found', async () => {
    mockJobFindFirst.mockResolvedValue(null);

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(404);
    expect(mockJobUpdateMany).not.toHaveBeenCalled();
  });

  it('returns 400 when job is not FAILED_RETRYABLE', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'RUNNING',
      executionMode: 'modal',
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(400);
    expect(mockJobUpdateMany).not.toHaveBeenCalled();
  });

  it('returns 400 when failure class is not EXTERNAL_QUOTA', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'FAILED_RETRYABLE',
      executionMode: 'modal',
    });
    mockEventFindFirst.mockResolvedValue({
      id: 'evt-1',
      code: 'FAILURE_CLASS_TRANSIENT',
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('quota');
    expect(mockJobUpdateMany).not.toHaveBeenCalled();
  });

  it('returns 400 when no failure class event exists', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'FAILED_RETRYABLE',
      executionMode: 'modal',
    });
    mockEventFindFirst.mockResolvedValue(null);

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(400);
    expect(mockJobUpdateMany).not.toHaveBeenCalled();
  });

  it('successfully resumes quota-paused job', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'FAILED_RETRYABLE',
      executionMode: 'modal',
    });
    mockEventFindFirst.mockResolvedValue({
      id: 'evt-1',
      code: 'FAILURE_CLASS_EXTERNAL_QUOTA',
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.data.status).toBe('RESUMED');
    expect(json.data.jobId).toBe('job-1');

    // CAS updateMany called with correct where/data
    expect(mockJobUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-1',
          status: 'FAILED_RETRYABLE',
        }),
        data: expect.objectContaining({
          status: 'PENDING',
          error: null,
          lockedBy: null,
          heartbeatAt: null,
          modalCallId: null,
          updatedAt: expect.any(Date),
        }),
      }),
    );

    // appendJobEvent called with both MANUAL_RESUME_REQUESTED (before CAS) and MANUAL_RESUME_ACCEPTED
    expect(mockAppendJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        code: 'MANUAL_RESUME_REQUESTED',
      }),
    );
    expect(mockAppendJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        code: 'MANUAL_RESUME_ACCEPTED',
      }),
    );

    // claimAndTriggerModal called for modal execution mode
    expect(mockClaimAndTriggerModal).toHaveBeenCalledWith('job-1');
  });

  it('returns 409 when CAS fails (concurrent state change)', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'FAILED_RETRYABLE',
      executionMode: 'modal',
    });
    mockEventFindFirst.mockResolvedValue({
      id: 'evt-1',
      code: 'FAILURE_CLASS_EXTERNAL_QUOTA',
    });
    mockJobUpdateMany.mockResolvedValue({ count: 0 });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(409);
    // MANUAL_RESUME_REQUESTED is logged before CAS for audit trail
    expect(mockAppendJobEvent).toHaveBeenCalledTimes(1);
    expect(mockAppendJobEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MANUAL_RESUME_REQUESTED' }),
    );
    // MANUAL_RESUME_ACCEPTED must NOT be emitted on CAS failure
    expect(mockAppendJobEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MANUAL_RESUME_ACCEPTED' }),
    );
  });

  it('returns 400 for non-modal (local) jobs', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'FAILED_RETRYABLE',
      executionMode: 'local',
    });

    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('modal');
    expect(mockJobUpdateMany).not.toHaveBeenCalled();
  });

  it('does not increment retryCount', async () => {
    mockJobFindFirst.mockResolvedValue({
      id: 'job-1',
      status: 'FAILED_RETRYABLE',
      executionMode: 'modal',
    });
    mockEventFindFirst.mockResolvedValue({
      id: 'evt-1',
      code: 'FAILURE_CLASS_EXTERNAL_QUOTA',
    });

    await POST(makeRequest(), params);

    // Verify the data passed to updateMany does NOT contain retryCount
    const updateCall = mockJobUpdateMany.mock.calls[0]?.[0];
    expect(updateCall.data).not.toHaveProperty('retryCount');
  });
});
