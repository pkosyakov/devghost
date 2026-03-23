# UX Audit Fixes — Design Document

**Date**: 2026-03-04
**Branch**: feat/modal-integration
**Scope**: 10 verified UX issues from Chrome-based product audit

## Summary

Full product audit via Chrome browser identified 10 verified issues across 4 categories: critical bugs, localization gaps, missing dashboard metrics, and UX polish. Implementation is split into 4 phases by layer.

## Verified Issues

| # | Issue | Phase |
|---|-------|-------|
| 1 | Admin auth — proxy JWT doesn't decode role, admin redirected to dashboard | Phase 1 |
| 2 | Sidebar — duplicate "Биллинг"/"Настройки" labels for different routes | Phase 1 |
| 3 | i18n — dashboard/orders/billing/settings/admin pages not localized | Phase 2 |
| 4 | Dashboard — no Avg Ghost% stat card (key product metric missing) | Phase 3 |
| 5 | Dashboard — Recent Orders don't show Ghost% metrics | Phase 3 |
| 6 | Developer table header not sticky — columns lost on scroll | Phase 4 |
| 7 | Single-developer orders show extreme Ghost% without explanation | Phase 4 |
| 8 | Explore — empty state, no CTA, no dashboard link for logged-in users | Phase 4 |
| 9 | Billing — meaningless empty state when billing disabled | Phase 4 |
| 10 | Explore public header — shows "Войти" even for logged-in users | Phase 4 |

## Phase 1 — Critical Bugs

### 1.1 Admin auth fix in proxy

**Root cause**: `auth-middleware.ts` creates `NextAuth(authConfig)` where `authConfig` has no JWT callback. The `role` field is never propagated from token to session in edge runtime.

**Fix**: Add edge-safe JWT/session callbacks to `auth.config.ts`:
- `jwt({ token, user })`: if user exists (login), copy `user.role` to `token.role`
- `session({ session, token })`: copy `token.role` to `session.user.role`
- No Prisma/logger imports — stays edge-compatible
- Full `auth.ts` keeps its DB-refresh JWT callback that extends the base

**Files**: `src/lib/auth.config.ts`

### 1.2 Sidebar label differentiation

**Fix**: Update i18n keys for admin section:
- `admin.billing` → "Billing Stats" / "Статистика биллинга"
- `admin.settings` → "LLM Settings" / "Настройки LLM"

**Files**: `messages/en.json`, `messages/ru.json`

## Phase 2 — Full i18n

### Scope

~250 new keys across all app pages. Current coverage: ~150 keys (sidebar, auth, landing). Target: full coverage.

### Key namespace structure

```
dashboard.*         — title, description, stat cards, recent orders section
orders.*            — list page title, filters, empty state
orders.detail.*     — overview, tabs, actions (publish, edit scope, re-analyze)
orders.new.*        — wizard title, repo selection, analysis name
orders.metrics.*    — table column headers (commits, workDays, effort, avgDaily, overhead, share, ghost%)
billing.*           — balance labels, packs, subscriptions, promo, free mode message
settings.*          — profile section, github section, cache section
publications.*      — table headers, actions, empty state
admin.*             — all sub-pages (users, orders, monitoring, audit, promo, billing stats, llm settings)
explore.*           — title, description, search, empty state, CTA
components.*        — ghost-developer-table, kpi-cards, benchmark-launcher, period-selector
```

### Integration approach

- Server Components: `getTranslations()` from `next-intl/server`
- Client Components: `useTranslations()` hook
- No architectural changes — next-intl already configured

### Priority order

1. Dashboard → 2. Orders list + detail → 3. Billing + Settings → 4. Publications + Explore → 5. Admin → 6. Shared components

**Files**: `messages/en.json`, `messages/ru.json`, ~15 page/component files

## Phase 3 — Dashboard Metrics

### 3.1 Avg Ghost% stat card

Replace "Completion Rate" card (100% when all completed — useless) with "Avg Ghost%". Aggregate `metrics.avgGhostPercent` from orders API response (already returned). Color by thresholds from `@devghost/shared`: green >=100%, yellow >=80%, red <80%.

### 3.2 Recent Orders with metrics

Add Ghost% badge next to status for completed orders: `COMPLETED · Ghost 104%` with color coding. Data already available from API.

**Files**: `src/app/[locale]/(dashboard)/dashboard/page.tsx`

## Phase 4 — UX Polish

### 4.1 Sticky developer table header

Add `sticky top-0 z-10 bg-background` to `<TableHeader>` in ghost-developer-table.

**Files**: `src/components/ghost-developer-table.tsx`

### 4.2 Single-developer warning

If `developerCount === 1`, show info tooltip on Ghost% KPI card: "Single developer — Ghost% reflects absolute effort vs 3h/day norm".

**Files**: `src/components/ghost-kpi-cards.tsx`

### 4.3 Explore empty state + navigation

- Add CTA below repo list: "Publish your analysis" → `/publications`
- In public header: show "Dashboard" link for authenticated users instead of "Войти"

**Files**: `src/app/[locale]/(public)/explore/page.tsx`, public layout/header

### 4.4 Billing meaningful empty state

Check `BILLING_ENABLED` env var. If false: "Free mode — unlimited analyses". If true but no packs: "Credit packs coming soon".

**Files**: `src/app/[locale]/(dashboard)/billing/page.tsx`

## Rejected/Corrected Items from Original Audit

| Original claim | Verdict |
|---|---|
| Admin section visible to non-admins | WRONG — sidebar gated by `role === 'ADMIN'` |
| CTA block has no button | WRONG — button exists below viewport |
| Footer is empty | EXAGGERATION — minimal but has brand+version |
| Benchmark toolbar always visible | WRONG — only shown for COMPLETED orders |
| Dark mode "unfinished" | EXAGGERATION — feature simply doesn't exist, `suppressHydrationWarning` is Next.js convention |
