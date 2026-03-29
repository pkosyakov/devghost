import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockJobFindFirst = vi.fn();
const mockJobUpdate = vi.fn();
const mockJobDelete = vi.fn();
const mockCommitDeleteMany = vi.fn();
const mockTransaction = vi.fn();
const mockRequestCancel = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    analysisJob: {
      findFirst: (...a: unknown[]) => mockJobFindFirst(...a),
      update: (...a: unknown[]) => mockJobUpdate(...a),
      delete: (...a: unknown[]) => mockJobDelete(...a),
    },
    commitAnalysis: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: (...a: unknown[]) => mockCommitDeleteMany(...a),
    },
    $transaction: (...a: unknown[]) => mockTransaction(...a),
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireAdmin: vi.fn().mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } }),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
  apiResponse: vi.fn((data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 })),
  apiError: vi.fn((msg: string, status: number) => new Response(JSON.stringify({ success: false, error: msg }), { status })),
}));

vi.mock('@/lib/services/job-registry', () => ({
  requestCancel: (...a: unknown[]) => mockRequestCancel(...a),
}));

import { DELETE } from '../route';

function makeDelete(jobId = 'job-1'): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/orders/order-1/benchmark/${jobId}`), {
    method: 'DELETE',
  });
}

const PARAMS = { params: Promise.resolve({ id: 'order-1', jobId: 'job-1' }) };

describe('DELETE /api/orders/[id]/benchmark/[jobId]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks deletion of a RUNNING Modal benchmark with 409', async () => {
    mockJobFindFirst.mockResolvedValue({ id: 'job-1', status: 'RUNNING', executionMode: 'modal' });

    const res = await DELETE(makeDelete(), PARAMS);
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toMatch(/running Modal benchmark/i);

    // Must not delete anything
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockRequestCancel).not.toHaveBeenCalled();
  });

  it('cancels and deletes a PENDING Modal benchmark', async () => {
    mockJobFindFirst.mockResolvedValue({ id: 'job-1', status: 'PENDING', executionMode: 'modal' });
    mockJobUpdate.mockResolvedValue({});
    mockTransaction.mockResolvedValue([]);

    const res = await DELETE(makeDelete(), PARAMS);
    expect(res.status).toBe(200);

    // Should mark CANCELLED in DB (not use in-memory requestCancel)
    expect(mockJobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1' },
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(mockTransaction).toHaveBeenCalled();
  });

  it('uses in-memory cancel for a RUNNING local benchmark', async () => {
    mockJobFindFirst.mockResolvedValue({ id: 'job-1', status: 'RUNNING', executionMode: 'local' });
    mockTransaction.mockResolvedValue([]);

    const res = await DELETE(makeDelete(), PARAMS);
    expect(res.status).toBe(200);

    expect(mockRequestCancel).toHaveBeenCalledWith('job-1');
    expect(mockJobUpdate).not.toHaveBeenCalled();
    expect(mockTransaction).toHaveBeenCalled();
  });

  it('deletes a COMPLETED benchmark without cancel', async () => {
    mockJobFindFirst.mockResolvedValue({ id: 'job-1', status: 'COMPLETED', executionMode: 'modal' });
    mockTransaction.mockResolvedValue([]);

    const res = await DELETE(makeDelete(), PARAMS);
    expect(res.status).toBe(200);

    expect(mockRequestCancel).not.toHaveBeenCalled();
    expect(mockJobUpdate).not.toHaveBeenCalled();
    expect(mockTransaction).toHaveBeenCalled();
  });

  it('returns 404 for non-existent benchmark', async () => {
    mockJobFindFirst.mockResolvedValue(null);

    const res = await DELETE(makeDelete(), PARAMS);
    expect(res.status).toBe(404);
  });
});
