import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──

const { mockGetTeamDetail, mockUpdateTeam, mockDeleteTeam, mockParseBody } = vi.hoisted(() => ({
  mockGetTeamDetail: vi.fn(),
  mockUpdateTeam: vi.fn(),
  mockDeleteTeam: vi.fn(),
  mockParseBody: vi.fn(),
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
  apiResponse: vi.fn((data: unknown, status = 200) =>
    new Response(JSON.stringify({ success: true, data }), { status }),
  ),
  apiError: vi.fn((msg: string, status: number) =>
    new Response(JSON.stringify({ success: false, error: msg }), { status }),
  ),
  parseBody: mockParseBody,
}));

vi.mock('@/lib/services/workspace-service', () => ({
  ensureWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1', ownerId: 'u1' }),
}));

vi.mock('@/lib/services/team-service', () => ({
  getTeamDetail: (...args: any[]) => mockGetTeamDetail(...args),
  updateTeam: (...args: any[]) => mockUpdateTeam(...args),
  deleteTeam: (...args: any[]) => mockDeleteTeam(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

// ── Helpers ──

const params = Promise.resolve({ id: 't1' });

function makeRequest(method: string, query = ''): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/v2/teams/t1${query ? '?' + query : ''}`), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method !== 'GET' && method !== 'DELETE' ? JSON.stringify({}) : undefined,
  });
}

// ── Tests ──

describe('GET /api/v2/teams/:id', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('returns 200 with team detail', async () => {
    const { GET } = await import('../route');
    mockGetTeamDetail.mockResolvedValue({
      team: { id: 't1', name: 'Frontend' },
      contributors: [],
      repositories: [],
      summaryMetrics: { memberCount: 0, activeContributorCount: 0, activeRepositoryCount: 0, lastActivityAt: null },
      scopeInfo: { source: 'local', dateRange: { start: null, end: null } },
    });

    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.team.name).toBe('Frontend');
  });

  it('returns 404 when team not found', async () => {
    const { GET } = await import('../route');
    mockGetTeamDetail.mockResolvedValue(null);

    const res = await GET(makeRequest('GET'), { params });
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid scope params (from > to)', async () => {
    const { GET } = await import('../route');

    const res = await GET(makeRequest('GET', 'from=2026-12-31&to=2025-01-01'), { params });
    expect(res.status).toBe(400);
    expect(mockGetTeamDetail).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/v2/teams/:id', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('returns 200 on successful update', async () => {
    const { PATCH } = await import('../route');
    mockParseBody.mockResolvedValue({ success: true, data: { name: 'Renamed' } });
    mockUpdateTeam.mockResolvedValue({ count: 1 });

    const res = await PATCH(makeRequest('PATCH'), { params });
    expect(res.status).toBe(200);
    expect(mockUpdateTeam).toHaveBeenCalledWith('t1', 'ws-1', { name: 'Renamed' });
  });

  it('returns 404 when team not found', async () => {
    const { PATCH } = await import('../route');
    mockParseBody.mockResolvedValue({ success: true, data: { name: 'X' } });
    mockUpdateTeam.mockResolvedValue({ count: 0 });

    const res = await PATCH(makeRequest('PATCH'), { params });
    expect(res.status).toBe(404);
  });

  it('returns 409 for duplicate name', async () => {
    const { PATCH } = await import('../route');
    mockParseBody.mockResolvedValue({ success: true, data: { name: 'Dup' } });
    mockUpdateTeam.mockRejectedValue({ code: 'P2002' });

    const res = await PATCH(makeRequest('PATCH'), { params });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /api/v2/teams/:id', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('returns 200 on successful delete', async () => {
    const { DELETE } = await import('../route');
    mockDeleteTeam.mockResolvedValue({ count: 1 });

    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(200);
  });

  it('returns 404 when team not found', async () => {
    const { DELETE } = await import('../route');
    mockDeleteTeam.mockResolvedValue({ count: 0 });

    const res = await DELETE(makeRequest('DELETE'), { params });
    expect(res.status).toBe(404);
  });
});
