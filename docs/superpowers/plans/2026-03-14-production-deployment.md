# DevGhost Production Deployment — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy DevGhost to production on Vercel (Hobby) + Supabase (Free) + Modal + Stripe + Sentry with domain devghost.pro.

**Architecture:** Phased deployment — first all code changes are committed (Tasks 1-6), then infrastructure is configured phase-by-phase (Tasks 7-13). Code changes are independent and can be parallelized. Infrastructure tasks are sequential.

**Tech Stack:** Next.js 16, Vercel, Supabase PostgreSQL, Modal (Python), Stripe, Sentry, cron-job.org

**Spec:** `docs/superpowers/specs/2026-03-14-production-deployment-design.md`

---

## Pre-flight: Verified — no code change needed

These spec items were verified against the current codebase and require no changes:

- **Spec item #1 (Cron authorization check):** Already implemented at `packages/server/src/app/api/cron/analysis-watchdog/route.ts:17-21`. Checks `Authorization: Bearer <CRON_SECRET>` header. No change needed.
- **Spec item #4 (onRequestError export):** Already exported at `packages/server/instrumentation.ts:18`. `export const onRequestError = Sentry.captureRequestError;` is present. No change needed.

## Chunk 1: Code Changes (pre-deployment)

All code changes needed before the first Vercel deploy. These are independent and can be done in parallel, then committed together or separately.

### Task 1: Add `packageManager` field to root package.json

Vercel reads this field to detect pnpm. Without it, Vercel defaults to npm and breaks `workspace:*` dependencies.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add packageManager field**

In `package.json`, add at the top level (after `"private": true`):

```json
"packageManager": "pnpm@10.23.0",
```

- [ ] **Step 2: Verify pnpm still works**

Run: `pnpm install`
Expected: installs without errors, no lockfile changes

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore: add packageManager field for Vercel pnpm detection"
```

---

### Task 2: Move vercel.json to repo root (without cron)

With Vercel Root directory set to repo root, `packages/server/vercel.json` won't be detected. Move it to root and remove cron config (Hobby rejects `*/5 * * * *`).

**Files:**
- Create: `vercel.json` (repo root)
- Delete: `packages/server/vercel.json`

- [ ] **Step 1: Create root vercel.json without cron**

Create `vercel.json` at repo root with empty config (cron will be restored when upgrading to Pro):

```json
{}
```

- [ ] **Step 2: Delete old vercel.json**

```bash
rm packages/server/vercel.json
```

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git rm packages/server/vercel.json
git commit -m "chore: move vercel.json to repo root, remove cron for Hobby tier"
```

---

### Task 3: Add Stripe domain to CSP script-src

Stripe JS SDK will be blocked by CSP without `https://js.stripe.com` in `script-src`. Also add `https://r.stripe.com` to `connect-src` for Stripe telemetry.

**Files:**
- Modify: `packages/server/next.config.mjs:52,56`

- [ ] **Step 1: Update CSP script-src**

In `packages/server/next.config.mjs`, line 52, change:

```javascript
`script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ""}`,
```

to:

```javascript
`script-src 'self' 'unsafe-inline' https://js.stripe.com${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ""}`,
```

- [ ] **Step 2: Update CSP connect-src**

On line 56, change:

```javascript
"connect-src 'self' https://*.sentry.io https://api.stripe.com",
```

to:

```javascript
"connect-src 'self' https://*.sentry.io https://api.stripe.com https://r.stripe.com",
```

- [ ] **Step 3: Verify build**

Run: `cd packages/server && pnpm build`
Expected: build succeeds

- [ ] **Step 4: Commit**

```bash
git add packages/server/next.config.mjs
git commit -m "fix: add Stripe domains to CSP script-src and connect-src"
```

---

### Task 4: Add Sentry tunnelRoute and fix middleware conflict

Add `tunnelRoute: "/monitoring"` to bypass ad-blockers, and exclude `/monitoring` from middleware matcher to prevent auth/i18n interference.

**Files:**
- Modify: `packages/server/next.config.mjs:71-79`
- Modify: `packages/server/middleware.ts:104-106`

- [ ] **Step 1: Add tunnelRoute to Sentry config**

In `packages/server/next.config.mjs`, update the `withSentryConfig` call (lines 71-79) from:

```javascript
export default withSentryConfig(configWithIntl, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  hideSourceMaps: true,
  disableLogger: true,
});
```

to:

```javascript
export default withSentryConfig(configWithIntl, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  hideSourceMaps: true,
  disableLogger: true,
  tunnelRoute: '/monitoring',
});
```

- [ ] **Step 2: Exclude /monitoring from middleware matcher**

In `packages/server/middleware.ts`, line 105, change:

```typescript
matcher: ['/((?!api|_next|_vercel|.*\\..*).*)'],
```

to:

```typescript
matcher: ['/((?!api|_next|_vercel|monitoring|.*\\..*).*)'],
```

- [ ] **Step 3: Verify build**

Run: `cd packages/server && pnpm build`
Expected: build succeeds

- [ ] **Step 4: Commit**

```bash
git add packages/server/next.config.mjs packages/server/middleware.ts
git commit -m "feat: add Sentry tunnelRoute, exclude from middleware"
```

---

### Task 5: Add watchdog time-budget guard and maxDuration

The watchdog `while(true)` loop has no time limit. With `maxDuration=60` on Hobby, a backlog causes hard timeout. Add a 45s time-budget break.

**Files:**
- Modify: `packages/server/src/app/api/cron/analysis-watchdog/route.ts`

- [ ] **Step 1: Add maxDuration export**

At the top of `packages/server/src/app/api/cron/analysis-watchdog/route.ts`, after the imports (after line 7), add:

```typescript
export const maxDuration = 60;
```

- [ ] **Step 2: Add time-budget constant**

After the existing constants (after line 11), add:

```typescript
const TIME_BUDGET_MS = 45_000; // 45s — leave 15s buffer before 60s maxDuration
```

- [ ] **Step 3: Track start time in GET handler**

Inside the `GET` function, after line 23 (`let processed = 0;`), add:

```typescript
const startTime = Date.now();
```

- [ ] **Step 4: Add time-budget checks to ALL loops**

The watchdog has 4 processing sections that can each consume significant time. Add budget checks to all of them.

**4a.** In the stale jobs loop (after `for (const job of staleJobs) {`, line 34), add at the top of the loop body:

```typescript
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      log.info({ processed }, 'Time budget exceeded in stale jobs loop');
      return Response.json({ ok: true, processed, partial: true });
    }
```

**4b.** In the retry jobs loop (after `for (const job of retryJobs) {`, line 64), add at the top:

```typescript
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      log.info({ processed }, 'Time budget exceeded in retry loop');
      return Response.json({ ok: true, processed, partial: true });
    }
```

**4c.** In the orphan pending loop (after `for (const job of orphanPending) {`, line 92), add at the top:

```typescript
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      log.info({ processed }, 'Time budget exceeded in orphan loop');
      return Response.json({ ok: true, processed, partial: true });
    }
```

**4d.** In the post-processing `while (true)` loop (after `while (true) {`, line 112), add at the very beginning:

```typescript
    if (Date.now() - startTime > TIME_BUDGET_MS) {
      log.info({ processed }, 'Time budget exceeded, deferring to next cron run');
      break;
    }
```

Note: loops 4a-4c use `return` (early exit from the whole handler) because they're `for` loops over pre-fetched arrays. Loop 4d uses `break` because it's a `while(true)` with its own exit logic.

- [ ] **Step 5: Verify build**

Run: `cd packages/server && pnpm build`
Expected: build succeeds

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/app/api/cron/analysis-watchdog/route.ts
git commit -m "fix: add watchdog time-budget guard and maxDuration=60 for Vercel Hobby"
```

---

### Task 6: Make seed.ts support real Stripe Price IDs via env vars

Current seed uses hardcoded placeholders (`price_starter_placeholder`) and upserts by `stripePriceId`. Problem: if you seed with placeholders first, then re-run with real env vars, the upsert WHERE clause won't find the old row (different stripePriceId) and will INSERT duplicates.

Fix: upsert by `name` (unique per product) instead of `stripePriceId`. This way re-running with different Price IDs updates the existing rows.

**Files:**
- Modify: `packages/server/prisma/seed.ts:47-60,64-78`

- [ ] **Step 1: Update credit pack seed**

In `packages/server/prisma/seed.ts`, replace the credit packs block (lines 48-60):

```typescript
  const packs = [
    { name: 'Starter', credits: 500, priceUsd: 9.00, stripePriceId: 'price_starter_placeholder', sortOrder: 1 },
    { name: 'Pro', credits: 2000, priceUsd: 29.00, stripePriceId: 'price_pro_placeholder', sortOrder: 2 },
    { name: 'Business', credits: 10000, priceUsd: 99.00, stripePriceId: 'price_business_placeholder', sortOrder: 3 },
  ];

  for (const pack of packs) {
    await prisma.creditPack.upsert({
      where: { stripePriceId: pack.stripePriceId },
      update: { name: pack.name, credits: pack.credits, priceUsd: pack.priceUsd, sortOrder: pack.sortOrder },
      create: pack,
    });
  }
```

with:

```typescript
  const packs = [
    { name: 'Starter', credits: 500, priceUsd: 9.00, stripePriceId: process.env.STRIPE_PRICE_STARTER || 'price_starter_placeholder', sortOrder: 1 },
    { name: 'Pro', credits: 2000, priceUsd: 29.00, stripePriceId: process.env.STRIPE_PRICE_PRO || 'price_pro_placeholder', sortOrder: 2 },
    { name: 'Business', credits: 10000, priceUsd: 99.00, stripePriceId: process.env.STRIPE_PRICE_BUSINESS || 'price_business_placeholder', sortOrder: 3 },
  ];

  for (const pack of packs) {
    await prisma.creditPack.upsert({
      where: { name: pack.name },
      update: { credits: pack.credits, priceUsd: pack.priceUsd, stripePriceId: pack.stripePriceId, sortOrder: pack.sortOrder },
      create: pack,
    });
  }
```

Note: This requires `name` to have a unique constraint in the Prisma schema. If it doesn't, add `@@unique([name])` to the `CreditPack` model, or use `prisma.$executeRaw` with an UPDATE...WHERE name= approach instead.

- [ ] **Step 2: Update subscription seed**

Replace the subscriptions block (lines 65-78) similarly:

```typescript
  const subs = [
    { name: 'Basic', creditsPerMonth: 1000, priceUsd: 9.00, stripePriceId: 'price_sub_basic_placeholder', sortOrder: 1 },
    { name: 'Pro', creditsPerMonth: 4000, priceUsd: 29.00, stripePriceId: 'price_sub_pro_placeholder', sortOrder: 2 },
    { name: 'Business', creditsPerMonth: 20000, priceUsd: 99.00, stripePriceId: 'price_sub_business_placeholder', sortOrder: 3 },
  ];

  for (const sub of subs) {
    await prisma.subscription.upsert({
      where: { stripePriceId: sub.stripePriceId },
      update: { name: sub.name, creditsPerMonth: sub.creditsPerMonth, priceUsd: sub.priceUsd, sortOrder: sub.sortOrder },
      create: sub,
    });
  }
```

with:

```typescript
  const subs = [
    { name: 'Basic', creditsPerMonth: 1000, priceUsd: 9.00, stripePriceId: process.env.STRIPE_PRICE_SUB_BASIC || 'price_sub_basic_placeholder', sortOrder: 1 },
    { name: 'Pro', creditsPerMonth: 4000, priceUsd: 29.00, stripePriceId: process.env.STRIPE_PRICE_SUB_PRO || 'price_sub_pro_placeholder', sortOrder: 2 },
    { name: 'Business', creditsPerMonth: 20000, priceUsd: 99.00, stripePriceId: process.env.STRIPE_PRICE_SUB_BUSINESS || 'price_sub_business_placeholder', sortOrder: 3 },
  ];

  for (const sub of subs) {
    await prisma.subscription.upsert({
      where: { name: sub.name },
      update: { creditsPerMonth: sub.creditsPerMonth, priceUsd: sub.priceUsd, stripePriceId: sub.stripePriceId, sortOrder: sub.sortOrder },
      create: sub,
    });
  }
```

Same note about unique constraint on `name` applies to `Subscription` model.

- [ ] **Step 3: Add unique constraint on `name`**

Check current schema:

```powershell
Select-String -Path packages/server/prisma/schema.prisma -Pattern "model CreditPack" -Context 0,15
```

`name` currently has no unique constraint (`stripePriceId` is unique instead). Add `@@unique([name])` to both models in `packages/server/prisma/schema.prisma`:

In `model CreditPack`, before the closing `}`, add:
```prisma
  @@unique([name])
```

In `model Subscription`, before the closing `}`, add:
```prisma
  @@unique([name])
```

- [ ] **Step 3a: Check for existing duplicates before pushing schema**

If this database was previously seeded, check for duplicate names before adding the unique constraint (it will fail if duplicates exist):

```powershell
cd packages/server
$env:DATABASE_URL="<pooled_url>"
$env:DIRECT_URL="<direct_url>"
'SELECT name, COUNT(*) FROM "CreditPack" GROUP BY name HAVING COUNT(*) > 1;' | pnpm exec prisma db execute --stdin --schema prisma/schema.prisma
'SELECT name, COUNT(*) FROM "Subscription" GROUP BY name HAVING COUNT(*) > 1;' | pnpm exec prisma db execute --stdin --schema prisma/schema.prisma
```

If duplicates found, clean up manually (keep one row per name, delete extras) before proceeding.

- [ ] **Step 3b: Push schema changes**

```powershell
cd packages/server
pnpm db:push
```

- [ ] **Step 4: Verify seed runs locally**

Run: `cd packages/server && pnpm db:seed`
Expected: seeds without errors, uses placeholder values (no env vars set)

- [ ] **Step 5: Verify re-run is idempotent**

Run seed again: `cd packages/server && pnpm db:seed`
Expected: same 3 packs, 3 subs — no duplicates. Check with `pnpm db:studio`.

- [ ] **Step 6: Commit**

```bash
git add packages/server/prisma/seed.ts packages/server/prisma/schema.prisma
git commit -m "feat: make seed.ts read Stripe Price IDs from env vars, upsert by name"
```

---

## Chunk 2: Infrastructure Setup (sequential phases)

These tasks involve configuring external services. They must be done in order. Each task ends with a verification step.

**Prerequisites:** All code changes from Chunk 1 must be committed and pushed to `main` branch.

### Task 7: Phase 1 — Sentry Project Setup

**External service:** sentry.io

- [ ] **Step 1: Create Sentry project**

1. Go to https://sentry.io → Create Organization (or use existing)
2. Create new project: Platform = "Next.js", name = "devghost"
3. Note down: `SENTRY_ORG`, `SENTRY_PROJECT`, `NEXT_PUBLIC_SENTRY_DSN`

- [ ] **Step 2: Generate auth token**

1. Go to Settings → Auth Tokens → Create New Token
2. Scopes: `project:releases`, `org:read`
3. Note down: `SENTRY_AUTH_TOKEN`

- [ ] **Step 3: Verify values**

You should now have 4 values:
- `SENTRY_ORG` (e.g., "my-org")
- `SENTRY_PROJECT` (e.g., "devghost")
- `SENTRY_AUTH_TOKEN` (e.g., "sntrys_eyJ...")
- `NEXT_PUBLIC_SENTRY_DSN` (e.g., "https://xxx@xxx.ingest.sentry.io/xxx")

Save these — they'll be added to Vercel env vars in Task 9.

---

### Task 8: Phase 1 — Supabase Database Setup

**External service:** supabase.com (existing project)

- [ ] **Step 1: Verify Supabase project is active**

Go to Supabase Dashboard → check project is not paused. If paused, click "Restore".

- [ ] **Step 2: Get connection strings**

Go to Project Settings → Database → Connection String:
- `DATABASE_URL`: pooled connection (port 6543), append `?pgbouncer=true`
- `DIRECT_URL`: direct connection (port 5432)

- [ ] **Step 3: Apply schema to production database**

Set the production connection strings temporarily and run push:

```powershell
cd packages/server
$env:DATABASE_URL="<pooled_url>"; $env:DIRECT_URL="<direct_url>"; pnpm db:push
```

Expected: "Your database is now in sync with your Prisma schema."

- [ ] **Step 4: Run seed**

```powershell
cd packages/server
$env:DATABASE_URL="<pooled_url>"; $env:DIRECT_URL="<direct_url>"; pnpm db:seed
```

Expected: "Seeded 3 credit packs", "Seeded 3 subscriptions"

- [ ] **Step 5: Verify via Prisma Studio (optional)**

```powershell
cd packages/server
$env:DATABASE_URL="<pooled_url>"; $env:DIRECT_URL="<direct_url>"; pnpm db:studio
```

Check: SystemSettings, CreditPack, Subscription tables have data.

---

### Task 9: Phase 2 — Vercel Deployment

**External service:** vercel.com

- [ ] **Step 1: Connect GitHub repository**

1. Go to https://vercel.com/new
2. Import the `devghost` GitHub repository
3. **Framework Preset:** Next.js
4. **Root Directory:** `.` (repo root — leave default)
5. **Build Command:** `pnpm --filter @devghost/server build`
6. **Install Command:** `pnpm install`
7. **Output Directory:** `packages/server/.next`

- [ ] **Step 2: Set environment variables**

Add all variables from spec Section 4 in Vercel Dashboard → Project Settings → Environment Variables. Critical ones:

```
DATABASE_URL=postgresql://...@...supabase.co:6543/postgres?pgbouncer=true
DIRECT_URL=postgresql://...@...supabase.co:5432/postgres
AUTH_SECRET=<generate with: openssl rand -base64 32>
AUTH_URL=https://devghost.pro
NEXTAUTH_URL=https://devghost.pro
ADMIN_EMAIL=<your email>
SENTRY_ORG=<from Task 7>
SENTRY_PROJECT=<from Task 7>
SENTRY_AUTH_TOKEN=<from Task 7>
NEXT_PUBLIC_SENTRY_DSN=<from Task 7>
CRON_SECRET=<generate with: openssl rand -base64 32>
BILLING_ENABLED=false
```

Note: `PIPELINE_MODE`, `MODAL_ENDPOINT_URL`, `STRIPE_*` will be added in later phases. `BILLING_ENABLED=false` for now.

- [ ] **Step 3: Deploy**

Click "Deploy". Wait for build to complete.
Expected: Build succeeds. Site is accessible at `devghost-xxx.vercel.app`.

If build fails with "No Next.js version detected": verify Framework Preset is "Next.js" and `next` is in `packages/server/package.json` dependencies.

- [ ] **Step 4: Connect domain**

1. Go to Project Settings → Domains → Add `devghost.pro`
2. Vercel will provide DNS records (A record or CNAME)
3. Configure DNS at your domain registrar
4. Wait for DNS propagation (can take up to 48h, usually 5-30 min)

- [ ] **Step 5: Verify**

1. Open `https://devghost.pro` — site loads
2. Open `/login` — login page renders
3. Register a test account — works
4. Open `/dashboard` — dashboard accessible after login
5. Check browser console — no CSP violations
6. Check response headers — `Strict-Transport-Security`, `X-Frame-Options` present

**Note:** Analysis (create order → analyze) will NOT work until Task 12 (Modal) is completed. This is expected — only UI/auth/dashboard should be verified at this stage.

---

### Task 10: Phase 2.5 — GitHub OAuth

**External service:** github.com

- [ ] **Step 1: Create GitHub OAuth App**

1. Go to GitHub → Settings → Developer settings → OAuth Apps → New
2. Application name: "DevGhost"
3. Homepage URL: `https://devghost.pro`
4. Authorization callback URL: `https://devghost.pro/api/auth/callback/github`
5. Note down: `Client ID` and `Client Secret`

- [ ] **Step 2: Add env vars to Vercel**

```
GITHUB_CLIENT_ID=<from step 1>
GITHUB_CLIENT_SECRET=<from step 1>
```

Redeploy (or wait for auto-redeploy).

- [ ] **Step 3: Verify**

1. Open `https://devghost.pro/login`
2. Click "Sign in with GitHub"
3. Authorize the app
4. Should redirect to dashboard
5. Go to Settings → GitHub should show as connected
6. Check repos list loads

---

### Task 11: Phase 3 — External Cron Setup

**External service:** cron-job.org

- [ ] **Step 1: Register on cron-job.org**

Create free account at https://cron-job.org

- [ ] **Step 2: Create cron job**

1. Title: "DevGhost Watchdog"
2. URL: `https://devghost.pro/api/cron/analysis-watchdog`
3. Schedule: Every 5 minutes
4. Request method: GET
5. Headers: Add `Authorization: Bearer <CRON_SECRET value from Vercel env>`
6. Enable notifications on failure (optional)

- [ ] **Step 3: Verify**

1. Wait for next cron invocation (up to 5 min)
2. Check Vercel logs (Dashboard → Deployments → Functions): watchdog should return `{"ok":true,"processed":N}` where N >= 0 (0 means no jobs to process, which is expected on a fresh install)
3. Confirm no 401 errors (auth header is correct)

---

### Task 12: Phase 4 — Modal Worker Deployment

**External service:** modal.com

- [ ] **Step 1: Create Modal account**

1. Go to https://modal.com → Sign up
2. Install Modal CLI: `pip install modal`
3. Authenticate: `modal token new`

- [ ] **Step 2: Create Modal secrets**

```powershell
modal secret create devghost-db DIRECT_URL="<Supabase direct connection string>"

modal secret create devghost-llm OPENROUTER_API_KEY="<key>" OPENROUTER_MODEL="<model>" MODAL_WEBHOOK_SECRET="<generate a shared secret>"
```

- [ ] **Step 3: Deploy Modal app**

```bash
cd packages/modal
modal deploy app.py
```

Expected: outputs the webhook URL (e.g., `https://xxx--devghost-web-endpoint.modal.run`)

- [ ] **Step 4: Add env vars to Vercel**

```
PIPELINE_MODE=modal
MODAL_ENDPOINT_URL=<webhook URL from step 3>
MODAL_WEBHOOK_SECRET=<same secret used in step 2>
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=<key>
OPENROUTER_MODEL=<model>
```

Redeploy.

- [ ] **Step 5: End-to-end verification**

1. Log in to `https://devghost.pro`
2. Connect a GitHub repo (if not already)
3. Create an order with a small repo (~10-20 commits)
4. Click "Analyze"
5. Monitor progress on the order page (in production Modal mode, progress is tracked via DB polling, not SSE)
6. Modal job should reach `LLM_COMPLETE` status
7. Wait for next watchdog invocation (up to 5 min) — watchdog post-processes the job
8. Order should transition to `COMPLETED`
9. Verify Ghost% metrics are displayed

---

### Task 13: Phase 5 — Stripe Billing

**External service:** stripe.com

- [ ] **Step 1: Create Stripe products and prices (test mode)**

In Stripe Dashboard (test mode):
1. Create product "Starter Pack" → Add price: $9.00, one-time → Note `price_...` ID
2. Create product "Pro Pack" → Add price: $29.00, one-time → Note `price_...` ID
3. Create product "Business Pack" → Add price: $99.00, one-time → Note `price_...` ID
4. Create product "Basic Subscription" → Add price: $9.00/month, recurring → Note `price_...` ID
5. Create product "Pro Subscription" → Add price: $29.00/month, recurring → Note `price_...` ID
6. Create product "Business Subscription" → Add price: $99.00/month, recurring → Note `price_...` ID

- [ ] **Step 2: Sync Price IDs into database**

Re-run seed with real Stripe Price IDs:

```powershell
cd packages/server
$env:STRIPE_PRICE_STARTER="price_xxx"
$env:STRIPE_PRICE_PRO="price_xxx"
$env:STRIPE_PRICE_BUSINESS="price_xxx"
$env:STRIPE_PRICE_SUB_BASIC="price_xxx"
$env:STRIPE_PRICE_SUB_PRO="price_xxx"
$env:STRIPE_PRICE_SUB_BUSINESS="price_xxx"
$env:DATABASE_URL="<production pooled url>"
$env:DIRECT_URL="<production direct url>"
pnpm db:seed
```

Verify via Prisma Studio that `stripePriceId` fields now contain real `price_...` values (not placeholders).

- [ ] **Step 3: Configure Stripe webhook**

1. In Stripe Dashboard → Developers → Webhooks → Add endpoint
2. URL: `https://devghost.pro/api/billing/webhook`
3. Events to listen for: `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`, `customer.subscription.updated`
   **Important:** use `invoice.paid`, NOT `invoice.payment_succeeded` — the webhook handler in code (`billing/webhook/route.ts`) listens for `invoice.paid`.
4. Note the Webhook Signing Secret (`whsec_...`)

- [ ] **Step 4: Add env vars to Vercel**

```
BILLING_ENABLED=true
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_xxx
```

Redeploy.

- [ ] **Step 5: Verify billing (test mode)**

1. Go to Billing page on `https://devghost.pro`
2. Click "Buy" on a credit pack
3. Use Stripe test card: `4242 4242 4242 4242`, any future date, any CVC
4. Complete checkout
5. Verify credits appear in account balance
6. Check Stripe Dashboard → Events → webhook delivered successfully
7. Check `StripeEvent` table has an entry (idempotency check)

**Note:** When ready for production billing (first paying user), switch to live Stripe keys (`sk_live_...`, `pk_live_...`), create live products/prices, and re-seed with live Price IDs. See spec Section 8 (Hobby -> Pro Migration).

---

## Chunk 3: Final Verification & Hardening

### Task 14: Phase 6 — Smoke Test & Hardening

- [ ] **Step 1: Full end-to-end smoke test**

Walk through the entire user flow:
1. Open `https://devghost.pro` — site loads with HTTPS
2. Register new account with email
3. Login → dashboard accessible
4. Connect GitHub account
5. Browse repos → repos load
6. Create order → select repo → select developers
7. Start analysis → Modal job starts
8. Wait for completion → Ghost% metrics display
9. Check admin panel (login with `ADMIN_EMAIL` account)

- [ ] **Step 2: Verify security headers**

1. Go to https://securityheaders.com → enter `devghost.pro`
2. Verify: A+ or A rating
3. Check: HSTS, X-Frame-Options, CSP, X-Content-Type-Options all present
4. No CSP violations in browser console

- [ ] **Step 3: Verify Sentry**

1. Trigger a test error (e.g., visit a non-existent API route that throws)
2. Check Sentry Dashboard → error appears within 1 minute
3. Check that source maps are uploaded (stack trace shows readable code)
4. Verify `tunnelRoute` works: check browser network tab, Sentry requests go to `/monitoring` not directly to sentry.io
5. Configure Sentry alert rules: Settings → Alerts → Create Alert → "When a new issue is created" → send email notification

- [ ] **Step 4: Set up uptime monitoring**

1. Register on UptimeRobot (free)
2. Add monitor: HTTP(S), URL: `https://devghost.pro`, interval: 5 min
3. Set up alert contact (email)
4. Verify first check passes

- [ ] **Step 5: Take Supabase backup**

1. Go to Supabase Dashboard → Database → Backups
2. Note: Free tier has automatic daily backups
3. Optionally export a manual SQL dump via Supabase CLI

- [ ] **Step 6: Update spec status**

Change spec document status from "Draft" to "Deployed":

```powershell
cd C:\Projects\devghost
(Get-Content docs/superpowers/specs/2026-03-14-production-deployment-design.md) -replace 'Status: Draft', 'Status: Deployed' | Set-Content docs/superpowers/specs/2026-03-14-production-deployment-design.md
git add docs/superpowers/specs/2026-03-14-production-deployment-design.md
git commit -m "docs: mark production deployment spec as deployed"
```
