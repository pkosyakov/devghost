# User Testing Plan — DevGhost Code Review Fix (28 issues)

**Date:** 2026-02-14
**Commit:** `aa0939f` (feat/devghost)
**Scope:** 47 files changed, -4655/+152 lines, 11 files deleted

## Prerequisites

### Database Setup (Supabase)

1. Create a Supabase project at https://supabase.com/dashboard
2. Copy connection strings from **Settings > Database > Connection string (URI)**
3. Update `.env` with your Supabase `DATABASE_URL` and `DIRECT_URL`
4. Push schema and seed data:

```bash
cd devghost/packages/server
npx prisma generate
pnpm db:push        # creates all tables on clean Supabase DB
pnpm db:seed        # seeds demo user + sample data
```

### Start Server

```bash
pnpm dev
```

Open `http://localhost:3000`. Need demo user (`demo@example.com` / `demo123`) or fresh registration.

---

## 1. Security (C1-C4)

| # | Test | Steps | Expected |
|---|------|-------|----------|
| S1 | Clone-url route deleted | `GET /api/github/clone-url?repo=test/test` | 404 Not Found |
| S2 | Browse-directory deleted | `POST /api/system/browse-directory` | 404 Not Found |
| S3 | Auth on /orders | Open `/orders` without login | Redirect to `/login` |
| S4 | Auth on /demo | Open `/demo` without login | Redirect to `/login` |
| S5 | Auth on /settings | Open `/settings` without login | Redirect to `/login` |
| S6 | Login redirect | Open `/dashboard` without login, then login | Redirect back to `/dashboard` |

---

## 2. Branding

| # | Test | Steps | Expected |
|---|------|-------|----------|
| B1 | Landing page | Open `/` | Logo "DG", title "DevGhost", English text, Ghost % features |
| B2 | Login page | Open `/login` | Logo "DG", text "DevGhost" (not "DEA") |
| B3 | Register page | Open `/register` | Logo "DG", text "DevGhost" |
| B4 | Sidebar | Login, check sidebar | Logo "DG / DevGhost / Ghost % Analytics", no "Core Analytics" section |
| B5 | Page title | Check browser tab | "DevGhost -- Ghost % Analytics" |

---

## 3. Navigation & Layout

| # | Test | Steps | Expected |
|---|------|-------|----------|
| N1 | Sidebar links | Click Dashboard, Orders, Demo, Settings | All navigate correctly |
| N2 | No dead links | Check sidebar | No Repositories, Developers, Metrics links |
| N3 | Header -- no search | Check top bar | No search input, no notification bell |
| N4 | Header -- Settings | Click avatar -> Settings | Navigates to `/settings` |
| N5 | Header -- Sign out | Click avatar -> Sign out | Logs out, redirects to `/` |
| N6 | Sidebar -- Sign out | Click "Sign out" in sidebar | Logs out, redirects to `/` |

---

## 4. Orders Flow

| # | Test | Steps | Expected |
|---|------|-------|----------|
| O1 | Orders list | Open `/orders` | No crash (was crashing on `totalCost.toLocaleString()`) |
| O2 | New order page | Open `/orders/new` | No "Analysis Settings" card, no Settings2 icon |
| O3 | New order -- create | Select repo, click Continue | Creates order, no `aiProvider`/`processingMode` in request body |
| O4 | Demo order | Go to `/demo`, create demo | Order created with `complexity: 'moderate'` |

---

## 5. Order Detail (Completed Order)

| # | Test | Steps | Expected |
|---|------|-------|----------|
| D1 | Overview tab | Open completed order | KPI cards, bubble chart, developer table render |
| D2 | Commits tab | Click "Commits" tab | CommitAnalysisTable renders (not placeholder text) |
| D3 | Calendar tab | Click "Effort Calendar" tab | Shows "Available after pipeline integration" |
| D4 | Period selector | Change period to YEAR/MONTH | Metrics reload (or empty if no data for that period) |

---

## 6. API Hardening

| # | Test | Steps | Expected |
|---|------|-------|----------|
| A1 | Invalid period | `GET /api/orders/{id}/metrics?period=INVALID` | 400 "Invalid period" |
| A2 | Valid periods | `?period=ALL_TIME`, `YEAR`, `QUARTER`, `MONTH` | 200 OK |
| A3 | PUT order -- no status | `PUT /api/orders/{id}` with `{"status": "COMPLETED"}` | Status NOT changed |
| A4 | Mapping -- conditional | Save mapping when status is DRAFT | Status stays DRAFT (not forced to READY_FOR_ANALYSIS) |
| A5 | Analysis -- fails | Start analysis on order with repos | Status becomes FAILED (pipeline not implemented) |

---

## 7. Quick API Smoke (curl / browser devtools)

```bash
# S1 -- should 404
curl -s http://localhost:3000/api/github/clone-url | jq .

# S2 -- should 404
curl -s -X POST http://localhost:3000/api/system/browse-directory | jq .

# A1 -- should 400
curl -s -H "Cookie: ..." http://localhost:3000/api/orders/{id}/metrics?period=WEEKLY | jq .
```

---

## Critical Path (minimum viable test)

If time is limited, test only these 8 items:

1. **S1** -- clone-url route returns 404
2. **S3** -- `/orders` requires auth
3. **B1** -- landing page shows DevGhost
4. **N5** -- sign out works from header
5. **O1** -- orders list doesn't crash
6. **O2** -- new order has no Analysis Settings
7. **D2** -- commits tab shows table
8. **A5** -- analysis properly fails (not silent success)

---

## Test Results

| # | Pass/Fail | Notes |
|---|-----------|-------|
| S1 | | |
| S2 | | |
| S3 | | |
| S4 | | |
| S5 | | |
| S6 | | |
| B1 | | |
| B2 | | |
| B3 | | |
| B4 | | |
| B5 | | |
| N1 | | |
| N2 | | |
| N3 | | |
| N4 | | |
| N5 | | |
| N6 | | |
| O1 | | |
| O2 | | |
| O3 | | |
| O4 | | |
| D1 | | |
| D2 | | |
| D3 | | |
| D4 | | |
| A1 | | |
| A2 | | |
| A3 | | |
| A4 | | |
| A5 | | |
