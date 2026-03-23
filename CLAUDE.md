# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**DevGhost** — Developer Efficiency Analytics platform. Monorepo (pnpm workspaces) that analyzes Git repositories, estimates commit effort via LLM, calculates Ghost% productivity metrics per developer, and provides visualizations. Includes billing (Stripe credits/subscriptions), public analytics sharing, admin panel, and a Modal serverless pipeline for production workloads.

## Development Commands

### Setup and Installation
```powershell
pnpm install
```

### Database Commands
```powershell
cd packages/server

pnpm db:push       # Apply schema changes to database
pnpm db:migrate    # Create a new migration
pnpm db:seed       # Seed SystemSettings, CreditPacks, Subscriptions
pnpm db:studio     # Open Prisma Studio
pnpm db:generate   # Generate Prisma client after schema changes
```

### Development
```powershell
cd packages/server

pnpm dev      # Dev server (http://localhost:3000)
pnpm build    # Production build
pnpm start    # Production server
pnpm lint     # ESLint
pnpm test     # Tests (vitest)
```

### Database Setup
1. Create project at [Supabase](https://supabase.com/dashboard) (or use existing)
2. Configure in `packages/server/.env` (see `.env.example`):
   - `DATABASE_URL` — pooled connection via PgBouncer (port 6543, for runtime queries)
   - `DIRECT_URL` — direct connection (port 5432, for Prisma CLI: `db push`, `migrate`)
3. Run `pnpm db:push` to create tables
4. Run `pnpm db:seed` to create SystemSettings, credit packs, subscriptions

> Local PostgreSQL (`localhost:5432/dea_db`) also works — set only `DATABASE_URL`, omit `DIRECT_URL`.

## Architecture

### Tech Stack
- **Framework**: Next.js 16.1.0 (App Router) with React 19
- **Database**: PostgreSQL (Supabase) with Prisma 6.19
- **Authentication**: NextAuth.js v5-beta.25 (Credentials + GitHub OAuth)
- **UI Components**: shadcn/ui (Radix UI + Tailwind CSS)
- **Payments**: Stripe (credits, subscriptions, webhooks)
- **Validation**: Zod
- **State Management**: TanStack Query + React hooks
- **Charts**: Recharts
- **Type Safety**: TypeScript (strict mode)
- **Monorepo**: pnpm workspaces

### Workspace Structure

```
devghost/
├── packages/
│   ├── server/          # Next.js web application (main)
│   ├── shared/          # Shared types, constants, utilities (@devghost/shared)
│   ├── modal/           # Modal serverless worker (Python) — LLM analysis pipeline
│   └── mobile/          # React Native mobile app (placeholder)
├── package.json         # Root workspace config
├── pnpm-workspace.yaml
└── tsconfig.base.json   # Shared TS config
```

### Server Package Structure

```
packages/server/
├── prisma/
│   ├── schema.prisma          # Prisma schema (20 models, 9 enums)
│   └── seed.ts                # Seeds SystemSettings, CreditPacks, Subscriptions
├── scripts/pipeline/          # Python LLM pipeline (run_v16_pipeline.py, run_devghost_pipeline.py, file_decomposition.py)
├── src/
│   ├── app/
│   │   ├── (auth)/            # Login, Register pages
│   │   ├── (dashboard)/       # Protected: dashboard, orders, settings, demo,
│   │   │                      #   admin, billing, profile, publications
│   │   ├── (public)/          # Public: dev profiles, explore, share links
│   │   └── api/               # API routes (65 route files)
│   │       ├── admin/         # Admin panel (users, orders, promo, monitoring, LLM settings)
│   │       ├── auth/          # NextAuth + registration
│   │       ├── billing/       # Credits, subscriptions, Stripe webhook
│   │       ├── cache/         # LLM cache management
│   │       ├── cron/          # analysis-watchdog (Modal job heartbeat)
│   │       ├── demo/          # Demo order creation
│   │       ├── dev/           # Developer public profiles
│   │       ├── explore/       # Public repo analytics
│   │       ├── github/        # GitHub OAuth, repos, search, contributors
│   │       ├── llm/           # LLM model listing
│   │       ├── orders/        # Order CRUD + 13 sub-routes (analyze, metrics, benchmark, etc.)
│   │       ├── publications/  # Repo publication management
│   │       ├── referral/      # Referral system
│   │       ├── share/         # Share token access
│   │       └── user/          # User profile
│   ├── components/
│   │   ├── ui/                # shadcn/ui base components (29 files)
│   │   ├── layout/            # header.tsx, sidebar.tsx
│   │   ├── providers.tsx      # SessionProvider + QueryClientProvider + Toaster
│   │   └── *.tsx              # 31 feature components (flat structure, no subdirs)
│   ├── lib/
│   │   ├── auth.ts            # NextAuth config (Credentials + GitHub providers)
│   │   ├── auth.config.ts     # Route protection config, JWT 30-day maxAge
│   │   ├── db.ts              # Prisma client singleton
│   │   ├── constants.ts       # Re-exports from @devghost/shared + server-only constants
│   │   ├── api-utils.ts       # apiResponse, apiError, requireUserSession, requireAdmin, getOrderWithAuth
│   │   ├── logger.ts          # Pino logger (logger, analysisLogger, pipelineLogger, gitLogger, billingLogger)
│   │   ├── utils.ts           # cn(), formatDate(), formatPercentage(), normalizeDecimals()
│   │   ├── stripe.ts          # Stripe client singleton, getOrCreateStripeCustomer
│   │   ├── llm-config.ts      # LLM provider config (reads SystemSettings, falls back to env)
│   │   ├── github-client.ts   # GitHub API client, token validation
│   │   ├── deduplication.ts   # Developer matching (Levenshtein, name/email strategies)
│   │   ├── explore-utils.ts   # Repo activity filtering
│   │   ├── audit.ts           # Fire-and-forget audit logging
│   │   └── services/          # Business logic services
│   │       ├── analysis-worker.ts     # Main analysis orchestrator
│   │       ├── ghost-metrics-service.ts # Ghost% calculation + OrderMetric persistence
│   │       ├── credit-service.ts      # Credit balance, reserve/debit/release
│   │       ├── git-operations.ts      # Git clone, commit extraction
│   │       ├── pipeline-bridge.ts     # Local vs Modal pipeline routing
│   │       ├── job-registry.ts        # AnalysisJob lifecycle management
│   │       ├── pipeline-log-store.ts  # SSE log streaming
│   │       ├── scope-filter.ts        # Period/date range filtering
│   │       ├── publication-metrics.ts # Public analytics aggregation
│   │       ├── promo-service.ts       # Promo code validation/redemption
│   │       ├── referral-service.ts    # Referral tracking
│   │       └── index.ts              # Barrel export
│   ├── hooks/
│   │   ├── use-analysis-period.ts
│   │   ├── use-model-preferences.ts
│   │   └── use-toast.ts
│   └── types/
│       ├── next-auth.d.ts     # NextAuth type extensions (id, role on Session)
│       └── repository.ts      # Repository/search types
├── middleware.ts               # Route protection (see Auth section)
└── .env                       # Not committed — see .env.example
```

### Modal Package (Python)

```
packages/modal/
├── app.py              # Modal App definition, webhook endpoint
├── worker.py           # run_analysis() — clone, extract, LLM estimation
├── git_ops.py          # Git operations (Python port of git-operations.ts)
├── db.py               # Direct Supabase/PostgreSQL connection
├── rate_limiter.py     # OpenRouter QPS rate limiter
└── requirements.txt
```

Triggered by server via webhook when `PIPELINE_MODE=modal`. Runs heavy LLM analysis in Modal serverless, reports progress back via DB updates. Server's cron watchdog monitors heartbeats.

### Core Data Model

**Hybrid architecture**: JSONB for flexible input data, normalized tables for metrics and billing.

**Analysis flow:**
1. **User** → creates **Order** (selectedRepos, selectedDevelopers as JSONB)
2. **Order** → spawns **AnalysisJob** (executionMode: `local` | `modal`)
3. **AnalysisJob** → creates **CommitAnalysis** records (per-commit LLM estimates)
4. **CommitAnalysis** → spread into **DailyEffort** rows (effort spreading algorithm)
5. **DailyEffort** → aggregated into **OrderMetric** (Ghost% per developer per period)

**Billing:**
- **CreditTransaction** (11 types: REGISTRATION, PACK_PURCHASE, SUBSCRIPTION_RENEWAL, SUBSCRIPTION_EXPIRY, PROMO_REDEMPTION, REFERRAL_BONUS, REFERRAL_REWARD, ANALYSIS_RESERVE, ANALYSIS_DEBIT, ANALYSIS_RELEASE, ADMIN_ADJUSTMENT)
- **CreditPack** / **Subscription** / **UserSubscription** / **PromoCode** / **PromoRedemption**
- **StripeEvent** (webhook idempotency)

**Public sharing:**
- **RepoPublication** (share token, curated flag)
- **DeveloperProfile** (public profile pages)

**System:**
- **SystemSettings** (singleton: LLM provider config, pricing, referral settings)
- **AuditLog** (user action audit trail)
- **DeveloperSettings** (per-order per-developer: share%, exclusion)
- **GroundTruth** (expert manual estimates for benchmarking)
- **Referral** (user-to-user referral relationships)

### Order Status Flow

```
DRAFT → DEVELOPERS_LOADED → READY_FOR_ANALYSIS → PROCESSING → COMPLETED
                                                             ↘ FAILED
                                                             ↘ INSUFFICIENT_CREDITS
```

### AnalysisJob Status Flow

```
PENDING → RUNNING → LLM_COMPLETE → COMPLETED
                  ↘ FAILED_RETRYABLE (watchdog retries)
                  ↘ FAILED_FATAL (needs human intervention)
                  ↘ CANCELLED
```

`FAILED` — legacy alias for FAILED_FATAL. `LLM_COMPLETE` — Modal finished, Vercel post-processing pending.

### Ghost Metrics System

Primary productivity metric. Implemented in `@devghost/shared` (formulas) + `lib/services/ghost-metrics-service.ts` (orchestration).

**Core constants** (`@devghost/shared`):
- `GHOST_NORM = 3.0` — baseline productive hours/day
- `MAX_DAILY_EFFORT = 5` — ceiling per day (spreading cap)
- `MAX_SPREAD_DAYS = 5` — max days a commit spreads backward
- Thresholds: EXCELLENT ≥120%, GOOD ≥100%, WARNING ≥80%, LOW <80%

**Formulas** (where `avg_daily = totalEffortHours / workDays`):
```
Ghost% (raw)      = (avg_daily / GHOST_NORM) × 100
Ghost% (adjusted) = (avg_daily / (GHOST_NORM × share)) × 100
Share (auto)       = commits_this_order / commits_all_orders
Work days          = spreadResult.dayMap.size (from effort spreading algorithm)
```

**Effort spreading**: Commits are distributed backward across weekdays (up to 5 days, max 5h/day cap). Excess becomes overhead. Uses `spreadEffort()` from shared package.

**Eligible periods**: ALL_TIME, YEAR, QUARTER, MONTH. Heatmap-only: WEEK, DAY.

**Analysis period modes**: ALL_TIME, SELECTED_YEARS, DATE_RANGE, LAST_N_COMMITS.

## API Endpoints

### Auth
- `POST /api/auth/register` — registration (ADMIN_EMAIL gets admin role)
- `/api/auth/[...nextauth]` — NextAuth (GET, POST)

### GitHub
- `GET|POST|DELETE /api/github/connect` — OAuth token management
- `GET /api/github/repos` — user's repos
- `GET /api/github/search` — search repos
- `GET /api/github/public` — public repos
- `GET /api/github/period-stats` — commit stats for period
- `GET /api/github/repos/date-range` — available date range
- `GET /api/github/repos/[owner]/[repo]/contributors` — repo contributors

### Orders
- `GET|POST /api/orders` — list / create
- `GET|PUT|DELETE /api/orders/[id]` — read / update / delete
- `POST /api/orders/[id]/analyze` — start analysis
- `POST /api/orders/[id]/developers` — extract developers from commits
- `POST /api/orders/[id]/mapping` — save developer deduplication mapping
- `GET /api/orders/[id]/metrics` — calculated metrics
- `GET /api/orders/[id]/commits` — commit analysis details
- `GET /api/orders/[id]/progress` — analysis progress (SSE)
- `GET /api/orders/[id]/daily-effort` — distributed effort data
- `GET /api/orders/[id]/effort-timeline` — timeline visualization
- `GET|POST|DELETE /api/orders/[id]/ground-truth` — expert estimates
- `GET|POST /api/orders/[id]/benchmark` — benchmark analysis
- `GET /api/orders/[id]/benchmark/compare` — benchmark comparison
- `GET|DELETE /api/orders/[id]/benchmark/[jobId]` — specific benchmark job
- `GET|PATCH /api/orders/[id]/developer-settings` — per-developer settings
- `POST /api/orders/[id]/update-analysis` — re-run analysis
- `POST /api/orders/[id]/jobs/[jobId]/cancel` — cancel job

### Billing
- `GET /api/billing/balance` — credit balance
- `GET /api/billing/packs` — available credit packs
- `POST /api/billing/checkout` — Stripe checkout session
- `POST /api/billing/subscribe` — create subscription
- `GET /api/billing/subscriptions` — active subscriptions
- `POST /api/billing/cancel-subscription` — cancel subscription
- `GET /api/billing/transactions` — transaction history
- `POST /api/billing/redeem` — redeem promo code
- `POST /api/billing/webhook` — Stripe webhook

### Publications & Sharing
- `GET|POST /api/publications` — list / create
- `PATCH|DELETE /api/publications/[id]` — manage publication
- `GET /api/share/[token]` — access shared analysis
- `GET /api/dev/[slug]` — developer profile
- `GET /api/dev/[slug]/metrics` — developer metrics
- `GET /api/explore` — public repo directory
- `GET /api/explore/[owner]/[repo]` — public repo analytics

### Admin
- `GET /api/admin/stats` — dashboard stats
- `GET /api/admin/users` — user list
- `PATCH|DELETE /api/admin/users/[id]` — manage user
- `POST /api/admin/users/[id]/reset-password` — reset password
- `GET /api/admin/orders` — all orders
- `DELETE /api/admin/orders/[id]` — delete order
- `POST /api/admin/orders/[id]/rerun` — re-run analysis
- `GET|PATCH /api/admin/llm-settings` — LLM provider config
- `GET /api/admin/monitoring` — system monitoring
- `GET /api/admin/openrouter-models` — available models
- `GET|POST /api/admin/promo-codes` — promo code management
- `PATCH|DELETE /api/admin/promo-codes/[id]` — manage promo code
- `GET /api/admin/billing/stats` — billing stats
- `POST /api/admin/credits/adjust` — manual credit adjustment
- `GET /api/admin/audit` — audit log
- `GET|POST /api/admin/publications` — publication curation
- `PATCH|DELETE /api/admin/publications/[id]` — publication moderation

### System
- `GET|DELETE /api/cache` — LLM response cache
- `GET /api/cron/analysis-watchdog` — Modal job heartbeat monitor (Vercel cron)
- `GET /api/llm/models` — available LLM models
- `GET /api/llm-info` — current LLM config
- `GET|PATCH /api/user/profile` — user profile
- `GET /api/referral` — referral info
- `GET|POST|PATCH /api/profile` — developer profile management
- `POST /api/demo` — create demo order

## Authentication & Authorization

- NextAuth.js v5-beta.25 with Credentials and GitHub OAuth providers
- JWT session strategy, 30-day maxAge
- GitHub OAuth scope: `read:user user:email repo`
- GitHub access token stored in DB (`User.githubAccessToken`), **NOT exposed to client session** (security)
- GitHub token fetched server-side in API routes via `lib/github-client.ts`
- Session exposes: `id`, `email`, `role` (USER | ADMIN)
- Admin role assigned at registration if email matches `ADMIN_EMAIL` env var (case-insensitive)
- Middleware protects: `/dashboard/*`, `/orders/*`, `/demo/*`, `/settings/*`, `/admin/*`, `/billing/*`, `/publications/*`, `/profile/*`
- Auth pages (`/login`, `/register`) redirect authenticated users to dashboard

## Environment Variables

Required in `packages/server/.env` (see `.env.example` for full reference):

**Database (required):**
- `DATABASE_URL` — Supabase pooled connection (port 6543, `?pgbouncer=true`)
- `DIRECT_URL` — Supabase direct connection (port 5432, for Prisma CLI)

**Auth (required):**
- `AUTH_SECRET` — generate with `openssl rand -base64 32`
- `AUTH_URL` — e.g., `http://localhost:3000`

**GitHub (optional):**
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — for GitHub OAuth login + repo access

**Admin:**
- `ADMIN_EMAIL` — email that gets ADMIN role on registration

**LLM Provider:**
- `LLM_PROVIDER` — `ollama` (default) or `openrouter`
- `OLLAMA_URL` — default `http://localhost:11434`
- `OLLAMA_MODEL` — default `qwen2.5-coder:32b`
- `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` — for cloud LLM
- `OPENROUTER_PROVIDER_ORDER`, `OPENROUTER_PROVIDER_IGNORE` — routing preferences
- `OPENROUTER_ALLOW_FALLBACKS`, `OPENROUTER_REQUIRE_PARAMETERS` — reliability settings
- `LLM_CONCURRENCY` — parallel requests (auto: 10 for openrouter, 1 for ollama)

**Pipeline:**
- `PIPELINE_MODE` — `local` (default) or `modal` (production)
- `MODAL_ENDPOINT_URL` — Modal webhook URL (when mode=modal)
- `MODAL_WEBHOOK_SECRET` — shared secret for Modal auth
- `CRON_SECRET` — Vercel cron job auth

**Billing (optional):**
- `BILLING_ENABLED` — `false` by default (all users can analyze without credits)
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`

## Path Aliases

TypeScript paths configured in `packages/server/tsconfig.json`:
- `@/*` → `./src/*`
- `@devghost/shared` / `@devghost/shared/*` → `../shared/src`

Example: `import { db } from '@/lib/db'`

## Important Implementation Notes

1. **JSONB Storage**: Repositories (`selectedRepos`) and developers (`selectedDevelopers`, `developerMapping`) are stored as JSONB in the Order table. Normalized tables (CommitAnalysis, DailyEffort, OrderMetric) are used for calculated data.

2. **Developer Deduplication**: The `developerMapping` JSONB field stores merged developer identities:
   ```json
   {
     "primary_email": {
       "primary": {...},
       "merged_from": [...]
     }
   }
   ```

3. **Prisma Client**: Always import from `@/lib/db` which provides a singleton instance.

4. **API Helpers**: Use `api-utils.ts` — `requireUserSession()`, `requireAdmin()`, `getOrderWithAuth()` for auth + order access in one call.

5. **Seed script**: Seeds SystemSettings (LLM config), CreditPacks (Starter/Pro/Business), Subscriptions, and creates partial unique index on CommitAnalysis (required for Modal). Does NOT create demo users. Demo data is created via `/api/demo` endpoint.

6. **Pipeline modes**: `PIPELINE_MODE=local` runs Python subprocess on server. `PIPELINE_MODE=modal` triggers Modal serverless via webhook. Cron watchdog at `/api/cron/analysis-watchdog` monitors Modal job heartbeats.

7. **LLM config**: Read from `SystemSettings` table (admin-editable), falls back to env vars. Managed via `lib/llm-config.ts`.

## Common Development Patterns

1. **API Routes**: Use `api-utils.ts` helpers — `apiResponse()`, `apiError()`, `requireUserSession()`, `requireAdmin()`
2. **Database Access**: Import prisma from `@/lib/db`
3. **Authentication**: Use `auth()` from `@/lib/auth` in Server Components
4. **Type Safety**: Prisma-generated types; extend in `src/types/`
5. **Styling**: Tailwind utilities; component variants via `class-variance-authority`
6. **Shared code**: Import constants/utils from `@devghost/shared` for Ghost metrics formulas
7. **Audit logging**: Use `auditLog()` from `@/lib/audit` for user action tracking

## Testing

- Demo endpoint: `POST /api/demo` creates sample order with mock data
- Access Prisma Studio: `pnpm db:studio` for direct database inspection
- Tests: `pnpm test` in packages/server (vitest)

## Ollama LLM Estimation Pipeline — Critical Settings

**MANDATORY** for all `call_ollama` / Ollama API calls in evaluation scripts:

```python
"options": {
    "temperature": 0,
    "num_predict": max_tokens,
    "num_ctx": 32768,   # ОБЯЗАТЕЛЬНО! Дефолт ollama = 4096, обрезает промпты
    "seed": 42,         # Воспроизводимость результатов
}
```

**Почему это критично**:
- Без `num_ctx=32768` ollama использует дефолт 4096 токенов и молча обрезает входной промпт
- С правильным контекстом простые коммиты оцениваются точнее (rename 4.0→0.5h)
- `seed=42` обеспечивает воспроизводимость — ранее результаты плавали между прогонами

**При создании нового скрипта с Ollama** — всегда добавлять `num_ctx: 32768` и `seed: 42`.

**НИКОГДА не скачивай модели Ollama автоматически** (`ollama pull`). Пользователю нужно отключить VPN перед скачиванием, чтобы не расходовать лимит трафика. Всегда спрашивай перед `ollama pull`.

## Server Logging — Pino

**НИКОГДА не используй `console.log` / `console.error`** в серверном коде. Используй pino logger из `@/lib/logger`.

```typescript
import { analysisLogger } from '@/lib/logger';
// или: import { logger, pipelineLogger, gitLogger, billingLogger } from '@/lib/logger';

// Синтаксис: сначала объект с данными, потом строка-сообщение
log.info({ orderId, repoCount: 3 }, 'Analysis started');
log.error({ err }, 'Clone failed');
log.warn({ field: 'cloneUrl' }, 'Missing field');
log.debug({ sha: commit.sha }, 'Processing commit');

// Child logger — добавляет контекст ко всем записям
const log = analysisLogger.child({ jobId });
const rlog = log.child({ repo: 'owner/name' });
rlog.info('Cloning'); // автоматически содержит jobId + repo
```

**Логи пишутся в два места:**
- Консоль — pretty-printed (dev) / JSON (prod)
- Файл — `.logs/server-YYYY-MM-DD.log` (pino-roll, ротация daily, 14 файлов)

**Чтение логов:** `Read .logs/server-YYYY-MM-DD.log` — для диагностики без запроса у пользователя.

**Уровни:** `debug` < `info` < `warn` < `error` < `fatal`. В dev все уровни, в prod — `info+`.

**FD fallback порог**: Динамически рассчитывается в `scripts/pipeline/run_v16_pipeline.py` на основе контекстного окна модели. При дефолте 32K контекста: `(32768 - 2048 - 1024) × 2.0 ≈ 59392` символов (~60K). Диффы сверх этого порога идут в FD heuristic, иначе Ollama молча обрезает промпт.
