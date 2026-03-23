import { describe, it, expect } from 'vitest';
import { GET } from '../route';

describe('GET /api/health', () => {
  it('returns 200 with ok: true and ts', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(typeof json.ts).toBe('string');
    expect(new Date(json.ts).getTime()).not.toBeNaN();
  });
});
