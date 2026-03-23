import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getLlmConfig } from '@/lib/llm-config';

// In-memory cache with 5 min TTL, per provider
const modelsCache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const provider = req.nextUrl.searchParams.get('provider') || 'ollama';

  if (provider !== 'ollama' && provider !== 'openrouter') {
    return NextResponse.json({ error: 'provider must be ollama or openrouter' }, { status: 400 });
  }

  // Check cache
  const cached = modelsCache.get(provider);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    if (provider === 'ollama') {
      const config = await getLlmConfig();
      const baseUrl = config.ollama.url.replace(/\/api\/.*$/, '');
      const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) {
        return NextResponse.json({ error: 'Ollama not reachable' }, { status: 503 });
      }
      const data = await resp.json();
      const models = (data.models || []).map((m: any) => ({
        id: m.name,
        name: m.name,
        size: m.size ? `${(m.size / 1e9).toFixed(1)}GB` : undefined,
      }));
      // Fetch context_length for each model via /api/show
      const modelsWithCtx = await Promise.all(
        models.map(async (m: { id: string; name: string; size?: string }) => {
          try {
            const showResp = await fetch(`${baseUrl}/api/show`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: m.id }),
              signal: AbortSignal.timeout(3000),
            });
            if (showResp.ok) {
              const info = await showResp.json();
              const ctxEntry = Object.entries(info.model_info || {})
                .find(([k]) => k.endsWith('.context_length'));
              return { ...m, contextLength: ctxEntry ? Number(ctxEntry[1]) : 32768 };
            }
          } catch { /* timeout or error — use default */ }
          return { ...m, contextLength: 32768 };
        }),
      );
      const result = { models: modelsWithCtx };
      modelsCache.set(provider, { data: result, ts: Date.now() });
      return NextResponse.json(result);
    }

    // OpenRouter
    const config = await getLlmConfig();
    if (!config.openrouter.apiKey) {
      return NextResponse.json({ error: 'OpenRouter API key not configured' }, { status: 400 });
    }
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${config.openrouter.apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      return NextResponse.json({ error: 'OpenRouter API error' }, { status: resp.status });
    }
    const data = await resp.json();
    const models = (data.data || [])
      .filter((m: any) => !m.id.includes(':free'))
      .map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        contextLength: m.context_length || null,
        inputPricePerMToken: m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1e6 : undefined,
        outputPricePerMToken: m.pricing?.completion ? parseFloat(m.pricing.completion) * 1e6 : undefined,
      }));
    const result = { models };
    modelsCache.set(provider, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: 'Failed to fetch models' }, { status: 503 });
  }
}
