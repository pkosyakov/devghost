export const dynamic = 'force-dynamic';

/** GET /api/health — liveness probe (no dependencies) */
export async function GET() {
  return Response.json({ ok: true, ts: new Date().toISOString() });
}
