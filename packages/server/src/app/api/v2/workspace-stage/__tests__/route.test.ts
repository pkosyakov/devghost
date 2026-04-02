import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// -- Mocks --

const { mockTeamCount, mockRepoCount, mockContributorCount, mockSavedViewCount } = vi.hoisted(() => ({
  mockTeamCount: vi.fn(),
  mockRepoCount: vi.fn(),
  mockContributorCount: vi.fn(),
  mockSavedViewCount: vi.fn(),
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn().mockResolvedValue({ user: { id: 'u1' } }),
  isErrorResponse: vi.fn((r: unknown) => r instanceof Response),
  apiResponse: vi.fn((data: unknown, status = 200) =>
    new Response(JSON.stringify({ success: true, data }), { status }),
  ),
}));

vi.mock('@/lib/services/workspace-service', () => ({
  ensureWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1', ownerId: 'u1' }),
}));

vi.mock('@/lib/view-as', () => ({
  resolveEffectiveUser: vi.fn().mockResolvedValue({ effectiveUserId: 'u1', isViewingAs: false }),
  isEffectiveUserError: vi.fn(() => false),
}));

vi.mock('@/lib/saved-view-access', () => ({
  buildSavedViewReadableWhere: vi.fn().mockReturnValue({ workspaceId: 'ws-1' }),
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    team: { count: (...args: any[]) => mockTeamCount(...args) },
    repository: { count: (...args: any[]) => mockRepoCount(...args) },
    contributor: { count: (...args: any[]) => mockContributorCount(...args) },
    savedView: { count: (...args: any[]) => mockSavedViewCount(...args) },
  },
}));

// -- Helpers --

function mockRequest(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/v2/workspace-stage');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const req = new Request(url) as any;
  req.nextUrl = url;
  return req;
}

// -- Tests --

describe('GET /api/v2/workspace-stage', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.resetModules());

  it('returns empty stage when all counts are 0', async () => {
    mockTeamCount.mockResolvedValue(0);
    mockRepoCount.mockResolvedValue(0);
    mockContributorCount.mockResolvedValue(0);
    mockSavedViewCount.mockResolvedValue(0);

    const { GET } = await import('../route');
    const res = await GET(mockRequest());

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.workspaceStage).toBe('empty');
    expect(json.data.onboarding.needsFirstSavedView).toBe(false);
    expect(json.data.onboarding.savedViewCount).toBe(0);
  });

  it('returns first_data stage when repos and contributors exist but no teams', async () => {
    mockTeamCount.mockResolvedValue(0);
    mockRepoCount.mockResolvedValue(3);
    mockContributorCount.mockResolvedValue(2);
    mockSavedViewCount.mockResolvedValue(0);

    const { GET } = await import('../route');
    const res = await GET(mockRequest());

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.workspaceStage).toBe('first_data');
    expect(json.data.onboarding.needsFirstSavedView).toBe(false);
  });

  it('returns operational stage with needsFirstSavedView when teams exist but no saved views', async () => {
    mockTeamCount.mockResolvedValue(1);
    mockRepoCount.mockResolvedValue(3);
    mockContributorCount.mockResolvedValue(2);
    mockSavedViewCount.mockResolvedValue(0);

    const { GET } = await import('../route');
    const res = await GET(mockRequest());

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.workspaceStage).toBe('operational');
    expect(json.data.onboarding.needsFirstSavedView).toBe(true);
  });

  it('returns operational stage without needsFirstSavedView when saved views exist', async () => {
    mockTeamCount.mockResolvedValue(2);
    mockRepoCount.mockResolvedValue(5);
    mockContributorCount.mockResolvedValue(4);
    mockSavedViewCount.mockResolvedValue(1);

    const { GET } = await import('../route');
    const res = await GET(mockRequest());

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.workspaceStage).toBe('operational');
    expect(json.data.onboarding.needsFirstSavedView).toBe(false);
  });
});
