import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mocks ──

const { mockListTeams, mockCreateTeam, mockParseBody } = vi.hoisted(() => ({
  mockListTeams: vi.fn(),
  mockCreateTeam: vi.fn(),
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
  listTeams: (...args: any[]) => mockListTeams(...args),
  createTeam: (...args: any[]) => mockCreateTeam(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

// ── Helpers ──

function makeGetRequest(query = ''): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/v2/teams${query ? '?' + query : ''}`), {
    method: 'GET',
  });
}

function makePostRequest(): NextRequest {
  return new NextRequest(new URL('http://localhost/api/v2/teams'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

// ── Tests ──

describe('GET /api/v2/teams', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('returns 200 with team list', async () => {
    const { GET } = await import('../route');
    const mockResult = {
      teams: [{ teamId: 't1', name: 'Frontend' }],
      pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
      summary: { teamCount: 1, activeTeamCount: 1, memberedContributorCount: 3 },
    };
    mockListTeams.mockResolvedValue(mockResult);

    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.teams).toHaveLength(1);
    expect(mockListTeams).toHaveBeenCalledWith('ws-1', expect.objectContaining({
      page: 1, pageSize: 20, sort: 'name', sortOrder: 'asc',
    }));
  });

  it('passes query params to service', async () => {
    const { GET } = await import('../route');
    mockListTeams.mockResolvedValue({ teams: [], pagination: {}, summary: {} });

    await GET(makeGetRequest('page=2&pageSize=10&sort=memberCount&sortOrder=desc&search=back'));

    expect(mockListTeams).toHaveBeenCalledWith('ws-1', expect.objectContaining({
      page: 2, pageSize: 10, sort: 'memberCount', sortOrder: 'desc', search: 'back',
    }));
  });

  it('returns 400 for invalid sort field', async () => {
    const { GET } = await import('../route');
    const res = await GET(makeGetRequest('sort=invalid'));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v2/teams', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('returns 201 with created team', async () => {
    const { POST } = await import('../route');
    mockParseBody.mockResolvedValue({ success: true, data: { name: 'Backend' } });
    mockCreateTeam.mockResolvedValue({ id: 't1', name: 'Backend', description: null });

    const res = await POST(makePostRequest());
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('t1');
  });

  it('returns error for invalid body', async () => {
    const { POST } = await import('../route');
    const errorResponse = new Response(JSON.stringify({ success: false, error: 'Invalid' }), { status: 400 });
    mockParseBody.mockResolvedValue({ success: false, error: errorResponse });

    const res = await POST(makePostRequest());
    expect(res.status).toBe(400);
    expect(mockCreateTeam).not.toHaveBeenCalled();
  });

  it('returns 409 for duplicate team name', async () => {
    const { POST } = await import('../route');
    mockParseBody.mockResolvedValue({ success: true, data: { name: 'Dup' } });
    mockCreateTeam.mockRejectedValue({ code: 'P2002' });

    const res = await POST(makePostRequest());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain('already exists');
  });
});
