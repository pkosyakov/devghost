import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockOrderFindFirst = vi.fn();
const mockCommitAnalysisCount = vi.fn();
const mockQueryRaw = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    order: { findFirst: (...args: unknown[]) => mockOrderFindFirst(...args) },
    commitAnalysis: { count: (...args: unknown[]) => mockCommitAnalysisCount(...args) },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn(),
  isErrorResponse: vi.fn((value: unknown) => value instanceof Response),
  apiResponse: vi.fn((data: unknown) =>
    new Response(JSON.stringify({ success: true, data }), { status: 200 }),
  ),
  apiError: vi.fn((message: string, status: number) =>
    new Response(JSON.stringify({ success: false, error: message }), { status }),
  ),
}));

vi.mock('@/lib/services/analysis-billing-preview', () => ({
  computeBillingPreview: vi.fn(),
}));

import { requireUserSession } from '@/lib/api-utils';
import { computeBillingPreview } from '@/lib/services/analysis-billing-preview';
import { GET } from '../route';

const FAKE_ORDER = {
  id: 'order-1',
  userId: 'user-1',
  selectedRepos: [{ fullName: 'org/repo' }],
  selectedDevelopers: [{ email: 'dev@test.com', commitCount: 10 }],
  excludedDevelopers: ['excluded@test.com'],
  analysisPeriodMode: 'ALL_TIME',
  analysisYears: [],
  analysisStartDate: null,
  analysisEndDate: null,
  analysisCommitLimit: null,
};

const PREVIEW_RESULT = {
  totalScopedCommits: 10,
  reusableCachedCommits: 2,
  billableCommits: 8,
  estimatedCredits: 8,
  isFirstRunEstimate: true,
};

function makeRequest(query = ''): NextRequest {
  const url = query
    ? `http://localhost/api/orders/order-1/billing-preview?${query}`
    : 'http://localhost/api/orders/order-1/billing-preview';
  return new NextRequest(new URL(url), { method: 'GET' });
}

const routeParams = { params: Promise.resolve({ id: 'order-1' }) };

describe('GET /api/orders/[id]/billing-preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'user@test.com', role: 'USER' },
    } as never);
    mockOrderFindFirst.mockResolvedValue(FAKE_ORDER);
    vi.mocked(computeBillingPreview).mockResolvedValue(PREVIEW_RESULT);
  });

  it('passes selectedDevelopers to computeBillingPreview', async () => {
    const res = await GET(makeRequest(), routeParams);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data).toEqual(PREVIEW_RESULT);

    expect(computeBillingPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        orderId: 'order-1',
        selectedRepos: FAKE_ORDER.selectedRepos,
        selectedDevelopers: FAKE_ORDER.selectedDevelopers,
        excludedEmails: ['excluded@test.com'],
        cacheMode: 'model',
        scope: {
          mode: 'ALL_TIME',
          years: [],
          startDate: null,
          endDate: null,
          commitLimit: null,
        },
      }),
    );
  });

  it('accepts scope overrides from query params', async () => {
    const query = [
      'cacheMode=off',
      'excludedEmails=a@b.com,c@d.com',
      'analysisPeriodMode=DATE_RANGE',
      'analysisStartDate=2025-01-01T00:00:00.000Z',
      'analysisEndDate=2025-06-30T23:59:59.999Z',
      'analysisCommitLimit=50',
      'analysisYears=2024,2025',
    ].join('&');

    const res = await GET(makeRequest(query), routeParams);
    expect(res.status).toBe(200);

    expect(computeBillingPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        excludedEmails: ['a@b.com', 'c@d.com'],
        cacheMode: 'off',
        scope: {
          mode: 'DATE_RANGE',
          years: [2024, 2025],
          startDate: new Date('2025-01-01T00:00:00.000Z'),
          endDate: new Date('2025-06-30T23:59:59.999Z'),
          commitLimit: 50,
        },
      }),
    );
  });

  it('uses persisted order scope when no overrides provided', async () => {
    mockOrderFindFirst.mockResolvedValue({
      ...FAKE_ORDER,
      analysisPeriodMode: 'SELECTED_YEARS',
      analysisYears: [2023, 2024],
      analysisStartDate: new Date('2023-01-01T00:00:00.000Z'),
      analysisEndDate: new Date('2024-12-31T23:59:59.999Z'),
      analysisCommitLimit: 100,
      excludedDevelopers: ['skip@test.com'],
    });

    const res = await GET(makeRequest(), routeParams);
    expect(res.status).toBe(200);

    expect(computeBillingPreview).toHaveBeenCalledWith(
      expect.objectContaining({
        excludedEmails: ['skip@test.com'],
        cacheMode: 'model',
        scope: {
          mode: 'SELECTED_YEARS',
          years: [2023, 2024],
          startDate: new Date('2023-01-01T00:00:00.000Z'),
          endDate: new Date('2024-12-31T23:59:59.999Z'),
          commitLimit: 100,
        },
      }),
    );
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(requireUserSession).mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 }) as never,
    );

    const res = await GET(makeRequest(), routeParams);
    expect(res.status).toBe(401);
  });

  it('returns 404 when order not found', async () => {
    mockOrderFindFirst.mockResolvedValue(null);

    const res = await GET(makeRequest(), routeParams);
    expect(res.status).toBe(404);
  });
});
