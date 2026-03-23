# DevGhost Production Deployment Design

**Date:** 2026-03-14
**Status:** Draft
**Domain:** devghost.pro

## 1. Overview

Production deployment of DevGhost platform using the architecture already designed and implemented in the codebase. No architectural changes — deploying what exists.

**Approach:** Phased deployment (layer by layer), each layer verified before the next.

## 2. Architecture

```
                    devghost.pro
                        |
                    +--------+
                    | Vercel |  Next.js 16 (Hobby -> Pro)
                    |  App   |  UI + API Routes
                    +--------+
                        |
            +-----------+-----------+
            |           |           |
        +--------+ +--------+ +---------+
        |Supabase| | Modal  | | Stripe  |
        |  DB    | | Worker | | Billing |
        +--------+ +--------+ +---------+

        +--------+ +----------+
        | Sentry | | External |
        | Errors | |   Cron   |
        +--------+ +----------+
```

### Components

| Component | Role | Status |
|-----------|------|--------|
| Vercel (Hobby) | Next.js hosting, API routes, SSE, static assets | Account exists |
| Supabase | PostgreSQL, connection pooling (PgBouncer) | Cloud project exists |
| Modal | Serverless Python worker for LLM pipeline | No account yet |
| Stripe | Credit packs, subscriptions, webhooks | Account exists, products not configured |
| Sentry | Error tracking, alerting | Config in code, no project yet |
| External cron | analysis-watchdog via cron-job.org (replaces Vercel cron on Hobby). Bonus: keeps Supabase Free project awake (prevents 7-day inactivity pause) | Not set up |
| devghost.pro | Custom domain | Almost purchased |

### What stays unchanged in code

- Application architecture
- Middleware, auth, API routes
- Pipeline bridge (local/modal routing)
- Security headers in next.config.mjs
- Prisma schema
- Components

## 3. Deployment Phases

### Phase 1 — Infrastructure Preparation

- **Sentry:** create project, obtain DSN and auth token
- **Supabase:** verify cloud project, apply schema (`pnpm db:push`), run seed (`pnpm db:seed`)
- **Domain:** complete purchase of devghost.pro
- **Verification:** Sentry project accessible, DB tables created, seed data present

### Phase 2 — Vercel Deployment

- Connect GitHub repository to Vercel
- Configure Build Settings (pnpm monorepo):
  - Root directory: repo root (NOT `packages/server`)
  - Build command: `pnpm --filter @devghost/server build`
  - Install command: `pnpm install`
  - Output directory: `packages/server/.next`
  - Note: root directory must be repo root so pnpm workspace resolves `@devghost/shared` dependency correctly
- Set environment variables (see Section 4)
  - **Important:** Set `AUTH_URL=https://devghost.pro` explicitly — do not rely on Vercel's auto-detected `VERCEL_URL` (which will be `devghost-xxx.vercel.app`)
- Connect domain devghost.pro (DNS configuration)
- **Verification:** site opens, login/register works, dashboard accessible

### Phase 2.5 — GitHub OAuth (Production)

GitHub OAuth is needed for the core flow (connecting repos, analyzing code), so it goes before Modal.

- Create new GitHub OAuth App with callback: `https://devghost.pro/api/auth/callback/github`
- Update `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` in Vercel env
- **Verification:** GitHub login works, repos load correctly

### Phase 3 — External Cron (cron-job.org)

External cron must be set up **before** Modal, because Modal worker finishes jobs in `LLM_COMPLETE` status, and only the watchdog (called by cron) performs post-processing (Ghost% calculation, credit debits) to move jobs to `COMPLETED`.

- Register on cron-job.org
- Configure: GET `https://devghost.pro/api/cron/analysis-watchdog` every 5 minutes
- Set HTTP header: `Authorization: Bearer <CRON_SECRET_VALUE>`
- **Why cron-job.org, not pg_cron:** Supabase Free pauses projects after 7 days of inactivity. pg_cron dies with the paused DB. External cron solves two problems at once: (1) runs watchdog, (2) keeps Supabase awake by generating regular HTTP traffic through the app.
- **Note:** Hobby tier allows configuring function timeout up to 60s via `maxDuration` export in route. Ensure watchdog route has `export const maxDuration = 60`.
- **Warning:** The watchdog processes jobs in a `while(true)` loop. With `maxDuration=60`, a backlog of multiple `LLM_COMPLETE` jobs could timeout mid-processing. Code change needed: add a time-budget check (e.g. break after 45s elapsed) to guarantee graceful exit. Remaining jobs will be picked up by the next cron invocation.
- **Verification:** manually set a test job to `LLM_COMPLETE` status, trigger watchdog, verify it transitions to `COMPLETED`

### Phase 4 — Modal Worker

- Create Modal account, run `modal token new`
- Create Modal secrets with all required variables:
  - `devghost-db`: `DIRECT_URL`
  - `devghost-llm`: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `MODAL_WEBHOOK_SECRET`, `LLM_MAX_QPS` (optional)
- Deploy: `cd packages/modal && modal deploy app.py`
- Add to Vercel env: `PIPELINE_MODE=modal`, `MODAL_ENDPOINT_URL`, `MODAL_WEBHOOK_SECRET`
- **Verification:** create order, start analysis. Modal job should reach `LLM_COMPLETE`. Watchdog (Phase 3) then post-processes it to `COMPLETED`. Full end-to-end: order status becomes `COMPLETED` with Ghost% metrics visible.

### Phase 5 — Stripe Billing

- Create products and prices in Stripe Dashboard: 3 credit packs (Starter $9/Pro $29/Business $99), subscriptions
- Note each Stripe Price ID (`price_...`) — these are needed in the next step
- **Sync Stripe Price IDs into database:** The seed script fills `stripePriceId` with placeholders (`price_starter_placeholder` etc.). The checkout route (`/api/billing/checkout`) passes this value directly to `stripe.checkout.sessions.create()`. **Without real Price IDs, checkout will fail.** Options:
  - (a) Update seed.ts with real Stripe Price IDs and re-run `pnpm db:seed`, or
  - (b) Update via Prisma Studio (`pnpm db:studio`) or admin SQL, or
  - (c) Create a one-time migration script that sets the real IDs
- Configure webhook endpoint: `https://devghost.pro/api/billing/webhook`
- **Start with test keys** (`sk_test_...`, `pk_test_...`) for initial verification
- Add env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `BILLING_ENABLED=true`
- **Verification (test mode):** credit purchase with test card, subscription checkout, webhook processing
- After verification passes, switch to live keys (`sk_live_...`, `pk_live_...`) and update Price IDs if different between test/live

### Phase 6 — Final Verification & Hardening

- Smoke-test full flow: register -> connect GitHub -> create order -> analyze -> view metrics
- Verify CSP headers, HTTPS, security headers
- Confirm ADMIN_EMAIL is set correctly
- Check Sentry — errors arrive
- Configure Sentry alerts
- Test billing flow end-to-end (test mode purchase -> verify credits)
- Set up uptime monitoring (UptimeRobot or equivalent) for `https://devghost.pro`
- Take Supabase DB backup snapshot before going live

## 4. Environment Variables (Vercel)

```
# Database
DATABASE_URL=postgresql://...@...supabase.co:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://...@...supabase.co:5432/postgres

# Auth
AUTH_SECRET=<generated with openssl rand -base64 32>
AUTH_URL=https://devghost.pro
NEXTAUTH_URL=https://devghost.pro  # REQUIRED: NextAuth v5 beta bug — still references NEXTAUTH_URL internally
ADMIN_EMAIL=<admin email>

# GitHub OAuth
GITHUB_CLIENT_ID=<production app>
GITHUB_CLIENT_SECRET=<production app>

# Sentry
SENTRY_ORG=<org>
SENTRY_PROJECT=<project>
SENTRY_AUTH_TOKEN=<token>
NEXT_PUBLIC_SENTRY_DSN=<dsn>

# Pipeline
PIPELINE_MODE=modal
MODAL_ENDPOINT_URL=<from modal deploy output>
MODAL_WEBHOOK_SECRET=<generated shared secret>
CRON_SECRET=<generated>

# Billing
BILLING_ENABLED=true
STRIPE_SECRET_KEY=sk_test_...  # start with test keys, switch to sk_live_ after verification
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...  # start with test keys, switch to pk_live_ after verification

# LLM
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=<key>
OPENROUTER_MODEL=<model>
```

## 5. Code Changes Required

### Minimal changes

**1. Cron authorization check**
Verify that `/api/cron/analysis-watchdog` validates `CRON_SECRET` — external cron must authenticate, outsiders must not trigger the endpoint. If check already exists, no change needed.

**2. CSP headers for Stripe**
Must add `https://js.stripe.com` to `script-src` in next.config.mjs — Stripe JS SDK will be blocked by CSP without it. Current CSP has `js.stripe.com` in `frame-src` and `connect-src` but NOT in `script-src`.

**3. vercel.json location and cron config**
When Root directory is set to repo root, Vercel looks for `vercel.json` in the repo root, NOT in `packages/server/`. Two actions needed:
- Move `packages/server/vercel.json` to repo root (or create a new one at root), so Vercel picks it up.
- Remove or empty the cron config for Hobby deployment — Hobby only supports daily cron, the current `*/5 * * * *` expression will **fail deployment**. Use an empty `vercel.json` (`{}`) or one without `crons`. Restore cron config when upgrading to Pro.

**4. Sentry tunnelRoute**
Add `tunnelRoute: "/monitoring"` to `withSentryConfig` in next.config.mjs — routes browser Sentry requests through the server, bypassing ad-blockers. Also verify `onRequestError = Sentry.captureRequestError` is exported from `instrumentation.ts` for server-side error capturing.
**Middleware conflict:** Current middleware matcher `['/((?!api|_next|_vercel|.*\\..*).*)']` will match `/monitoring` and run auth/i18n logic on Sentry tunnel requests. Fix: add `monitoring` to the exclusion pattern: `['/((?!api|_next|_vercel|monitoring|.*\\..*).*)']`.

**5. Vercel monorepo detection**
Ensure root `package.json` has `"packageManager": "pnpm@<version>"` field — Vercel uses this to detect pnpm. Without it, Vercel may default to npm and break workspace resolution.

**6. Watchdog time-budget guard**
The watchdog post-processing loop (`while(true)` in route.ts) processes `LLM_COMPLETE` jobs sequentially with no time limit. With `maxDuration=60` on Hobby, a backlog will cause a hard timeout mid-processing. Add a time-budget check at the top of the loop:
```typescript
const startTime = Date.now();
const TIME_BUDGET_MS = 45_000; // 45s — leave 15s buffer before 60s maxDuration
// ... inside the while(true) loop:
if (Date.now() - startTime > TIME_BUDGET_MS) {
  log.info({ processed }, 'Time budget exceeded, deferring to next cron run');
  break;
}
```
Also add `export const maxDuration = 60;` to the route file.

### No changes needed
- Pipeline mode — controlled by `PIPELINE_MODE` env var
- All other configuration — env-driven

## 6. Risks & Mitigation

### Critical

| Risk | Impact | Mitigation |
|------|--------|------------|
| Vercel Hobby timeout | Default 10s, **configurable up to 60s** on Hobby (via `maxDuration` in route config or vercel.json). Main risks: (1) watchdog post-processing (Ghost% calculation, credit debits) for large orders, (2) developer extraction for large repos, (3) SSE streaming | Set `maxDuration: 60` for heavy API routes (watchdog, developers, progress). Limit initial testing to small orders (~20 commits). LLM pipeline runs on Modal (no timeout issue). Pro plan allows up to 300s. |
| Vercel Hobby commercial use | Hobby plan technically prohibits commercial/monetized use | Acceptable for testing/validation phase. Must upgrade to Pro ($20/mo) before enabling live Stripe billing and accepting real payments. |
| Vercel Hobby cron limitation | Hobby cron runs **once per day only** with ±59 min precision. vercel.json's 5-min cron will fail deployment on Hobby. | Remove or comment out cron config from vercel.json while on Hobby. Use external cron (cron-job.org) for 5-min intervals. Restore vercel.json cron when upgrading to Pro. |
| NextAuth v5 beta AUTH_URL bug | NextAuth v5-beta.25 still has code referencing `NEXTAUTH_URL` and falls back to `VERCEL_URL` without `https://` prefix, causing `ERR_INVALID_URL` in production | Set BOTH `AUTH_URL=https://devghost.pro` AND `NEXTAUTH_URL=https://devghost.pro` in Vercel env vars as a workaround. |
| Supabase connection limits | Free tier: 60 direct connections. Vercel serverless creates many connections. | `DATABASE_URL` via PgBouncer (port 6543) already configured with `?pgbouncer=true`. `DIRECT_URL` only for Prisma CLI. |

### Non-critical

| Risk | Impact | Mitigation |
|------|--------|------------|
| Modal cold start | 2-5s with memory snapshotting (Modal's default). First-ever deploy may be slower (~10-30s). | SSE streaming shows progress. Watchdog monitors heartbeat. Analysis takes minutes anyway. Consider `container_idle_timeout=300` to keep containers warm during active use. |
| Stripe webhook reliability | Missed webhook, duplicate processing | `StripeEvent` model implements idempotency. Stripe auto-retries failed webhooks. |
| External cron reliability | cron-job.org may miss invocations | Watchdog is a safety net, not critical path. Jobs complete on their own; only retry of stuck jobs is affected. |
| Sentry free tier | 5K events/month limit | 10% sample rate in prod already configured. Sufficient for initial launch. |

## 7. Rollback Strategy

All components are env-driven, so rollback is straightforward:

| Phase | Rollback |
|-------|----------|
| Vercel | Redeploy previous commit via Vercel Dashboard |
| Modal | **Cannot fall back to local mode on Vercel.** Local mode runs Python subprocess + in-memory job registry, which is dev-only and incompatible with serverless. Rollback: disable analysis (remove `MODAL_ENDPOINT_URL`, new analyses will fail gracefully). Existing completed orders remain accessible. Fix Modal and redeploy. |
| Stripe | Set `BILLING_ENABLED=false` (all users can analyze without credits) |
| External cron | Disable/delete the cron job |
| GitHub OAuth | Remove `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` (credentials login still works) |

## 8. Hobby -> Pro Migration Plan

When the first paying user arrives:

1. Vercel: switch to Pro plan ($20/month)
2. Supabase: switch to Pro plan ($25/month) — removes pausing, adds daily backups
3. Restore cron config in `vercel.json` (if it was removed/commented for Hobby)
4. Remove external cron (cron-job.org) — Vercel Pro supports per-minute cron scheduling
5. Verify analysis-watchdog runs on schedule (Vercel Dashboard -> Cron Jobs)
6. Switch Stripe from test keys to live keys (`sk_live_...`, `pk_live_...`)
7. Done — total: $45/month for full production stack

## 9. Gotchas & Pitfalls (from research)

Findings from production deployment research that must be accounted for:

### Vercel + pnpm Monorepo
- **"No Next.js version detected"** — common error when Vercel can't find Next.js in a monorepo. Fix: set Root directory correctly (repo root), ensure `next` is in `packages/server/package.json` dependencies, set Framework Preset to "Next.js" in Vercel dashboard.
- **pnpm detection** — Vercel reads `packageManager` field from root `package.json` to choose package manager. Without it, defaults to npm which breaks `workspace:*` dependencies. Must have `"packageManager": "pnpm@<version>"`.
- **Build output location** — when Root directory is repo root, Vercel needs to know where `.next` is. Set Output directory to `packages/server/.next`.

### NextAuth v5 Beta
- **ERR_INVALID_URL in production** — known NextAuth v5-beta bug: internal code still references `NEXTAUTH_URL` and falls back to `VERCEL_URL` without `https://` prefix. Deployers report this as a cryptic `TypeError: Invalid URL` at runtime. **Fix:** set both `AUTH_URL` and `NEXTAUTH_URL` to `https://devghost.pro`.
- **Callback URLs** — ensure GitHub OAuth callback matches exactly: `https://devghost.pro/api/auth/callback/github` (no trailing slash).

### Vercel Hobby Cron & vercel.json Location
- **Deployment will FAIL** if `vercel.json` contains cron expressions that run more than once per day. The current `*/5 * * * *` (every 5 min) will be rejected. Must modify before first deploy.
- Hobby cron precision is ±59 minutes — even daily cron is unreliable.
- **vercel.json must be at Root directory level.** With Root=repo root, the file at `packages/server/vercel.json` will NOT be detected. Must move to repo root or create a new one there.

### Stripe + CSP
- `script-src` must include `https://js.stripe.com` for Stripe.js to load.
- `connect-src` should include `https://api.stripe.com` (already present) and `https://r.stripe.com` (Stripe analytics/telemetry).
- `frame-src` must include `https://js.stripe.com` (already present) for Stripe Elements iframes.

### Sentry + Next.js 16
- Next.js 16 uses Turbopack by default. Sentry SDK supports it but the old webpack-based instrumentation (autoInstrumentServerFunctions) is no longer used. SDK relies on OpenTelemetry instrumentation instead.
- `tunnelRoute: "/monitoring"` in `withSentryConfig` is recommended — routes browser error reports through the server, bypassing ad-blockers.
- Ensure `tunnelRoute` does NOT conflict with Next.js middleware matchers.

### Supabase + Vercel Serverless
- Each Vercel function invocation potentially opens a new DB connection. Without PgBouncer, connection limits are hit quickly. `?pgbouncer=true` in DATABASE_URL is essential (already configured).
- Cold start DB connections add ~100-300ms latency. Not a problem for most routes but noticeable on first request.

### Modal
- Cold starts are 2-5s with memory snapshotting (Modal's current default).
- `container_idle_timeout=300` keeps containers warm for 5 min after last invocation — useful during active analysis batches.
- Modal secrets are immutable after creation — to update a secret value, delete and recreate it.

## 10. Success Criteria

- [ ] devghost.pro resolves and shows the application
- [ ] User can register with email and login
- [ ] User can connect GitHub and see repos
- [ ] User can create an order and run LLM analysis (Modal)
- [ ] Analysis completes, metrics display correctly
- [ ] Watchdog monitors job heartbeats (external cron)
- [ ] Billing works: purchase credits, subscribe, webhook processes
- [ ] Sentry receives error events
- [ ] Security headers present (check via securityheaders.com)
- [ ] Admin panel accessible for ADMIN_EMAIL user
