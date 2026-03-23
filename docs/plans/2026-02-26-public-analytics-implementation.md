# Public Analytics Sharing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable users to publish repo analytics and developer profiles publicly, with admin curation and SEO-friendly catalog.

**Architecture:** Two new Prisma models (RepoPublication, DeveloperProfile) with public routes outside auth middleware. Per-repo metrics computed on-the-fly from CommitAnalysis. Existing Ghost* components reused in read-only mode. Admin curation panel follows existing admin page patterns.

**Tech Stack:** Next.js 16 App Router (SSR), Prisma ORM, TanStack Query, shadcn/ui, Recharts (via existing Ghost components).

**Design doc:** `docs/plans/2026-02-26-public-analytics-design.md`

---

## Task 1: Database Schema — RepoPublication + DeveloperProfile

**Files:**
- Modify: `packages/server/prisma/schema.prisma`

**Step 1: Add enums and models to schema**

Add at end of `schema.prisma`:

```prisma
enum PublishType {
  USER
  ADMIN
}

model RepoPublication {
  id              String      @id @default(cuid())

  owner           String
  repo            String
  slug            String      @unique

  orderId         String
  order           Order       @relation(fields: [orderId], references: [id], onDelete: Cascade)

  publishedById   String
  publishedBy     User        @relation("UserPublications", fields: [publishedById], references: [id])

  publishType     PublishType
  shareToken      String?     @unique
  isActive        Boolean     @default(true)

  isFeatured      Boolean     @default(false)
  title           String?
  description     String?
  sortOrder       Int         @default(0)

  visibleDevelopers Json?

  viewCount       Int         @default(0)

  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  @@index([publishType, isActive])
  @@index([isFeatured, sortOrder])
}

model DeveloperProfile {
  id              String      @id @default(cuid())

  userId          String      @unique
  user            User        @relation(fields: [userId], references: [id])

  slug            String      @unique

  displayName     String
  bio             String?
  avatarUrl       String?

  includedOrderIds Json?

  isActive        Boolean     @default(true)

  viewCount       Int         @default(0)

  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt
}
```

**Step 2: Add relations to existing models**

In the `User` model, add:
```prisma
  publications    RepoPublication[] @relation("UserPublications")
  developerProfile DeveloperProfile?
```

In the `Order` model, add:
```prisma
  publications    RepoPublication[]
```

**Step 3: Push schema to database**

Run: `cd packages/server && pnpm db:push`
Expected: schema changes applied successfully.

**Step 4: Generate Prisma client**

Run: `cd packages/server && pnpm db:generate`
Expected: Prisma client generated with new types.

**Step 5: Commit**

```bash
git add packages/server/prisma/schema.prisma
git commit -m "feat(schema): add RepoPublication and DeveloperProfile models"
```

---

## Task 2: Middleware — Allow Public Routes

**Files:**
- Modify: `packages/server/middleware.ts`
- Modify: `packages/server/src/lib/auth.config.ts`

**Step 1: Update middleware matcher**

In `packages/server/middleware.ts`, the `config.matcher` array defines which routes go through auth middleware. Public routes (`/explore`, `/share`, `/dev`) must NOT be in the matcher. They aren't currently, so no change needed to `middleware.ts`.

However, we need to protect new dashboard routes. Add to the matcher array:

```typescript
export const config = {
  matcher: [
    '/dashboard/:path*',
    '/orders/:path*',
    '/demo/:path*',
    '/settings/:path*',
    '/admin/:path*',
    '/billing/:path*',
    '/publications/:path*',   // NEW
    '/profile/:path*',        // NEW
    '/login',
    '/register',
  ],
};
```

**Step 2: Update auth config protected paths**

In `packages/server/src/lib/auth.config.ts`, add to the `protectedPaths` array:

```typescript
const protectedPaths = ['/dashboard', '/orders', '/demo', '/settings', '/admin', '/billing', '/publications', '/profile'];
```

**Step 3: Commit**

```bash
git add packages/server/middleware.ts packages/server/src/lib/auth.config.ts
git commit -m "feat(auth): add publications and profile to protected routes"
```

---

## Task 3: Shared Utility — Per-Repo Metrics + GhostDeveloperTable readOnly

**Files:**
- Create: `packages/server/src/lib/services/publication-metrics.ts`
- Modify: `packages/server/src/components/ghost-developer-table.tsx`
- Create: `packages/server/src/lib/services/__tests__/publication-metrics.test.ts`

This utility computes GhostMetric-compatible data from CommitAnalysis filtered by repository.

**Step 1: Write the failing test**

Create `packages/server/src/lib/services/__tests__/publication-metrics.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('@/lib/db', () => ({
  default: {
    commitAnalysis: {
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

import prisma from '@/lib/db';
import { computeRepoMetrics } from '../publication-metrics';

describe('computeRepoMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no commits', async () => {
    vi.mocked(prisma.commitAnalysis.findMany).mockResolvedValue([]);
    const result = await computeRepoMetrics('order-1', 'facebook/react');
    expect(result).toEqual([]);
  });

  it('computes per-developer metrics from commits', async () => {
    vi.mocked(prisma.commitAnalysis.findMany).mockResolvedValue([
      {
        id: '1', orderId: 'order-1', jobId: null, commitHash: 'abc',
        commitMessage: 'feat: add button', authorEmail: 'dev@test.com',
        authorName: 'Dev', authorDate: new Date('2025-01-15'),
        repository: 'facebook/react', additions: 100, deletions: 10,
        filesCount: 3, effortHours: new Prisma.Decimal(2.5),
        category: 'feature', complexity: 'medium', confidence: new Prisma.Decimal(0.9),
        method: 'llm', llmModel: 'qwen', analyzedAt: new Date(),
      },
      {
        id: '2', orderId: 'order-1', jobId: null, commitHash: 'def',
        commitMessage: 'fix: bug', authorEmail: 'dev@test.com',
        authorName: 'Dev', authorDate: new Date('2025-01-16'),
        repository: 'facebook/react', additions: 20, deletions: 5,
        filesCount: 1, effortHours: new Prisma.Decimal(1.0),
        category: 'bugfix', complexity: 'low', confidence: new Prisma.Decimal(0.95),
        method: 'llm', llmModel: 'qwen', analyzedAt: new Date(),
      },
    ] as any);

    const result = await computeRepoMetrics('order-1', 'facebook/react');

    expect(result).toHaveLength(1);
    expect(result[0].developerEmail).toBe('dev@test.com');
    expect(result[0].commitCount).toBe(2);
    expect(result[0].totalEffortHours).toBe(3.5);
    expect(result[0].actualWorkDays).toBe(2);
  });

  it('filters by visibleDevelopers when provided', async () => {
    vi.mocked(prisma.commitAnalysis.findMany).mockResolvedValue([
      {
        id: '1', authorEmail: 'dev1@test.com', authorName: 'Dev1',
        authorDate: new Date('2025-01-15'), effortHours: new Prisma.Decimal(2.0),
        repository: 'facebook/react',
      },
      {
        id: '2', authorEmail: 'dev2@test.com', authorName: 'Dev2',
        authorDate: new Date('2025-01-15'), effortHours: new Prisma.Decimal(3.0),
        repository: 'facebook/react',
      },
    ] as any);

    const result = await computeRepoMetrics('order-1', 'facebook/react', ['dev1@test.com']);
    expect(result).toHaveLength(1);
    expect(result[0].developerEmail).toBe('dev1@test.com');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/server && pnpm test src/lib/services/__tests__/publication-metrics.test.ts`
Expected: FAIL — module `../publication-metrics` not found.

**Step 3: Write the implementation**

Create `packages/server/src/lib/services/publication-metrics.ts`:

```typescript
import prisma from '@/lib/db';
import type { GhostMetric } from '@devghost/shared';
import { calcGhostPercent, calcGhostPercentRaw, MIN_WORK_DAYS_FOR_GHOST } from '@devghost/shared';

export async function computeRepoMetrics(
  orderId: string,
  repository: string,
  visibleDevelopers?: string[] | null,
): Promise<GhostMetric[]> {
  const commits = await prisma.commitAnalysis.findMany({
    where: { orderId, repository },
    select: {
      authorEmail: true,
      authorName: true,
      authorDate: true,
      effortHours: true,
    },
    orderBy: { authorDate: 'asc' },
  });

  if (commits.length === 0) return [];

  // Group by developer
  const devMap = new Map<string, {
    name: string;
    commits: typeof commits;
  }>();

  for (const c of commits) {
    const existing = devMap.get(c.authorEmail);
    if (existing) {
      existing.commits.push(c);
    } else {
      devMap.set(c.authorEmail, { name: c.authorName, commits: [c] });
    }
  }

  // Filter by visibleDevelopers if provided
  const emails = visibleDevelopers
    ? [...devMap.keys()].filter(e => visibleDevelopers.includes(e))
    : [...devMap.keys()];

  const totalEffortAll = commits.reduce((sum, c) => sum + Number(c.effortHours), 0);

  return emails.map(email => {
    const dev = devMap.get(email)!;
    const devCommits = dev.commits;
    const totalEffort = devCommits.reduce((sum, c) => sum + Number(c.effortHours), 0);
    const uniqueDays = new Set(devCommits.map(c => c.authorDate.toISOString().split('T')[0]));
    const workDays = uniqueDays.size;
    const avgDaily = workDays > 0 ? totalEffort / workDays : 0;
    const share = totalEffortAll > 0 ? totalEffort / totalEffortAll : 0;

    return {
      developerId: email,
      developerName: dev.name,
      developerEmail: email,
      periodType: 'ALL_TIME' as const,
      totalEffortHours: totalEffort,
      actualWorkDays: workDays,
      avgDailyEffort: avgDaily,
      ghostPercentRaw: calcGhostPercentRaw(totalEffort, workDays),
      ghostPercent: calcGhostPercent(totalEffort, workDays, share),
      share,
      shareAutoCalculated: true,
      commitCount: devCommits.length,
      hasEnoughData: workDays >= MIN_WORK_DAYS_FOR_GHOST,
    };
  });
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/server && pnpm test src/lib/services/__tests__/publication-metrics.test.ts`
Expected: PASS (3 tests).

**Step 5: Add `readOnly` prop to GhostDeveloperTable**

In `packages/server/src/components/ghost-developer-table.tsx`:

Add `readOnly?: boolean` to the component props interface.

When `readOnly` is true:
- Hide the expand button / row expand functionality (prevents fetch to `/api/orders/${orderId}/daily-effort`)
- Hide the ShareInput column (prevents share editing)

```typescript
// In props interface:
interface GhostDeveloperTableProps {
  metrics: GhostMetric[];
  orderId: string;
  highlightedEmail?: string;
  onShareChange?: (email: string, share: number, auto: boolean) => void;
  readOnly?: boolean;  // NEW
}

// In render — guard expand toggle:
{!readOnly && (
  <button onClick={() => toggleExpand(email)}>...</button>
)}

// In render — guard ShareInput column:
{!readOnly && (
  <TableHead>Share</TableHead>
)}
// ... and corresponding TableCell
```

**Step 6: Commit**

```bash
git add packages/server/src/lib/services/publication-metrics.ts packages/server/src/lib/services/__tests__/publication-metrics.test.ts packages/server/src/components/ghost-developer-table.tsx
git commit -m "feat(services): add per-repo metrics computation and readOnly mode for developer table"
```

---

## Task 4: User API — Publications CRUD

**Files:**
- Create: `packages/server/src/app/api/publications/route.ts`
- Create: `packages/server/src/app/api/publications/[id]/route.ts`

**Step 1: Write tests for publications API**

Create `packages/server/src/app/api/publications/__tests__/publications.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    repoPublication: {
      findMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    order: { findFirst: vi.fn() },
  },
}));

vi.mock('@/lib/api-utils', () => ({
  requireUserSession: vi.fn(),
  isErrorResponse: vi.fn((r: any) => r instanceof Response),
  apiResponse: vi.fn((data: any) => Response.json({ success: true, data })),
  apiError: vi.fn((msg: string, status: number) => new Response(JSON.stringify({ success: false, error: msg }), { status })),
}));

import prisma from '@/lib/db';
import { requireUserSession } from '@/lib/api-utils';
import { GET, POST } from '../route';

describe('GET /api/publications', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns user publications', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([
      { id: 'pub-1', slug: 'owner/repo', isActive: true },
    ] as any);

    const req = new Request('http://localhost/api/publications');
    const res = await GET(req as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
  });
});

describe('POST /api/publications', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates a publication from a completed order', async () => {
    vi.mocked(requireUserSession).mockResolvedValue({
      user: { id: 'user-1', email: 'test@test.com', role: 'USER' },
    } as any);

    vi.mocked(prisma.order.findFirst).mockResolvedValue({
      id: 'order-1', userId: 'user-1', status: 'COMPLETED',
      selectedRepos: [{ owner: { login: 'facebook', avatarUrl: '' }, name: 'react', full_name: 'facebook/react' }],
    } as any);

    vi.mocked(prisma.repoPublication.create).mockResolvedValue({
      id: 'pub-1', slug: 'facebook/react', shareToken: 'tok-123',
    } as any);

    const req = new Request('http://localhost/api/publications', {
      method: 'POST',
      body: JSON.stringify({ orderId: 'order-1', repository: 'facebook/react' }),
    });
    const res = await POST(req as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(prisma.repoPublication.create).toHaveBeenCalled();
  });
});
```

**Step 2: Run to verify fails**

Run: `cd packages/server && pnpm test src/app/api/publications/__tests__/publications.test.ts`
Expected: FAIL — module not found.

**Step 3: Implement GET and POST**

Create `packages/server/src/app/api/publications/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';
import { createId } from '@paralleldrive/cuid2';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const publications = await prisma.repoPublication.findMany({
    where: { publishedById: session.user.id },
    orderBy: { createdAt: 'desc' },
    include: { order: { select: { name: true, status: true } } },
  });

  return apiResponse(publications);
}

export async function POST(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const body = await request.json();
  const { orderId, repository, visibleDevelopers } = body;

  if (!orderId || !repository) {
    return apiError('orderId and repository are required', 400);
  }

  // Verify order ownership and status
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId: session.user.id, status: 'COMPLETED' },
  });

  if (!order) {
    return apiError('Order not found or not completed', 404);
  }

  // Parse owner/repo from repository string
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    return apiError('Invalid repository format. Expected owner/repo', 400);
  }

  // Verify repo exists in order (selectedRepos uses snake_case: full_name, owner is object { login })
  const repos = order.selectedRepos as Array<Record<string, unknown>>;
  const repoExists = repos.some(r => {
    const fullName = (r.fullName ?? r.full_name) as string | undefined;
    const ownerLogin = (r.owner as any)?.login as string | undefined;
    return fullName === repository || `${ownerLogin}/${r.name}` === repository;
  });
  if (!repoExists) {
    return apiError('Repository not found in this order', 400);
  }

  const slug = `${owner}/${repo}`;
  const shareToken = createId();

  const publication = await prisma.repoPublication.create({
    data: {
      owner,
      repo,
      slug,
      orderId,
      publishedById: session.user.id,
      publishType: 'USER',
      shareToken,
      visibleDevelopers: visibleDevelopers ?? undefined,
    },
  });

  return apiResponse(publication);
}
```

**Step 4: Implement PATCH and DELETE**

Create `packages/server/src/app/api/publications/[id]/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const body = await request.json();

  const publication = await prisma.repoPublication.findFirst({
    where: { id, publishedById: session.user.id },
  });

  if (!publication) {
    return apiError('Publication not found', 404);
  }

  const allowedFields: Record<string, unknown> = {};
  if ('isActive' in body) allowedFields.isActive = body.isActive;
  if ('visibleDevelopers' in body) allowedFields.visibleDevelopers = body.visibleDevelopers;

  const updated = await prisma.repoPublication.update({
    where: { id },
    data: allowedFields,
  });

  return apiResponse(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const publication = await prisma.repoPublication.findFirst({
    where: { id, publishedById: session.user.id },
  });

  if (!publication) {
    return apiError('Publication not found', 404);
  }

  await prisma.repoPublication.delete({ where: { id } });

  return apiResponse({ deleted: true });
}
```

**Step 5: Run tests**

Run: `cd packages/server && pnpm test src/app/api/publications/__tests__/publications.test.ts`
Expected: PASS.

**Step 6: Commit**

```bash
git add packages/server/src/app/api/publications/
git commit -m "feat(api): add user publications CRUD endpoints"
```

---

## Task 5: Public API — Explore Catalog + Repo Detail + Share

**Files:**
- Create: `packages/server/src/app/api/explore/route.ts`
- Create: `packages/server/src/app/api/explore/[owner]/[repo]/route.ts`
- Create: `packages/server/src/app/api/share/[token]/route.ts`

**Step 1: Write tests**

Create `packages/server/src/app/api/explore/__tests__/explore.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  default: {
    repoPublication: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import prisma from '@/lib/db';
import { GET } from '../route';

describe('GET /api/explore', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns active publications with pagination', async () => {
    vi.mocked(prisma.repoPublication.findMany).mockResolvedValue([
      { id: 'pub-1', slug: 'facebook/react', isFeatured: true, title: 'React' },
    ] as any);
    vi.mocked(prisma.repoPublication.count).mockResolvedValue(1);

    const req = new Request('http://localhost/api/explore?page=1&pageSize=20');
    const res = await GET(req as any);
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.items).toHaveLength(1);
    expect(json.data.total).toBe(1);
  });
});
```

**Step 2: Run to verify fails**

Run: `cd packages/server && pnpm test src/app/api/explore/__tests__/explore.test.ts`
Expected: FAIL.

**Step 3: Implement catalog endpoint**

Create `packages/server/src/app/api/explore/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get('page') || '1'));
  const pageSize = Math.min(50, Math.max(1, Number(searchParams.get('pageSize') || '20')));
  const search = searchParams.get('search') || '';
  const featured = searchParams.get('featured') === 'true';

  const where = {
    isActive: true,
    ...(featured && { isFeatured: true }),
    ...(search && {
      OR: [
        { slug: { contains: search, mode: 'insensitive' as const } },
        { title: { contains: search, mode: 'insensitive' as const } },
        { description: { contains: search, mode: 'insensitive' as const } },
      ],
    }),
  };

  const [items, total] = await Promise.all([
    prisma.repoPublication.findMany({
      where,
      orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { viewCount: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        owner: true,
        repo: true,
        slug: true,
        publishType: true,
        isFeatured: true,
        title: true,
        description: true,
        viewCount: true,
        createdAt: true,
      },
    }),
    prisma.repoPublication.count({ where }),
  ]);

  return NextResponse.json({
    success: true,
    data: { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  });
}
```

**Step 4: Implement repo detail endpoint**

Create `packages/server/src/app/api/explore/[owner]/[repo]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { computeRepoMetrics } from '@/lib/services/publication-metrics';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  const { owner, repo } = await params;
  const slug = `${owner}/${repo}`;

  const publication = await prisma.repoPublication.findUnique({
    where: { slug },
    include: {
      order: { select: { name: true, selectedRepos: true } },
      publishedBy: { select: { name: true } },
    },
  });

  if (!publication || !publication.isActive) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  }

  // Increment view count (fire-and-forget)
  prisma.repoPublication.update({
    where: { id: publication.id },
    data: { viewCount: { increment: 1 } },
  }).catch(() => {});

  // Compute per-repo metrics
  const visibleDevs = publication.visibleDevelopers as string[] | null;
  const metrics = await computeRepoMetrics(
    publication.orderId,
    `${owner}/${repo}`,
    visibleDevs,
  );

  return NextResponse.json({
    success: true,
    data: {
      publication: {
        id: publication.id,
        owner: publication.owner,
        repo: publication.repo,
        slug: publication.slug,
        title: publication.title || `${owner}/${repo}`,
        description: publication.description,
        isFeatured: publication.isFeatured,
        viewCount: publication.viewCount,
        publishedBy: publication.publishedBy.name,
        createdAt: publication.createdAt,
      },
      metrics,
    },
  });
}
```

**Step 5: Implement share-by-token endpoint**

Create `packages/server/src/app/api/share/[token]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { computeRepoMetrics } from '@/lib/services/publication-metrics';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const publication = await prisma.repoPublication.findUnique({
    where: { shareToken: token },
    include: {
      order: { select: { name: true, selectedRepos: true } },
      publishedBy: { select: { name: true } },
    },
  });

  if (!publication || !publication.isActive) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  }

  // Increment view count
  prisma.repoPublication.update({
    where: { id: publication.id },
    data: { viewCount: { increment: 1 } },
  }).catch(() => {});

  const visibleDevs = publication.visibleDevelopers as string[] | null;
  const metrics = await computeRepoMetrics(
    publication.orderId,
    `${publication.owner}/${publication.repo}`,
    visibleDevs,
  );

  return NextResponse.json({
    success: true,
    data: {
      publication: {
        id: publication.id,
        owner: publication.owner,
        repo: publication.repo,
        slug: publication.slug,
        title: publication.title || `${publication.owner}/${publication.repo}`,
        description: publication.description,
        viewCount: publication.viewCount,
        publishedBy: publication.publishedBy.name,
        createdAt: publication.createdAt,
      },
      metrics,
    },
  });
}
```

**Step 6: Run tests**

Run: `cd packages/server && pnpm test src/app/api/explore/__tests__/explore.test.ts`
Expected: PASS.

**Step 7: Commit**

```bash
git add packages/server/src/app/api/explore/ packages/server/src/app/api/share/
git commit -m "feat(api): add public explore catalog, repo detail, and share endpoints"
```

---

## Task 6: User API — Developer Profile CRUD

**Files:**
- Create: `packages/server/src/app/api/profile/route.ts`

**Step 1: Implement profile CRUD**

Create `packages/server/src/app/api/profile/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const profile = await prisma.developerProfile.findUnique({
    where: { userId: session.user.id },
  });

  return apiResponse(profile);
}

export async function POST(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const body = await request.json();
  const { slug, displayName, bio, avatarUrl, includedOrderIds } = body;

  if (!slug || !displayName) {
    return apiError('slug and displayName are required', 400);
  }

  // Validate slug format (alphanumeric + hyphens, 3-30 chars)
  if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(slug)) {
    return apiError('Slug must be 3-30 chars, lowercase alphanumeric and hyphens', 400);
  }

  // Check slug uniqueness
  const existing = await prisma.developerProfile.findUnique({ where: { slug } });
  if (existing && existing.userId !== session.user.id) {
    return apiError('This slug is already taken', 409);
  }

  const profile = await prisma.developerProfile.upsert({
    where: { userId: session.user.id },
    update: { slug, displayName, bio, avatarUrl, includedOrderIds },
    create: {
      userId: session.user.id,
      slug,
      displayName,
      bio,
      avatarUrl,
      includedOrderIds,
    },
  });

  return apiResponse(profile);
}

export async function PATCH(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const profile = await prisma.developerProfile.findUnique({
    where: { userId: session.user.id },
  });

  if (!profile) {
    return apiError('Profile not found. Create one first.', 404);
  }

  const body = await request.json();
  const allowedFields: Record<string, unknown> = {};
  if ('displayName' in body) allowedFields.displayName = body.displayName;
  if ('bio' in body) allowedFields.bio = body.bio;
  if ('avatarUrl' in body) allowedFields.avatarUrl = body.avatarUrl;
  if ('isActive' in body) allowedFields.isActive = body.isActive;
  if ('includedOrderIds' in body) allowedFields.includedOrderIds = body.includedOrderIds;
  if ('slug' in body) {
    if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(body.slug)) {
      return apiError('Invalid slug format', 400);
    }
    const slugTaken = await prisma.developerProfile.findUnique({ where: { slug: body.slug } });
    if (slugTaken && slugTaken.userId !== session.user.id) {
      return apiError('Slug already taken', 409);
    }
    allowedFields.slug = body.slug;
  }

  const updated = await prisma.developerProfile.update({
    where: { userId: session.user.id },
    data: allowedFields,
  });

  return apiResponse(updated);
}
```

**Step 2: Commit**

```bash
git add packages/server/src/app/api/profile/
git commit -m "feat(api): add developer profile CRUD endpoints"
```

---

## Task 7: Public API — Developer Profile View + Metrics

**Files:**
- Create: `packages/server/src/app/api/dev/[slug]/route.ts`
- Create: `packages/server/src/app/api/dev/[slug]/metrics/route.ts`

**Step 1: Implement profile public view**

Create `packages/server/src/app/api/dev/[slug]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const profile = await prisma.developerProfile.findUnique({
    where: { slug },
    include: {
      user: { select: { email: true, name: true, githubUsername: true } },
    },
  });

  if (!profile || !profile.isActive) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  }

  // Increment view count
  prisma.developerProfile.update({
    where: { id: profile.id },
    data: { viewCount: { increment: 1 } },
  }).catch(() => {});

  return NextResponse.json({
    success: true,
    data: {
      slug: profile.slug,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      githubUsername: profile.user.githubUsername,
      viewCount: profile.viewCount,
      createdAt: profile.createdAt,
    },
  });
}
```

**Step 2: Implement profile metrics**

Create `packages/server/src/app/api/dev/[slug]/metrics/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const profile = await prisma.developerProfile.findUnique({
    where: { slug },
    include: { user: { select: { email: true } } },
  });

  if (!profile || !profile.isActive) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  }

  // Build order filter
  const includedIds = profile.includedOrderIds as string[] | null;
  const orderWhere = includedIds
    ? { id: { in: includedIds }, status: 'COMPLETED' as const }
    : { userId: profile.userId, status: 'COMPLETED' as const };

  const orders = await prisma.order.findMany({
    where: orderWhere,
    select: { id: true, name: true, selectedRepos: true },
  });

  // Get metrics for this developer across selected orders
  const metrics = await prisma.orderMetric.findMany({
    where: {
      orderId: { in: orders.map(o => o.id) },
      developerEmail: profile.user.email,
      periodType: 'ALL_TIME',
    },
    select: {
      orderId: true,
      commitCount: true,
      workDays: true,
      totalEffortHours: true,
      avgDailyEffort: true,
      ghostPercent: true,
      share: true,
    },
  });

  // Map order names
  const orderMap = new Map(orders.map(o => [o.id, o]));
  const enriched = metrics.map(m => ({
    ...m,
    totalEffortHours: Number(m.totalEffortHours),
    avgDailyEffort: Number(m.avgDailyEffort),
    ghostPercent: m.ghostPercent ? Number(m.ghostPercent) : null,
    share: Number(m.share),
    orderName: orderMap.get(m.orderId)?.name || 'Unknown',
    repos: (orderMap.get(m.orderId)?.selectedRepos as any[])?.map(r => r.fullName || `${r.owner}/${r.name}`) || [],
  }));

  // Aggregate summary
  const summary = {
    totalOrders: metrics.length,
    totalCommits: metrics.reduce((s, m) => s + m.commitCount, 0),
    totalWorkDays: metrics.reduce((s, m) => s + m.workDays, 0),
    totalEffortHours: metrics.reduce((s, m) => s + Number(m.totalEffortHours || 0), 0),
    avgGhostPercent: metrics.length > 0
      ? metrics.reduce((s, m) => s + Number(m.ghostPercent || 0), 0) / metrics.length
      : null,
  };

  return NextResponse.json({
    success: true,
    data: { summary, orders: enriched },
  });
}
```

**Step 3: Commit**

```bash
git add packages/server/src/app/api/dev/
git commit -m "feat(api): add public developer profile and metrics endpoints"
```

---

## Task 8: Admin API — Publications Management

**Files:**
- Create: `packages/server/src/app/api/admin/publications/route.ts`
- Create: `packages/server/src/app/api/admin/publications/[id]/route.ts`

**Step 1: Implement admin publications list and create**

Create `packages/server/src/app/api/admin/publications/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireAdmin, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get('page') || '1'));
  const pageSize = Math.min(50, Number(searchParams.get('pageSize') || '20'));
  const search = searchParams.get('search') || '';
  const type = searchParams.get('type') || '';

  const where = {
    ...(type && { publishType: type as any }),
    ...(search && {
      OR: [
        { slug: { contains: search, mode: 'insensitive' as const } },
        { title: { contains: search, mode: 'insensitive' as const } },
      ],
    }),
  };

  const [items, total] = await Promise.all([
    prisma.repoPublication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        publishedBy: { select: { name: true, email: true } },
        order: { select: { name: true, status: true } },
      },
    }),
    prisma.repoPublication.count({ where }),
  ]);

  return apiResponse({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const body = await request.json();
  const { orderId, repository, title, description, isFeatured } = body;

  if (!orderId || !repository) {
    return apiError('orderId and repository are required', 400);
  }

  const order = await prisma.order.findFirst({
    where: { id: orderId, status: 'COMPLETED' },
  });

  if (!order) {
    return apiError('Order not found or not completed', 404);
  }

  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    return apiError('Invalid repository format', 400);
  }

  const slug = `${owner}/${repo}`;

  const publication = await prisma.repoPublication.create({
    data: {
      owner,
      repo,
      slug,
      orderId,
      publishedById: session.user.id,
      publishType: 'ADMIN',
      title,
      description,
      isFeatured: isFeatured ?? false,
    },
  });

  return apiResponse(publication);
}
```

**Step 2: Implement admin single publication management**

Create `packages/server/src/app/api/admin/publications/[id]/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireAdmin, isErrorResponse, apiResponse, apiError } from '@/lib/api-utils';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const body = await request.json();

  const publication = await prisma.repoPublication.findUnique({ where: { id } });
  if (!publication) {
    return apiError('Publication not found', 404);
  }

  const allowedFields: Record<string, unknown> = {};
  if ('isActive' in body) allowedFields.isActive = body.isActive;
  if ('isFeatured' in body) allowedFields.isFeatured = body.isFeatured;
  if ('title' in body) allowedFields.title = body.title;
  if ('description' in body) allowedFields.description = body.description;
  if ('sortOrder' in body) allowedFields.sortOrder = body.sortOrder;
  if ('visibleDevelopers' in body) allowedFields.visibleDevelopers = body.visibleDevelopers;

  const updated = await prisma.repoPublication.update({
    where: { id },
    data: allowedFields,
  });

  return apiResponse(updated);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const { id } = await params;

  const publication = await prisma.repoPublication.findUnique({ where: { id } });
  if (!publication) {
    return apiError('Publication not found', 404);
  }

  await prisma.repoPublication.delete({ where: { id } });
  return apiResponse({ deleted: true });
}
```

**Step 3: Commit**

```bash
git add packages/server/src/app/api/admin/publications/
git commit -m "feat(api): add admin publications management endpoints"
```

---

## Task 9: Public Pages — Explore Catalog

**Files:**
- Create: `packages/server/src/app/(public)/explore/page.tsx`
- Create: `packages/server/src/app/(public)/explore/layout.tsx`
- Create: `packages/server/src/components/explore-grid.tsx`
- Create: `packages/server/src/components/repo-card.tsx`

**Step 1: Create public layout**

Create `packages/server/src/app/(public)/explore/layout.tsx`:

```tsx
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Explore Developer Analytics | DevGhost',
  description: 'Explore developer productivity analytics for open source repositories. Ghost percentage, effort estimation, and team metrics.',
  openGraph: {
    title: 'Explore Developer Analytics | DevGhost',
    description: 'Explore developer productivity analytics for open source repositories.',
    type: 'website',
  },
};

export default function ExploreLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <a href="/" className="text-xl font-bold">DevGhost</a>
          <nav className="flex items-center gap-4">
            <a href="/explore" className="text-sm font-medium">Explore</a>
            <a href="/login" className="text-sm text-muted-foreground hover:text-foreground">Sign in</a>
          </nav>
        </div>
      </header>
      <main className="container mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  );
}
```

**Step 2: Create RepoCard component**

Create `packages/server/src/components/repo-card.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Star, Eye } from 'lucide-react';

interface RepoCardProps {
  slug: string;
  owner: string;
  repo: string;
  title: string | null;
  description: string | null;
  isFeatured: boolean;
  viewCount: number;
}

export function RepoCard({ slug, owner, repo, title, description, isFeatured, viewCount }: RepoCardProps) {
  return (
    <Link href={`/explore/${slug}`}>
      <Card className="h-full hover:border-primary/50 transition-colors cursor-pointer">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <CardTitle className="text-lg">
              {title || `${owner}/${repo}`}
            </CardTitle>
            {isFeatured && <Badge variant="secondary">Featured</Badge>}
          </div>
          <p className="text-sm text-muted-foreground">{owner}/{repo}</p>
        </CardHeader>
        <CardContent>
          {description && (
            <p className="text-sm text-muted-foreground line-clamp-2 mb-3">{description}</p>
          )}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              {viewCount}
            </span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
```

**Step 3: Create ExploreGrid component**

Create `packages/server/src/components/explore-grid.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { RepoCard } from '@/components/repo-card';
import { Loader2, Search } from 'lucide-react';

interface Publication {
  id: string;
  owner: string;
  repo: string;
  slug: string;
  title: string | null;
  description: string | null;
  isFeatured: boolean;
  viewCount: number;
}

interface ExploreData {
  items: Publication[];
  total: number;
  totalPages: number;
}

interface ExploreGridProps {
  initialData?: ExploreData;
}

export function ExploreGrid({ initialData }: ExploreGridProps) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['explore', search, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (search) params.set('search', search);
      const res = await fetch(`/api/explore?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data as ExploreData;
    },
    // Use SSR data for initial render (no search/page change yet)
    initialData: (!search && page === 1) ? initialData : undefined,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search repositories..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-9"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : data?.items.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          No published analytics found.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data?.items.map((pub) => (
            <RepoCard key={pub.id} {...pub} />
          ))}
        </div>
      )}

      {data && data.totalPages > 1 && (
        <div className="flex justify-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50"
          >
            Previous
          </button>
          <span className="px-3 py-1 text-sm">
            Page {page} of {data.totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
            disabled={page === data.totalPages}
            className="px-3 py-1 text-sm border rounded disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
```

**Step 4: Create explore catalog page (SSR for SEO)**

The catalog page is a **Server Component** that fetches initial data server-side for SEO indexing. The client-side `ExploreGrid` handles search/pagination interactivity, but the initial render has content in HTML.

Create `packages/server/src/app/(public)/explore/page.tsx`:

```tsx
import prisma from '@/lib/db';
import { ExploreGrid } from '@/components/explore-grid';

// Server-side initial data fetch for SEO
async function getInitialPublications() {
  const [items, total] = await Promise.all([
    prisma.repoPublication.findMany({
      where: { isActive: true },
      orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { viewCount: 'desc' }],
      take: 20,
      select: {
        id: true, owner: true, repo: true, slug: true,
        publishType: true, isFeatured: true, title: true,
        description: true, viewCount: true, createdAt: true,
      },
    }),
    prisma.repoPublication.count({ where: { isActive: true } }),
  ]);
  return { items, total, page: 1, pageSize: 20, totalPages: Math.ceil(total / 20) };
}

export default async function ExplorePage() {
  const initialData = await getInitialPublications();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Explore</h1>
        <p className="text-muted-foreground mt-1">
          Developer productivity analytics for open source repositories
        </p>
      </div>
      {/* Pass SSR data as initialData; ExploreGrid hydrates and takes over for search/pagination */}
      <ExploreGrid initialData={initialData} />
    </div>
  );
}
```

Note: The `(public)` route group needs a `providers.tsx` wrapper for TanStack Query if the existing one is scoped to `(dashboard)`. Check if `packages/server/src/components/providers.tsx` is applied at root layout or only in dashboard layout. If only dashboard, add a similar QueryClientProvider wrapper to the `(public)` layout.

**Step 5: Commit**

```bash
git add packages/server/src/app/(public)/explore/ packages/server/src/components/explore-grid.tsx packages/server/src/components/repo-card.tsx
git commit -m "feat(ui): add explore catalog page with search and grid"
```

---

## Task 10: Public Pages — Repo Analytics Detail

**Files:**
- Create: `packages/server/src/app/(public)/explore/[owner]/[repo]/page.tsx`
- Create: `packages/server/src/components/public-dashboard.tsx`

**Step 1: Create PublicDashboard component**

This wraps existing Ghost components in read-only mode.

Create `packages/server/src/components/public-dashboard.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { GhostKpiCards } from '@/components/ghost-kpi-cards';
import { GhostDistributionPanel } from '@/components/ghost-distribution-panel';
import { GhostDeveloperTable } from '@/components/ghost-developer-table';
import type { GhostMetric } from '@devghost/shared';

interface PublicDashboardProps {
  metrics: GhostMetric[];
  title: string;
  description?: string | null;
  publishedBy?: string | null;
}

export function PublicDashboard({ metrics, title, description, publishedBy }: PublicDashboardProps) {
  const [highlightedEmail, setHighlightedEmail] = useState<string | undefined>();

  // Compute KPI values from metrics
  const developerCount = metrics.length;
  const commitCount = metrics.reduce((s, m) => s + m.commitCount, 0);
  const totalWorkDays = metrics.reduce((s, m) => s + m.actualWorkDays, 0);
  const metricsWithGhost = metrics.filter(m => m.ghostPercent !== null);
  const avgGhostPercent = metricsWithGhost.length > 0
    ? metricsWithGhost.reduce((s, m) => s + (m.ghostPercent || 0), 0) / metricsWithGhost.length
    : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{title}</h1>
        {description && <p className="text-muted-foreground mt-1">{description}</p>}
        {publishedBy && (
          <p className="text-sm text-muted-foreground mt-2">Published by {publishedBy}</p>
        )}
      </div>

      <GhostKpiCards
        avgGhostPercent={avgGhostPercent}
        developerCount={developerCount}
        commitCount={commitCount}
        totalWorkDays={totalWorkDays}
      />

      {metrics.length > 0 && (
        <>
          <GhostDistributionPanel
            metrics={metrics}
            onDeveloperClick={setHighlightedEmail}
          />

          <GhostDeveloperTable
            metrics={metrics}
            orderId=""
            highlightedEmail={highlightedEmail}
            readOnly
            // readOnly prop must be added to GhostDeveloperTable:
            // - hides expand row (no daily-effort fetch with empty orderId)
            // - hides ShareInput column
            // See Task 3 pre-step: modify ghost-developer-table.tsx
          />
        </>
      )}

      {metrics.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No metrics available for this repository.
        </div>
      )}
    </div>
  );
}
```

**Step 2: Create repo detail page with SSR metadata**

Create `packages/server/src/app/(public)/explore/[owner]/[repo]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import prisma from '@/lib/db';
import { computeRepoMetrics } from '@/lib/services/publication-metrics';
import { PublicDashboard } from '@/components/public-dashboard';

interface PageProps {
  params: Promise<{ owner: string; repo: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { owner, repo } = await params;
  const slug = `${owner}/${repo}`;

  const publication = await prisma.repoPublication.findUnique({
    where: { slug },
    select: { title: true, description: true },
  });

  if (!publication) {
    return { title: 'Not Found | DevGhost' };
  }

  const title = publication.title || `${owner}/${repo} — Developer Analytics`;
  const description = publication.description || `Developer productivity analytics for ${owner}/${repo}`;

  return {
    title: `${title} | DevGhost`,
    description,
    openGraph: {
      title: `${title} | DevGhost`,
      description,
      type: 'article',
    },
  };
}

export default async function RepoAnalyticsPage({ params }: PageProps) {
  const { owner, repo } = await params;
  const slug = `${owner}/${repo}`;

  const publication = await prisma.repoPublication.findUnique({
    where: { slug },
    include: {
      publishedBy: { select: { name: true } },
    },
  });

  if (!publication || !publication.isActive) {
    notFound();
  }

  // Increment view count (fire-and-forget in server component)
  prisma.repoPublication.update({
    where: { id: publication.id },
    data: { viewCount: { increment: 1 } },
  }).catch(() => {});

  const visibleDevs = publication.visibleDevelopers as string[] | null;
  const metrics = await computeRepoMetrics(publication.orderId, slug, visibleDevs);

  return (
    <PublicDashboard
      metrics={metrics}
      title={publication.title || `${owner}/${repo}`}
      description={publication.description}
      publishedBy={publication.publishedBy.name}
    />
  );
}
```

**Step 3: Commit**

```bash
git add packages/server/src/app/(public)/explore/[owner]/[repo]/ packages/server/src/components/public-dashboard.tsx
git commit -m "feat(ui): add public repo analytics page with SSR and SEO"
```

---

## Task 11: Public Pages — Share by Token

**Files:**
- Create: `packages/server/src/app/(public)/share/[token]/page.tsx`

**Step 1: Create share page**

This is very similar to the explore/[owner]/[repo] page but resolves by token.

Create `packages/server/src/app/(public)/share/[token]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import prisma from '@/lib/db';
import { computeRepoMetrics } from '@/lib/services/publication-metrics';
import { PublicDashboard } from '@/components/public-dashboard';

interface PageProps {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;

  const publication = await prisma.repoPublication.findUnique({
    where: { shareToken: token },
    select: { title: true, description: true, owner: true, repo: true },
  });

  if (!publication) {
    return { title: 'Not Found | DevGhost' };
  }

  const title = publication.title || `${publication.owner}/${publication.repo} — Analytics`;

  return {
    title: `${title} | DevGhost`,
    description: publication.description || `Developer analytics for ${publication.owner}/${publication.repo}`,
    robots: { index: false, follow: false }, // Shared links should not be indexed
  };
}

export default async function SharePage({ params }: PageProps) {
  const { token } = await params;

  const publication = await prisma.repoPublication.findUnique({
    where: { shareToken: token },
    include: { publishedBy: { select: { name: true } } },
  });

  if (!publication || !publication.isActive) {
    notFound();
  }

  prisma.repoPublication.update({
    where: { id: publication.id },
    data: { viewCount: { increment: 1 } },
  }).catch(() => {});

  const visibleDevs = publication.visibleDevelopers as string[] | null;
  const metrics = await computeRepoMetrics(
    publication.orderId,
    `${publication.owner}/${publication.repo}`,
    visibleDevs,
  );

  return (
    <PublicDashboard
      metrics={metrics}
      title={publication.title || `${publication.owner}/${publication.repo}`}
      description={publication.description}
      publishedBy={publication.publishedBy.name}
    />
  );
}
```

**Step 2: Share page also needs the public layout. Create a minimal layout for share.**

Create `packages/server/src/app/(public)/share/layout.tsx`:

```tsx
export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <a href="/" className="text-xl font-bold">DevGhost</a>
          <nav className="flex items-center gap-4">
            <a href="/explore" className="text-sm font-medium">Explore</a>
            <a href="/login" className="text-sm text-muted-foreground hover:text-foreground">Sign in</a>
          </nav>
        </div>
      </header>
      <main className="container mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  );
}
```

Note: The explore and share layouts share the same header. Consider extracting a `PublicHeader` component to deduplicate. Alternatively, create a single `(public)` layout that wraps both route groups.

**Step 3: Commit**

```bash
git add packages/server/src/app/(public)/share/
git commit -m "feat(ui): add share-by-token public page"
```

---

## Task 12: Public Pages — Developer Profile

**Files:**
- Create: `packages/server/src/app/(public)/dev/[slug]/page.tsx`
- Create: `packages/server/src/app/(public)/dev/layout.tsx`

**Step 1: Create developer profile page**

Create `packages/server/src/app/(public)/dev/[slug]/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import prisma from '@/lib/db';
import { DevProfileView } from '@/components/dev-profile-view';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;

  const profile = await prisma.developerProfile.findUnique({
    where: { slug },
    select: { displayName: true, bio: true },
  });

  if (!profile) {
    return { title: 'Not Found | DevGhost' };
  }

  return {
    title: `${profile.displayName} — Developer Profile | DevGhost`,
    description: profile.bio || `Developer productivity portfolio for ${profile.displayName}`,
    openGraph: {
      title: `${profile.displayName} — Developer Profile | DevGhost`,
      description: profile.bio || `Developer productivity portfolio for ${profile.displayName}`,
      type: 'profile',
    },
  };
}

export default async function DevProfilePage({ params }: PageProps) {
  const { slug } = await params;

  const profile = await prisma.developerProfile.findUnique({
    where: { slug },
    include: {
      user: { select: { email: true, name: true, githubUsername: true } },
    },
  });

  if (!profile || !profile.isActive) {
    notFound();
  }

  // Increment view count
  prisma.developerProfile.update({
    where: { id: profile.id },
    data: { viewCount: { increment: 1 } },
  }).catch(() => {});

  // Fetch metrics for profile
  const includedIds = profile.includedOrderIds as string[] | null;
  const orderWhere = includedIds
    ? { id: { in: includedIds }, status: 'COMPLETED' as const }
    : { userId: profile.userId, status: 'COMPLETED' as const };

  const orders = await prisma.order.findMany({
    where: orderWhere,
    select: { id: true, name: true, selectedRepos: true },
  });

  const metrics = await prisma.orderMetric.findMany({
    where: {
      orderId: { in: orders.map(o => o.id) },
      developerEmail: profile.user.email,
      periodType: 'ALL_TIME',
    },
  });

  const orderMap = new Map(orders.map(o => [o.id, o]));

  const profileData = {
    displayName: profile.displayName,
    bio: profile.bio,
    avatarUrl: profile.avatarUrl,
    githubUsername: profile.user.githubUsername,
    viewCount: profile.viewCount,
  };

  const metricsData = metrics.map(m => ({
    orderId: m.orderId,
    orderName: orderMap.get(m.orderId)?.name || 'Unknown',
    repos: (orderMap.get(m.orderId)?.selectedRepos as any[])?.map(
      (r: any) => r.fullName || `${r.owner}/${r.name}`
    ) || [],
    commitCount: m.commitCount,
    workDays: m.workDays,
    totalEffortHours: Number(m.totalEffortHours),
    avgDailyEffort: Number(m.avgDailyEffort),
    ghostPercent: m.ghostPercent ? Number(m.ghostPercent) : null,
  }));

  return <DevProfileView profile={profileData} metrics={metricsData} />;
}
```

**Step 2: Create DevProfileView component**

Create `packages/server/src/components/dev-profile-view.tsx`:

```tsx
'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { GitCommit, Calendar, Clock, TrendingUp } from 'lucide-react';

interface ProfileData {
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  githubUsername: string | null;
  viewCount: number;
}

interface MetricData {
  orderId: string;
  orderName: string;
  repos: string[];
  commitCount: number;
  workDays: number;
  totalEffortHours: number;
  avgDailyEffort: number;
  ghostPercent: number | null;
}

interface DevProfileViewProps {
  profile: ProfileData;
  metrics: MetricData[];
}

export function DevProfileView({ profile, metrics }: DevProfileViewProps) {
  const totalCommits = metrics.reduce((s, m) => s + m.commitCount, 0);
  const totalWorkDays = metrics.reduce((s, m) => s + m.workDays, 0);
  const totalEffort = metrics.reduce((s, m) => s + m.totalEffortHours, 0);
  const avgGhost = metrics.length > 0
    ? metrics.filter(m => m.ghostPercent !== null).reduce((s, m) => s + (m.ghostPercent || 0), 0)
      / metrics.filter(m => m.ghostPercent !== null).length
    : null;

  return (
    <div className="space-y-6">
      {/* Profile header */}
      <div className="flex items-center gap-4">
        {profile.avatarUrl && (
          <img src={profile.avatarUrl} alt={profile.displayName} className="h-16 w-16 rounded-full" />
        )}
        <div>
          <h1 className="text-3xl font-bold">{profile.displayName}</h1>
          {profile.githubUsername && (
            <a
              href={`https://github.com/${profile.githubUsername}`}
              className="text-sm text-muted-foreground hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              @{profile.githubUsername}
            </a>
          )}
          {profile.bio && <p className="text-muted-foreground mt-1">{profile.bio}</p>}
        </div>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <GitCommit className="h-4 w-4" />
              Commits
            </div>
            <p className="text-2xl font-bold mt-1">{totalCommits}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" />
              Work Days
            </div>
            <p className="text-2xl font-bold mt-1">{totalWorkDays}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              Effort Hours
            </div>
            <p className="text-2xl font-bold mt-1">{totalEffort.toFixed(1)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <TrendingUp className="h-4 w-4" />
              Avg Ghost %
            </div>
            <p className="text-2xl font-bold mt-1">
              {avgGhost !== null ? `${avgGhost.toFixed(1)}%` : 'N/A'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Per-order breakdown */}
      <div>
        <h2 className="text-xl font-semibold mb-4">Projects</h2>
        <div className="space-y-3">
          {metrics.map((m) => (
            <Card key={m.orderId}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{m.orderName}</p>
                    <div className="flex gap-1 mt-1">
                      {m.repos.map(r => (
                        <Badge key={r} variant="outline" className="text-xs">{r}</Badge>
                      ))}
                    </div>
                  </div>
                  <div className="text-right text-sm text-muted-foreground">
                    <p>{m.commitCount} commits / {m.workDays} days</p>
                    <p>{m.totalEffortHours.toFixed(1)}h effort</p>
                    {m.ghostPercent !== null && (
                      <p>Ghost: {m.ghostPercent.toFixed(1)}%</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {metrics.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No projects in this portfolio yet.
        </div>
      )}
    </div>
  );
}
```

**Step 3: Create dev layout (reuse public header pattern)**

Create `packages/server/src/app/(public)/dev/layout.tsx` — same as explore layout.

**Step 4: Commit**

```bash
git add packages/server/src/app/(public)/dev/ packages/server/src/components/dev-profile-view.tsx
git commit -m "feat(ui): add public developer profile page with portfolio view"
```

---

## Task 13: Dashboard — Publish Button on Order Page

**Files:**
- Modify: `packages/server/src/app/(dashboard)/orders/[id]/page.tsx`
- Create: `packages/server/src/components/publish-modal.tsx`
- Create: `packages/server/src/components/share-link-card.tsx`

**Step 1: Create PublishModal component**

Create `packages/server/src/components/publish-modal.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';

interface Developer {
  email: string;
  name: string;
}

interface PublishModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orderId: string;
  repository: string;
  developers: Developer[];
  onPublished: (shareToken: string) => void;
}

export function PublishModal({
  open, onOpenChange, orderId, repository, developers, onPublished,
}: PublishModalProps) {
  const [selectedDevs, setSelectedDevs] = useState<Set<string>>(
    new Set(developers.map(d => d.email))
  );
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const publishMutation = useMutation({
    mutationFn: async () => {
      const visibleDevelopers = selectedDevs.size === developers.length
        ? null
        : [...selectedDevs];

      const res = await fetch('/api/publications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, repository, visibleDevelopers }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['publications'] });
      toast({ title: 'Published!', description: 'Share link created.' });
      onPublished(data.shareToken);
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const toggleDev = (email: string) => {
    setSelectedDevs(prev => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish {repository}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Select developers to show in the public view:
          </p>
          {developers.map(dev => (
            <label key={dev.email} className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={selectedDevs.has(dev.email)}
                onCheckedChange={() => toggleDev(dev.email)}
              />
              <span className="text-sm">{dev.name}</span>
              <span className="text-xs text-muted-foreground">{dev.email}</span>
            </label>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => publishMutation.mutate()}
            disabled={publishMutation.isPending || selectedDevs.size === 0}
          >
            {publishMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Create ShareLinkCard component**

Create `packages/server/src/components/share-link-card.tsx`:

```tsx
'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Check, Copy, ExternalLink } from 'lucide-react';

interface ShareLinkCardProps {
  token: string;
}

export function ShareLinkCard({ token }: ShareLinkCardProps) {
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const url = `${origin}/share/${token}`;

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="py-3 flex items-center gap-3">
        <code className="text-sm flex-1 truncate">{url}</code>
        <Button variant="outline" size="sm" onClick={copyToClipboard}>
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="h-4 w-4" />
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
```

**Step 3: Integrate into order page**

In `packages/server/src/app/(dashboard)/orders/[id]/page.tsx`:

Add imports:
```typescript
import { PublishModal } from '@/components/publish-modal';
import { ShareLinkCard } from '@/components/share-link-card';
import { Share2 } from 'lucide-react';
```

Add state variables:
```typescript
const [publishRepo, setPublishRepo] = useState<string | null>(null);
const [shareToken, setShareToken] = useState<string | null>(null);
```

Add "Publish" button next to each repo in the completed order's repo list, or as a top-level action button when order is COMPLETED:
```tsx
{order.status === 'COMPLETED' && (
  <Button variant="outline" size="sm" onClick={() => setPublishRepo(repos[0]?.fullName)}>
    <Share2 className="h-4 w-4 mr-2" />
    Publish
  </Button>
)}
```

Add modal and share link at the bottom of the component:
```tsx
{publishRepo && (
  <PublishModal
    open={!!publishRepo}
    onOpenChange={(open) => !open && setPublishRepo(null)}
    orderId={id}
    repository={publishRepo}
    developers={metrics.map(m => ({ email: m.developerEmail, name: m.developerName }))}
    onPublished={(token) => setShareToken(token)}
  />
)}
{shareToken && <ShareLinkCard token={shareToken} />}
```

**Step 4: Commit**

```bash
git add packages/server/src/components/publish-modal.tsx packages/server/src/components/share-link-card.tsx packages/server/src/app/(dashboard)/orders/[id]/page.tsx
git commit -m "feat(ui): add publish button and share link to order page"
```

---

## Task 14: Dashboard — Publications Management Page

**Files:**
- Create: `packages/server/src/app/(dashboard)/publications/page.tsx`
- Modify: `packages/server/src/components/layout/sidebar.tsx`

**Step 1: Create publications management page**

Create `packages/server/src/app/(dashboard)/publications/page.tsx`:

Follow the pattern from `admin/promo-codes/page.tsx`:
- `'use client'`
- `useQuery` for listing, `useMutation` for toggle/delete
- Table with slug, repo, status toggle, viewCount, actions dropdown

```tsx
'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Trash2, ExternalLink, Eye } from 'lucide-react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';

interface Publication {
  id: string;
  owner: string;
  repo: string;
  slug: string;
  shareToken: string | null;
  isActive: boolean;
  viewCount: number;
  createdAt: string;
  order: { name: string; status: string };
}

export default function PublicationsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: publications = [], isLoading } = useQuery({
    queryKey: ['publications'],
    queryFn: async () => {
      const res = await fetch('/api/publications');
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data as Publication[];
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await fetch(`/api/publications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['publications'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/publications/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['publications'] });
      toast({ title: 'Deleted' });
    },
  });

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">My Publications</h1>

      {publications.length === 0 ? (
        <p className="text-muted-foreground">
          No publications yet. Publish a repository from a completed order.
        </p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead>Order</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Views</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {publications.map((pub) => (
                  <TableRow key={pub.id}>
                    <TableCell className="font-medium">{pub.slug}</TableCell>
                    <TableCell className="text-muted-foreground">{pub.order.name}</TableCell>
                    <TableCell>
                      <Switch
                        checked={pub.isActive}
                        onCheckedChange={(checked) =>
                          toggleMutation.mutate({ id: pub.id, isActive: checked })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1">
                        <Eye className="h-3 w-3" /> {pub.viewCount}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {pub.shareToken && (
                          <Button variant="ghost" size="sm" asChild>
                            <a href={`/share/${pub.shareToken}`} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          </Button>
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete publication?</AlertDialogTitle>
                              <AlertDialogDescription>
                                The share link will stop working. This cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => deleteMutation.mutate(pub.id)}>
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

**Step 2: Add to sidebar navigation**

In `packages/server/src/components/layout/sidebar.tsx`, add to `navigation` array:

```typescript
import { Share2 } from 'lucide-react';

// In the navigation array:
{ name: 'Publications', href: '/publications', icon: Share2 },
```

**Step 3: Commit**

```bash
git add packages/server/src/app/(dashboard)/publications/ packages/server/src/components/layout/sidebar.tsx
git commit -m "feat(ui): add publications management page and sidebar link"
```

---

## Task 15: Dashboard — Developer Profile Editor

**Files:**
- Create: `packages/server/src/app/(dashboard)/profile/page.tsx`

**Step 1: Create profile editor page**

Create `packages/server/src/app/(dashboard)/profile/page.tsx`:

```tsx
'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Loader2, ExternalLink } from 'lucide-react';

export default function ProfilePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile'],
    queryFn: async () => {
      const res = await fetch('/api/profile');
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
  });

  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (profile) {
      setSlug(profile.slug || '');
      setDisplayName(profile.displayName || '');
      setBio(profile.bio || '');
      setIsActive(profile.isActive ?? true);
    }
  }, [profile]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const method = profile ? 'PATCH' : 'POST';
      const res = await fetch('/api/profile', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, displayName, bio, isActive }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] });
      toast({ title: 'Profile saved' });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="text-2xl font-bold">Developer Profile</h1>

      <Card>
        <CardHeader>
          <CardTitle>Public Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="slug">Profile URL</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">/dev/</span>
              <Input
                id="slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="your-username"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="displayName">Display Name</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="John Doe"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="bio">Bio</Label>
            <Textarea
              id="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A few words about yourself..."
              rows={3}
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch checked={isActive} onCheckedChange={setIsActive} />
            <Label>Profile active</Label>
          </div>

          <div className="flex items-center gap-3">
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !slug || !displayName}
            >
              {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {profile ? 'Save Changes' : 'Create Profile'}
            </Button>
            {profile?.slug && (
              <Button variant="outline" asChild>
                <a href={`/dev/${profile.slug}`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  View Profile
                </a>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 2: Add profile link to sidebar**

In `packages/server/src/components/layout/sidebar.tsx`, add to footer section (near Settings):

```typescript
import { UserCircle } from 'lucide-react';

// Add before or after Settings link:
{ name: 'Profile', href: '/profile', icon: UserCircle },
```

**Step 3: Commit**

```bash
git add packages/server/src/app/(dashboard)/profile/ packages/server/src/components/layout/sidebar.tsx
git commit -m "feat(ui): add developer profile editor page"
```

---

## Task 16: Admin — Publications Curation Panel

**Files:**
- Create: `packages/server/src/app/(dashboard)/admin/publications/page.tsx`

**Step 1: Create admin publications page**

Follow the exact pattern from `admin/promo-codes/page.tsx`. This is a large page — structure:

- Table listing all publications with: slug, type (USER/ADMIN), publisher, featured toggle, active toggle, views, actions
- Create dialog: select order → select repo → set title/description/featured
- Edit dialog: modify title, description, featured, sortOrder
- Delete confirmation dialog

Create `packages/server/src/app/(dashboard)/admin/publications/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plus, MoreHorizontal, Pencil, Trash2, Search, Star, Eye } from 'lucide-react';

// Full admin page implementation following promo-codes pattern.
// Key features:
// - Search filter by slug/title
// - Type filter (USER/ADMIN/ALL)
// - Featured toggle inline
// - Create new ADMIN publication: select from completed orders, pick repo, set metadata
// - Edit modal for title, description, sortOrder
// - Delete with confirmation

// [Implementation follows the same pattern as admin/promo-codes/page.tsx
//  with adapted fields. The page is ~300 lines following the exact same
//  useQuery/useMutation/Dialog pattern.]

export default function AdminPublicationsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [editPub, setEditPub] = useState<any>(null);

  // --- Data fetching ---
  const { data, isLoading } = useQuery({
    queryKey: ['admin-publications', page, search],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (search) params.set('search', search);
      const res = await fetch(`/api/admin/publications?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
  });

  // --- Mutations ---
  const toggleFeatured = useMutation({
    mutationFn: async ({ id, isFeatured }: { id: string; isFeatured: boolean }) => {
      const res = await fetch(`/api/admin/publications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isFeatured }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-publications'] }),
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const res = await fetch(`/api/admin/publications/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-publications'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/publications/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-publications'] });
      toast({ title: 'Deleted' });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Publications</h1>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-2" /> New Publication
        </Button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Repository</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Publisher</TableHead>
                  <TableHead>Featured</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>Views</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items?.map((pub: any) => (
                  <TableRow key={pub.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{pub.title || pub.slug}</p>
                        <p className="text-xs text-muted-foreground">{pub.slug}</p>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={pub.publishType === 'ADMIN' ? 'default' : 'outline'}>
                        {pub.publishType}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {pub.publishedBy?.name || pub.publishedBy?.email}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={pub.isFeatured}
                        onCheckedChange={(checked) =>
                          toggleFeatured.mutate({ id: pub.id, isFeatured: checked })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={pub.isActive}
                        onCheckedChange={(checked) =>
                          toggleActive.mutate({ id: pub.id, isActive: checked })
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Eye className="h-3 w-3" /> {pub.viewCount}
                      </span>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setEditPub(pub)}>
                            <Pencil className="h-4 w-4 mr-2" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => window.open(`/explore/${pub.slug}`, '_blank')}>
                            <Eye className="h-4 w-4 mr-2" /> View
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => deleteMutation.mutate(pub.id)}
                          >
                            <Trash2 className="h-4 w-4 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* --- Create Dialog --- */}
      <CreatePublicationDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => {
          queryClient.invalidateQueries({ queryKey: ['admin-publications'] });
          setShowCreate(false);
          toast({ title: 'Publication created' });
        }}
      />

      {/* --- Edit Dialog --- */}
      {editPub && (
        <EditPublicationDialog
          publication={editPub}
          open={!!editPub}
          onOpenChange={(open) => !open && setEditPub(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['admin-publications'] });
            setEditPub(null);
            toast({ title: 'Publication updated' });
          }}
        />
      )}
    </div>
  );
}

// --- Create Dialog: select completed order, pick repo, set metadata ---
function CreatePublicationDialog({
  open, onOpenChange, onCreated,
}: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const [orderId, setOrderId] = useState('');
  const [repository, setRepository] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isFeatured, setIsFeatured] = useState(false);

  // Fetch completed orders for selection
  // Note: GET /api/admin/orders returns { orders: [...], pagination } and strips selectedRepos
  const { data: orders = [] } = useQuery({
    queryKey: ['admin-orders-completed'],
    queryFn: async () => {
      const res = await fetch('/api/admin/orders?status=COMPLETED&pageSize=100');
      const json = await res.json();
      return json.success ? (json.data.orders ?? []) : [];
    },
    enabled: open,
  });

  // Fetch full order detail (with selectedRepos) when an order is selected
  const { data: selectedOrder } = useQuery({
    queryKey: ['admin-order-detail', orderId],
    queryFn: async () => {
      const res = await fetch(`/api/orders/${orderId}`);
      const json = await res.json();
      return json.success ? json.data : null;
    },
    enabled: !!orderId,
  });

  const repos: string[] = selectedOrder?.selectedRepos
    ? (selectedOrder.selectedRepos as any[]).map(
        (r: any) => r.full_name ?? r.fullName ?? `${(r.owner as any)?.login}/${r.name}`
      )
    : [];

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/admin/publications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, repository, title: title || undefined, description: description || undefined, isFeatured }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: onCreated,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Publication</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Order</Label>
            <select
              className="w-full border rounded px-3 py-2 text-sm"
              value={orderId}
              onChange={(e) => { setOrderId(e.target.value); setRepository(''); }}
            >
              <option value="">Select order...</option>
              {orders.map((o: any) => (
                <option key={o.id} value={o.id}>{o.name} ({o.id.slice(0, 8)})</option>
              ))}
            </select>
          </div>
          {repos.length > 0 && (
            <div className="space-y-2">
              <Label>Repository</Label>
              <select
                className="w-full border rounded px-3 py-2 text-sm"
                value={repository}
                onChange={(e) => setRepository(e.target.value)}
              >
                <option value="">Select repo...</option>
                {repos.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-2">
            <Label>Title (optional)</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Custom title..." />
          </div>
          <div className="space-y-2">
            <Label>Description (optional)</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={isFeatured} onCheckedChange={setIsFeatured} />
            <Label>Featured</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => createMutation.mutate()} disabled={!orderId || !repository || createMutation.isPending}>
            {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Edit Dialog: title, description, sortOrder ---
function EditPublicationDialog({
  publication, open, onOpenChange, onSaved,
}: { publication: any; open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const [title, setTitle] = useState(publication.title || '');
  const [description, setDescription] = useState(publication.description || '');
  const [sortOrder, setSortOrder] = useState(publication.sortOrder || 0);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/publications/${publication.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || null, description: description || null, sortOrder }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: onSaved,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit: {publication.slug}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>
          <div className="space-y-2">
            <Label>Sort Order</Label>
            <Input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Add to admin sidebar**

In `packages/server/src/components/layout/sidebar.tsx`, add to `adminNavigation` array:

```typescript
import { Globe } from 'lucide-react';

// In adminNavigation array:
{ name: 'Publications', href: '/admin/publications', icon: Globe },
```

**Step 3: Commit**

```bash
git add packages/server/src/app/(dashboard)/admin/publications/ packages/server/src/components/layout/sidebar.tsx
git commit -m "feat(ui): add admin publications curation panel"
```

---

## ~~Task 17: QueryClient Provider for Public Pages~~ REMOVED

> Not needed. `Providers` (QueryClientProvider + SessionProvider) already wraps `children` in root `app/layout.tsx`. All pages get providers automatically.

---

## Task 17: Share Token Regeneration

**Files:**
- Modify: `packages/server/src/app/api/publications/[id]/route.ts`

**Step 1: Add regenerate-token endpoint to PATCH**

In `packages/server/src/app/api/publications/[id]/route.ts`, extend the PATCH handler:

```typescript
import { createId } from '@paralleldrive/cuid2';

// In PATCH handler, add:
if (body.regenerateToken) {
  allowedFields.shareToken = createId();
}
```

The client sends `{ regenerateToken: true }` and gets back the publication with a new `shareToken`.

**Step 2: Add "Regenerate" button to publications management page**

In `packages/server/src/app/(dashboard)/publications/page.tsx`, add a button in the actions column:

```tsx
<Button
  variant="ghost"
  size="sm"
  onClick={() => regenerateMutation.mutate(pub.id)}
  title="Regenerate share link"
>
  <RefreshCw className="h-4 w-4" />
</Button>
```

With mutation:
```typescript
const regenerateMutation = useMutation({
  mutationFn: async (id: string) => {
    const res = await fetch(`/api/publications/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerateToken: true }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);
    return json.data;
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['publications'] });
    toast({ title: 'Share link regenerated' });
  },
});
```

**Step 3: Commit**

```bash
git add packages/server/src/app/api/publications/[id]/route.ts packages/server/src/app/(dashboard)/publications/page.tsx
git commit -m "feat(api): add share token regeneration"
```

---

## Task 18: Integration Testing & Smoke Test

**Step 1: Run the test suite**

Run: `cd packages/server && pnpm test`
Expected: All existing tests pass, new tests pass.

**Step 2: Build check**

Run: `cd packages/server && pnpm build`
Expected: No TypeScript errors, build succeeds.

**Step 3: Manual smoke test checklist**

- [ ] Start dev server: `cd packages/server && pnpm dev`
- [ ] Visit `/explore` — should show empty catalog (or seeded publications)
- [ ] Login as admin → navigate to Admin → Publications
- [ ] Create a showcase publication from a completed order
- [ ] Visit `/explore` — publication appears
- [ ] Visit `/explore/[owner]/[repo]` — read-only dashboard renders
- [ ] Login as user → complete an order → click Publish
- [ ] Share link appears, copy it
- [ ] Open share link in incognito → read-only dashboard renders
- [ ] Navigate to Publications page → toggle active off → share link returns 404
- [ ] Navigate to Profile → create profile → visit `/dev/[slug]`

**Step 4: Commit final state**

```bash
git add -A
git commit -m "feat: public analytics sharing — complete implementation"
```

---

## Summary of Commits

| # | Message | Files |
|---|---------|-------|
| 1 | `feat(schema): add RepoPublication and DeveloperProfile models` | schema.prisma |
| 2 | `feat(auth): add publications and profile to protected routes` | middleware.ts, auth.config.ts |
| 3 | `feat(services): per-repo metrics + GhostDeveloperTable readOnly` | publication-metrics.ts + test, ghost-developer-table.tsx |
| 4 | `feat(api): add user publications CRUD endpoints` | api/publications/ |
| 5 | `feat(api): add public explore, repo detail, share endpoints` | api/explore/, api/share/ |
| 6 | `feat(api): add developer profile CRUD endpoints` | api/profile/ |
| 7 | `feat(api): add public developer profile endpoints` | api/dev/ |
| 8 | `feat(api): add admin publications management endpoints` | api/admin/publications/ |
| 9 | `feat(ui): add explore catalog page (SSR + client search)` | (public)/explore/, components |
| 10 | `feat(ui): add public repo analytics page with SSR` | explore/[owner]/[repo]/, public-dashboard |
| 11 | `feat(ui): add share-by-token public page` | (public)/share/ |
| 12 | `feat(ui): add public developer profile page` | (public)/dev/, dev-profile-view |
| 13 | `feat(ui): add publish button and share link to order page` | orders/[id], publish-modal, share-link-card |
| 14 | `feat(ui): add publications management page` | (dashboard)/publications/, sidebar |
| 15 | `feat(ui): add developer profile editor` | (dashboard)/profile/ |
| 16 | `feat(ui): add admin publications curation panel` | admin/publications/ |
| 17 | `feat(api): add share token regeneration` | api/publications/[id], publications page |
| 18 | `feat: public analytics sharing — integration testing` | — |

## Deferred to v2

- **Rate limiting** on public APIs (consider middleware-level or per-route)
- **Debounced viewCount** (current: increment on every request; future: batch/debounce)
- **Dynamic OG images** (og:image with rendered metrics; requires @vercel/og or similar)
