import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockParseBody, mockCreateTeamFromRepository } = vi.hoisted(() => ({
  mockParseBody: vi.fn(),
  mockCreateTeamFromRepository: vi.fn(),
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
  ensureWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1' }),
}));

vi.mock('@/lib/services/team-service', () => ({
  createTeamFromRepository: (...args: any[]) => mockCreateTeamFromRepository(...args),
}));

function makePostRequest(id: string): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/v2/repositories/${id}/create-team`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

describe('POST /api/v2/repositories/:id/create-team', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('returns 201 with created team', async () => {
    const { POST } = await import('./route');
    mockParseBody.mockResolvedValue({
      success: true,
      data: { name: 'backend-core', contributorIds: ['c1', 'c2'] },
    });
    mockCreateTeamFromRepository.mockResolvedValue({
      team: { id: 't1', name: 'backend-core', description: null },
    });

    const res = await POST(makePostRequest('r1'), { params: Promise.resolve({ id: 'r1' }) });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.id).toBe('t1');
    expect(mockCreateTeamFromRepository).toHaveBeenCalledWith('ws-1', 'r1', expect.any(Object));
  });

  it('returns parse error when body is invalid', async () => {
    const { POST } = await import('./route');
    const errorResponse = new Response(JSON.stringify({ success: false, error: 'Invalid' }), { status: 400 });
    mockParseBody.mockResolvedValue({ success: false, error: errorResponse });

    const res = await POST(makePostRequest('r1'), { params: Promise.resolve({ id: 'r1' }) });
    expect(res.status).toBe(400);
    expect(mockCreateTeamFromRepository).not.toHaveBeenCalled();
  });

  it('returns 404 when repository does not exist', async () => {
    const { POST } = await import('./route');
    mockParseBody.mockResolvedValue({ success: true, data: { name: 'team', contributorIds: [] } });
    mockCreateTeamFromRepository.mockResolvedValue({ error: 'Repository not found' });

    const res = await POST(makePostRequest('r-missing'), { params: Promise.resolve({ id: 'r-missing' }) });
    expect(res.status).toBe(404);
  });

  it('returns 409 on duplicate team name', async () => {
    const { POST } = await import('./route');
    mockParseBody.mockResolvedValue({ success: true, data: { name: 'dup', contributorIds: [] } });
    mockCreateTeamFromRepository.mockResolvedValue({ error: 'A team with this name already exists' });

    const res = await POST(makePostRequest('r1'), { params: Promise.resolve({ id: 'r1' }) });
    expect(res.status).toBe(409);
  });
});
