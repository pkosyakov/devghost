# Public Analytics Sharing — Design Document

**Date:** 2026-02-26
**Status:** Approved (rev.2 — post-review fixes)

## Overview

Enable users to publish and share analytics about repositories and themselves, and allow admins to curate showcase publications of public repos to drive user interest and organic traffic.

## Core Concepts

**Two public-facing entities:**
- **RepoPublication** — analytics for a specific repository, sourced from a completed order
- **DeveloperProfile** — aggregated portfolio of the account owner across selected orders

**Orders are internal.** The public doesn't see "orders" — they see repos and developer profiles.

## Data Model

### RepoPublication

```prisma
model RepoPublication {
  id              String      @id @default(cuid())

  // Repository identity
  owner           String                    // "facebook"
  repo            String                    // "react"
  slug            String      @unique       // "facebook/react"

  // Data source
  orderId         String
  order           Order       @relation(fields: [orderId], references: [id], onDelete: Cascade)

  // Publisher
  publishedById   String
  publishedBy     User        @relation("UserPublications", fields: [publishedById], references: [id])

  // Type and access
  publishType     PublishType               // USER | ADMIN
  shareToken      String?     @unique       // for /share/xxx (USER publications)
  isActive        Boolean     @default(true)

  // Admin curation
  isFeatured      Boolean     @default(false)
  title           String?                   // custom title for catalog
  description     String?                   // description for catalog/SEO
  sortOrder       Int         @default(0)

  // Visibility control
  visibleDevelopers Json?                   // null = all, [...emails] = selective

  // Stats
  viewCount       Int         @default(0)

  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  @@index([publishType, isActive])
  @@index([isFeatured, sortOrder])
}

enum PublishType {
  USER
  ADMIN
}
```

### DeveloperProfile

```prisma
model DeveloperProfile {
  id              String      @id @default(cuid())

  // Owner (1:1 with User)
  userId          String      @unique
  user            User        @relation(fields: [userId], references: [id])

  // Public URL
  slug            String      @unique       // "johndoe" -> /dev/johndoe

  // Display
  displayName     String
  bio             String?
  avatarUrl       String?

  // Which orders to include in portfolio
  // null = all COMPLETED, [...ids] = selective
  includedOrderIds Json?

  // Settings
  isActive        Boolean     @default(true)

  // Stats
  viewCount       Int         @default(0)

  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt
}
```

## Routes

### Public (no auth required)

| Route | Purpose |
|-------|---------|
| `/explore` | Catalog page with search/filters |
| `/explore/[owner]/[repo]` | Repo analytics (SSR, SEO) |
| `/share/[token]` | Private share via token |
| `/dev/[slug]` | Developer profile (SSR, SEO) |

### User (auth required)

| Route | Purpose |
|-------|---------|
| `/publications` | Manage my publications |
| `/profile` | Edit developer profile |

### Admin

| Route | Purpose |
|-------|---------|
| `/admin/publications` | Curate all publications |

### API Endpoints

**Public (no auth):**
- `GET /api/explore` — catalog listing (pagination, filters)
- `GET /api/explore/[owner]/[repo]` — publication data by slug
- `GET /api/share/[token]` — publication data by token
- `GET /api/dev/[slug]` — developer profile data
- `GET /api/dev/[slug]/metrics` — aggregated metrics for portfolio

**User (auth required):**
- `GET /api/publications` — list my publications
- `POST /api/publications` — create publication from order
- `PATCH /api/publications/[id]` — update (visibleDevelopers, isActive)
- `DELETE /api/publications/[id]` — delete (physical; use PATCH isActive=false for soft deactivation)
- `GET /api/profile` — get my developer profile
- `POST /api/profile` — create developer profile
- `PATCH /api/profile` — update developer profile

**Admin:**
- `GET /api/admin/publications` — list all publications
- `POST /api/admin/publications` — create showcase publication
- `PATCH /api/admin/publications/[id]` — edit (featured, title, sortOrder)
- `DELETE /api/admin/publications/[id]` — remove

## User Flows

### Flow 1: User publishes a repo from order

1. Order is COMPLETED
2. "Publish" button appears next to each repo on order page
3. Modal: select developers to show (checkboxes, all selected by default)
4. Click "Publish" -> RepoPublication created with shareToken
5. Share link `/share/[token]` displayed with copy button
6. `/publications` page shows all user's publications with on/off toggle

### Flow 2: User creates developer profile

1. Navigation item "My Profile" (or Settings -> Profile)
2. Form: slug (username), displayName, bio
3. Select orders to include (multi-select from COMPLETED orders)
4. Save -> profile available at `/dev/[slug]`
5. Metrics aggregated from OrderMetric filtered by user's email

### Flow 3: Admin publishes showcase

1. Admin -> Publications (new admin section)
2. Table of existing publications: search, filters, featured toggle
3. "New publication" -> select from COMPLETED orders
4. For each repo in order: toggle "Publish"
5. Edit: title, description, featured, sortOrder
6. Slug auto-generated from owner/repo
7. Publication appears in `/explore` catalog

### Flow 4: Visitor browses /explore

1. `/explore` — grid of cards: repo logo, name, language, ghost% summary
2. Filters: language, featured first, search by name
3. Click -> `/explore/[owner]/[repo]`
4. Read-only dashboard: KPI cards, charts, developer table
5. CTA: "Want to analyze your project? Sign up" (if not logged in)
6. Open Graph preview when sharing link in social/messengers

## Metrics Strategy

### Per-repo metrics from CommitAnalysis

Current `OrderMetric` is aggregated across all repos in an order. For per-repo metrics:

Compute KPI on-the-fly from `CommitAnalysis` filtered by repository:
- `commitCount` — COUNT of commits for repo
- `totalEffortHours` — SUM of effortHours for repo
- `workDays` — COUNT DISTINCT dates with commits for repo
- `avgDailyEffort` — totalEffortHours / workDays
- `ghostPercent` — computed using `calcGhostPercent`/`calcGhostPercentRaw` from `@devghost/shared`
- `hasEnoughData` — uses `MIN_WORK_DAYS_FOR_GHOST` constant (currently = 1)

No schema migration needed. CommitAnalysis already stores `repository` field.

**Important:** `selectedRepos` JSONB uses snake_case (`full_name`, `clone_url`, `is_private`), `owner` is an object `{ login, avatarUrl }`. Use `normalizeRepo()` pattern from `analysis-worker.ts` when matching repos.

### Developer profile aggregation

```
DeveloperProfile.userId -> User.email
  -> OrderMetric[] WHERE developerEmail = user.email
    AND orderId IN (includedOrderIds || all COMPLETED orders)
  -> aggregate: total commits, avg ghost%, total workDays
```

## SEO

- `generateMetadata` on all public pages
- Open Graph tags: title, description, image (dynamic OG image with key metrics)
- JSON-LD structured data for search engines
- ISR or SSR for public pages

## Security & Constraints

- Public APIs only serve published data — no access to raw orders
- On order deletion: RepoPublication cascade-deleted (one canonical pub per repo; user can re-publish from another order)

**Deferred to v2:**
- Rate limiting on public APIs
- viewCount incremented via debounced request (v1: increment per request)
- Dynamic OG images with rendered metrics
- User can only publish their own orders (ownership check)
- Share tokens are unguessable (cuid-based)

## Privacy Model

- Simple: link is either active or not
- Can revoke and regenerate share token
- No passwords or email-based access lists
- `visibleDevelopers` JSON array filters which developers appear

## Reused Components (read-only mode)

- `GhostKpiCards` — remove edit controls
- `GhostDistributionPanel` — Bubble/Strip/Heatmap visualizations
- `GhostDeveloperTable` — filtered by visibleDevelopers, with `readOnly` prop (disables expand/share editing)
- `GhostPeriodSelector` — period switching

## New Components

- `PublishButton` — on order page per repo
- `PublishModal` — developer selection + publish
- `ShareLinkCard` — display link + copy
- `ExploreGrid` — catalog card grid on /explore
- `RepoCard` — repo card in catalog
- `PublicDashboard` — read-only dashboard wrapper
- `ProfileEditor` — profile edit form
- `AdminPublicationTable` — admin management table

## File Structure

```
src/app/
├── (public)/
│   ├── explore/
│   │   ├── page.tsx                    — catalog
│   │   └── [owner]/[repo]/page.tsx     — repo analytics
│   ├── share/[token]/page.tsx          — private share
│   └── dev/[slug]/page.tsx             — developer profile
├── (dashboard)/
│   ├── publications/page.tsx           — manage my publications
│   └── profile/page.tsx                — edit developer profile
├── (dashboard)/admin/
│   └── publications/page.tsx           — admin curation panel
└── api/
    ├── explore/
    │   ├── route.ts                    — catalog API
    │   └── [owner]/[repo]/route.ts     — publication data
    ├── share/[token]/route.ts          — token-based access
    ├── dev/[slug]/
    │   ├── route.ts                    — profile data
    │   └── metrics/route.ts            — profile metrics
    ├── publications/
    │   ├── route.ts                    — user CRUD
    │   └── [id]/route.ts              — single publication
    ├── profile/route.ts                — user profile CRUD
    └── admin/publications/
        ├── route.ts                    — admin list/create
        └── [id]/route.ts              — admin edit/delete
```

## Middleware Updates

Add to public (no auth redirect):
- `/explore/*`
- `/share/*`
- `/dev/*`

Add to protected:
- `/publications/*`
- `/profile/*`
