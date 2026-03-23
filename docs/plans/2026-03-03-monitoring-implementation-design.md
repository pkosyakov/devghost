# Monitoring Implementation Design

**Date:** 2026-03-03
**Status:** Approved
**Ref:** [MONITORING_ARCHITECTURE.md](../MONITORING_ARCHITECTURE.md)

## Context

DevGhost идёт в production. Архитектура мониторинга утверждена. Этот документ — технический дизайн реализации Фазы 1 и 2: health checks, logger, Sentry, Admin monitoring fixes, env validation.

## Scope

| Фаза | Компоненты | Срок |
|------|------------|------|
| **1** | Health endpoints, Logger (Vercel detect), Admin monitoring fix, Sentry, Env validation, Tests | 2–3 дня |
| **2** | Log drain setup, Modal structlog, Alert rules (вне кода) | 3–5 дней |

---

## 1. Health Endpoints

### 1.1. File Structure

```
packages/server/src/app/api/
├── health/
│   ├── route.ts           # GET /api/health (liveness)
│   └── ready/
│       └── route.ts       # GET /api/health/ready (readiness)
```

### 1.2. API Contract

**GET /api/health**

| Aspect | Value |
|--------|-------|
| Auth | None (public) |
| Response 200 | `{ ok: true, ts: string }` |
| Purpose | Liveness — app responds |

**GET /api/health/ready**

| Aspect | Value |
|--------|-------|
| Auth | Optional: `Authorization: Bearer <HEALTH_CHECK_SECRET>` if env set |
| Response 200 | `{ ok: true }` |
| Response 401 | `{ error: "Unauthorized" }` — if secret configured and missing/wrong |
| Response 503 | `{ ok: false }` — no details, DB error logged server-side |
| Purpose | Readiness — DB connect |

### 1.3. Implementation

```typescript
// api/health/route.ts
export async function GET() {
  return Response.json({ ok: true, ts: new Date().toISOString() });
}

// api/health/ready/route.ts
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { logger } from '@/lib/logger';

const HEALTH_SECRET = process.env.HEALTH_CHECK_SECRET;

export async function GET(request: NextRequest) {
  if (HEALTH_SECRET) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${HEALTH_SECRET}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'Health check failed');
    return Response.json({ ok: false }, { status: 503 });
  }
}
```

### 1.4. Middleware Exclusion

Health routes must bypass auth. Current `middleware.ts` matcher excludes `/api` — health routes are under `/api/health/*`, so no change needed. Verify matcher: `['/((?!api|_next|_vercel|.*\\..*).*)']` — API is excluded.

### 1.5. Tests

```
packages/server/src/app/api/health/__tests__/
├── route.test.ts          # GET /api/health → 200, ok: true
└── ready/
    └── route.test.ts     # GET /api/health/ready
                           # - 200 when DB ok
                           # - 503 when DB fails (mock prisma)
                           # - 401 when HEALTH_CHECK_SECRET set and wrong auth
```

---

## 2. Logger — Vercel Auto-Detect

### 2.1. Current State

`packages/server/src/lib/logger.ts`:
- Uses `NODE_ENV !== 'production'` for pretty vs JSON
- Always adds file transport when `LOG_DIR` exists
- On Vercel: `fs.mkdirSync(LOG_DIR)` may succeed (e.g. `/tmp`), but files are ephemeral

### 2.2. Changes

```typescript
const isDev = process.env.NODE_ENV !== 'production';
const isVercel = !!process.env.VERCEL;  // Vercel sets automatically
const enableFileTransport = !isVercel;
```

- **Console transport:** unchanged (pretty in dev, JSON in prod)
- **File transport:** add only when `enableFileTransport` is true

```typescript
if (logDirExists && enableFileTransport) {
  targets.push({ target: 'pino-roll', ... });
}
```

### 2.3. Edge Cases

- **Self-hosted production:** `VERCEL` is unset → file transport enabled
- **Local `pnpm build && pnpm start`:** `VERCEL` unset → file transport enabled
- **Vercel preview/production:** `VERCEL=1` → file transport disabled

---

## 3. Admin Monitoring — Conditional Cache/Clone

### 3.1. Problem

`/api/admin/monitoring` calls `dirSize()`, `cloneStats()` on paths that don't exist on Vercel. `fs.readdir` throws or returns empty; `dirSize` catches and returns `{ count: 0, bytes: 0 }`. So it doesn't crash, but shows misleading zeros.

### 3.2. Design

- **Detection:** `PIPELINE_MODE === 'modal'` or `!!process.env.VERCEL` → cache/clone stats are N/A
- **API response:** add `cacheAvailable: boolean`, `cloneAvailable: boolean`
- **UI:** when `!cacheAvailable` — show "N/A (Modal mode)" instead of 0/0/0

### 3.3. API Response Shape (updated)

```typescript
{
  activeJobs: [...],
  recentFailed: [...],
  cache: {
    totalMb: number,
    repos: number,
    diffs: number,
    llm: number,
    available: boolean  // false when Modal/Vercel
  }
}
```

### 3.4. Implementation

In `api/admin/monitoring/route.ts`:

1. **recentFailed — обновить фильтр:** Текущий `where: { status: 'FAILED' }` не включает `FAILED_FATAL`, `FAILED_RETRYABLE`. Заменить на:

```typescript
where: { status: { in: ['FAILED', 'FAILED_FATAL', 'FAILED_RETRYABLE'] } }
```

2. **cache — условная логика и available:**

```typescript
const isLocalPipeline = process.env.PIPELINE_MODE !== 'modal' && !process.env.VERCEL;

const [repos, diffs, llm] = isLocalPipeline
  ? await Promise.all([
      cloneStats(CLONE_DIR),
      dirSize(path.join(CACHE_DIR, 'diffs')),
      dirSize(path.join(CACHE_DIR, 'llm')),
    ])
  : [{ count: 0, bytes: 0 }, { count: 0, bytes: 0 }, { count: 0, bytes: 0 }];

return apiResponse({
  activeJobs,
  recentFailed,
  cache: {
    totalMb: isLocalPipeline ? Math.round((repos.bytes + diffs.bytes + llm.bytes) / 1024 / 1024 * 10) / 10 : 0,
    repos: repos.count,
    diffs: diffs.count,
    llm: llm.count,
    available: isLocalPipeline,
  },
});
```

`activeJobs` и `recentFailed` — в том же `Promise.all` с остальными запросами (структура без изменений).

### 3.5. UI Fragment

**Путь:** `packages/server/src/app/[locale]/(dashboard)/admin/monitoring/page.tsx`

Обновить `MonitoringData` interface: добавить `cache.available: boolean`.

Секция `cache` сейчас рендерит `data.cache.repos`, `data.cache.diffs`, `data.cache.llm` без проверки. Добавить условный рендер:

```tsx
{/* Pipeline Cache */}
<Card>
  <CardHeader>...</CardHeader>
  <CardContent className="space-y-4">
    {data.cache.available ? (
      <>
        <div className="grid gap-4 md:grid-cols-4">
          <div className="rounded-md border p-3 text-center">
            <p className="text-2xl font-bold">{data.cache.totalMb}</p>
            <p className="text-xs text-muted-foreground">Total (MB)</p>
          </div>
          {/* ... repos, diffs, llm ... */}
        </div>
        <div className="flex gap-2">
          <Button variant="destructive" onClick={() => clearCache.mutate('all')}>Clear All</Button>
          {/* ... */}
        </div>
      </>
    ) : (
      <p className="text-sm text-muted-foreground">N/A (Modal mode)</p>
    )}
  </CardContent>
</Card>
```

---

## 4. Sentry Integration

### 4.1. Package

```bash
pnpm add @sentry/nextjs
```

### 4.2. File Structure

```
packages/server/
├── sentry.client.config.ts
├── sentry.server.config.ts
├── sentry.edge.config.ts
├── next.config.js          # wrap with withSentryConfig
└── src/
    └── app/
        └── layout.tsx      # optional: ErrorBoundary from Sentry
```

### 4.3. Configuration

**sentry.client.config.ts:**
- `dsn` from `NEXT_PUBLIC_SENTRY_DSN`
- `environment`: `VERCEL_ENV` or `NODE_ENV`
- `tracesSampleRate`: 0.1
- `replaysSessionSampleRate`: 0 (or 0.1 for debugging)
- `beforeSend`: redact PII if needed

**sentry.server.config.ts:**
- Same DSN
- `tracesSampleRate`: 0.1

**sentry.edge.config.ts:**
- Minimal config for edge runtime

### 4.4. next.config.mjs

Текущий конфиг — `next.config.mjs` с `withNextIntl`. Обернуть в `withSentryConfig`:

```javascript
import createNextIntlPlugin from 'next-intl/plugin';
import { withSentryConfig } from '@sentry/nextjs';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig = { /* existing */ };
const configWithIntl = withNextIntl(nextConfig);

export default withSentryConfig(configWithIntl, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  hideSourceMaps: true,
  disableLogger: true,
});
```

Порядок: `nextConfig` → `withNextIntl` → `withSentryConfig`.

### 4.5. Core Web Vitals

**Важно:** `reportWebVitals` — паттерн Pages Router. В App Router он не работает. `window.Sentry` не существует при использовании `@sentry/nextjs` (нет глобала, только импорт).

**Вариант A — ручной сбор через хук:** Отдельный клиентский компонент:

```typescript
// src/components/web-vitals.tsx
'use client';

import { useReportWebVitals } from 'next/web-vitals';
import * as Sentry from '@sentry/nextjs';

export function WebVitals() {
  useReportWebVitals((metric) => {
    Sentry.addBreadcrumb({
      category: 'web-vitals',
      message: `${metric.name}: ${metric.value}`,
      data: metric,
    });
  });
  return null;
}
```

Добавить `<WebVitals />` в root layout (внутри body).

**Вариант B — автоматический:** `@sentry/nextjs` при `tracesSampleRate > 0` автоматически собирает Web Vitals. Ручной код можно не добавлять.

### 4.6. SSE / Long-Polling Error Tracking

**SSE (Explore tab):** `explore-tab.tsx` уже обрабатывает ошибки:
- `es.addEventListener('error', ...)` — серверные error events (rate_limited, search_failed) с JSON data
- `es.onerror` — нативные EventSource errors (connection lost)
- В addEventListener при `JSON.parse` fail → catch блок, setError, close
- В onerror при `readyState !== CLOSED` → setError, close

**Sentry встраивается в существующие обработчики**, не заменяет их:

```typescript
// В addEventListener('error') catch-блоке (EventSource native error при parse fail):
} catch {
  Sentry.captureException(new Error('SSE error event parse failed'), {
    tags: { component: 'explore-search-sse' },
    extra: { query, lastEventId: es.lastEventId },
  });
  setError('Connection lost. Try searching again.');
  setPhase('done');
  es.close();
}

// В es.onerror (unexpected connection loss):
es.onerror = () => {
  if (es.readyState === EventSource.CLOSED) return;  // normal close
  Sentry.captureException(new Error('SSE connection lost'), {
    tags: { component: 'explore-search-sse' },
    extra: { query, lastEventId: es.lastEventId },
  });
  setError('Connection lost. Try searching again.');
  setPhase('done');
  es.close();
};
```

**Progress polling:** Order progress использует `fetch` + `useQuery` refetchInterval. Sentry автоматически ловит unhandled rejections. Опционально: явный `Sentry.captureException` в `onError` при повторных сбоях.

### 4.7. Env Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NEXT_PUBLIC_SENTRY_DSN` | Yes (for client) | Sentry DSN |
| `SENTRY_AUTH_TOKEN` | Yes (for source maps) | Vercel build upload |
| `SENTRY_ORG` | Yes | Sentry org slug |
| `SENTRY_PROJECT` | Yes | Sentry project slug |

---

## 5. Env Validation at Startup

### 5.1. Purpose

Fail fast if critical env vars are missing. Avoid cryptic runtime errors.

### 5.2. Approach

Create `src/lib/env.ts`:

```typescript
const required = [
  'DATABASE_URL',
  'AUTH_SECRET',
  'AUTH_URL',
] as const;

export function validateEnv(): void {
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }
}
```

### 5.3. Invocation

- **Option A:** Call in `instrumentation.ts` (Next.js 15+ instrumentation hook)
- **Option B:** Call in `middleware.ts` first run — but middleware runs per-request
- **Option C:** Call in each API route that needs it — redundant

Next.js ищет `instrumentation.ts` в **корне проекта**. Для монорепы это `packages/server/`, не `src/`:

```typescript
// packages/server/instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { validateEnv } = await import('./src/lib/env');
    validateEnv();
  }
}
```

**Важно:** `register()` вызывается при каждом cold start на Vercel (serverless инстансы эфемерны). Операция быстрая (проверка env), но это не "runs once per deployment" в буквальном смысле.

Note: For Edge runtime, skip validation (`NEXT_RUNTIME === 'nodejs'`) — Edge routes may not need DB.

### 5.4. Required Vars (minimal)

**Обязательные (throw при отсутствии):**
- `DATABASE_URL` — Prisma
- `AUTH_SECRET` — NextAuth
- `AUTH_URL` — NextAuth (e.g. `https://app.devghost.com`)

**Рекомендуемые для production (warning в лог вместо throw):**

```typescript
const recommendedForProduction = [
  'HEALTH_CHECK_SECRET',  // для UptimeRobot/Better Uptime
  'DIRECT_URL',
  'CRON_SECRET',
  'STRIPE_WEBHOOK_SECRET',
];
```

При отсутствии — `logger.warn({ missing: [...] }, 'Recommended env vars not set')`, не throw.

---

## 6. Implementation Order

| Step | Task | Files |
|------|------|-------|
| 1 | Health endpoints | `src/app/api/health/route.ts`, `src/app/api/health/ready/route.ts` |
| 2 | Health tests | `src/app/api/health/__tests__/*.ts` |
| 3 | Logger Vercel detect | `src/lib/logger.ts` |
| 4 | Admin monitoring conditional | `src/app/api/admin/monitoring/route.ts`, `src/app/[locale]/(dashboard)/admin/monitoring/page.tsx` |
| 5 | Env validation | `src/lib/env.ts`, `instrumentation.ts` (в корне `packages/server/`) |
| 6 | Sentry setup | `sentry.*.config.ts`, `next.config.mjs`, layout |
| 7 | SSE Sentry в explore-tab | `src/components/explore-tab.tsx` |
| 8 | Docs: .env.example | Add HEALTH_CHECK_SECRET, SENTRY_* |

---

## 7. Out of Scope (Phase 2)

- Log drain configuration (Vercel dashboard + Axiom/Better Stack)
- Modal structlog (Python worker changes)
- Alert rules (configured in Axiom/Better Stack UI)
- OpenTelemetry / tracing

---

## 8. Acceptance Criteria

- [ ] `GET /api/health` returns 200 with `{ ok: true }`
- [ ] `GET /api/health/ready` returns 200 when DB ok, 503 when DB fails
- [ ] With `HEALTH_CHECK_SECRET` set, ready returns 401 without Bearer token
- [ ] On Vercel, logger does not add file transport
- [ ] Admin monitoring shows "N/A (Modal mode)" for cache when `PIPELINE_MODE=modal` or on Vercel
- [ ] Sentry receives client errors and server errors
- [ ] Missing DATABASE_URL at startup throws before first request
- [ ] Tests pass for health endpoints
