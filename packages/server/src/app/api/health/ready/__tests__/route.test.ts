import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockQueryRaw = vi.fn();

vi.mock('@/lib/db', () => ({
  default: {
    $queryRaw: (...a: unknown[]) => mockQueryRaw(...a),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}));

function makeRequest(authHeader?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (authHeader) headers['authorization'] = authHeader;
  return new NextRequest(new URL('http://localhost/api/health/ready'), {
    method: 'GET',
    headers,
  });
}

describe('GET /api/health/ready', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HEALTH_CHECK_SECRET;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 200 when DB ok', async () => {
    const { GET } = await import('../route');
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockQueryRaw).toHaveBeenCalled();
  });

  it('returns 503 when DB fails', async () => {
    const { GET } = await import('../route');
    mockQueryRaw.mockRejectedValue(new Error('Connection refused'));

    const res = await GET(makeRequest());
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.db).toBeUndefined();
  });

  it('returns 401 when HEALTH_CHECK_SECRET set and auth missing', async () => {
    vi.resetModules();
    process.env.HEALTH_CHECK_SECRET = 'secret123';
    const { GET } = await import('../route');
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('Unauthorized');
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('returns 401 when HEALTH_CHECK_SECRET set and wrong token', async () => {
    vi.resetModules();
    process.env.HEALTH_CHECK_SECRET = 'secret123';
    const { GET } = await import('../route');
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const res = await GET(makeRequest('Bearer wrong-token'));
    expect(res.status).toBe(401);
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('returns 200 when HEALTH_CHECK_SECRET set and correct token', async () => {
    vi.resetModules();
    process.env.HEALTH_CHECK_SECRET = 'secret123';
    const { GET } = await import('../route');
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);

    const res = await GET(makeRequest('Bearer secret123'));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(mockQueryRaw).toHaveBeenCalled();
  });
});
