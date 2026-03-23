# Admin Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a full admin panel with user management, order oversight, system monitoring, audit logging, and system settings.

**Architecture:** New route group `admin/` inside `(dashboard)`, admin guard layout, API routes under `/api/admin/`, AuditLog model, sidebar section visible only to admins.

**Tech Stack:** Next.js App Router, Prisma, React 19, TanStack Query, shadcn/ui, Zod, Pino logger.

**Design doc:** `docs/plans/2026-02-24-admin-panel-design.md`

---

## Task 1: Schema Changes (User fields + AuditLog model)

**Files:**
- Modify: `packages/server/prisma/schema.prisma`

**Step 1: Add fields to User model**

In `packages/server/prisma/schema.prisma`, add three fields to the `User` model (after `role` field, line ~28):

```prisma
  isBlocked        Boolean  @default(false)
  blockedAt        DateTime?
  lastLoginAt      DateTime?
```

Also add relation to AuditLog:
```prisma
  auditLogs        AuditLog[]
```

**Step 2: Add AuditLog model**

After the `SystemSettings` model block, add:

```prisma
// ==================== AUDIT LOG ====================

model AuditLog {
  id         String   @id @default(cuid())
  userId     String?
  user       User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  action     String
  targetType String?
  targetId   String?
  details    Json     @default("{}")
  createdAt  DateTime @default(now())

  @@index([userId])
  @@index([action])
  @@index([createdAt])
}
```

**Step 3: Apply schema to database**

Run: `cd packages/server && pnpm db:push`
Expected: Schema applied, no errors.

**Step 4: Generate Prisma client**

Run: `cd packages/server && pnpm db:generate`
Expected: Prisma client generated.

**Step 5: Commit**

```bash
git add packages/server/prisma/schema.prisma
git commit -m "feat(admin): add User.isBlocked/lastLoginAt fields and AuditLog model"
```

---

## Task 2: Audit Log Utility (`lib/audit.ts`)

**Files:**
- Create: `packages/server/src/lib/audit.ts`
- Test: `packages/server/src/lib/__tests__/audit.test.ts`

**Step 1: Write the test**

Create `packages/server/src/lib/__tests__/audit.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma
vi.mock('@/lib/db', () => ({
  default: {
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'test-id' }),
    },
  },
}));

import { auditLog } from '../audit';
import prisma from '@/lib/db';

describe('auditLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates audit log entry with all fields', async () => {
    await auditLog({
      userId: 'user-1',
      action: 'admin.user.block',
      targetType: 'User',
      targetId: 'user-2',
      details: { reason: 'spam' },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        action: 'admin.user.block',
        targetType: 'User',
        targetId: 'user-2',
        details: { reason: 'spam' },
      },
    });
  });

  it('creates audit log entry with minimal fields', async () => {
    await auditLog({ action: 'auth.login' });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: undefined,
        action: 'auth.login',
        targetType: undefined,
        targetId: undefined,
        details: {},
      },
    });
  });

  it('does not throw on DB error (fire-and-forget)', async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(new Error('DB down'));

    await expect(
      auditLog({ action: 'auth.login' })
    ).resolves.toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/server && pnpm test src/lib/__tests__/audit.test.ts`
Expected: FAIL — module `../audit` not found.

**Step 3: Implement `lib/audit.ts`**

Create `packages/server/src/lib/audit.ts`:

```typescript
import prisma from '@/lib/db';
import { logger } from '@/lib/logger';

export interface AuditLogParams {
  userId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

/**
 * Write an audit log entry. Fire-and-forget — never throws.
 */
export async function auditLog(params: AuditLogParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        targetType: params.targetType,
        targetId: params.targetId,
        details: params.details ?? {},
      },
    });
  } catch (err) {
    logger.error({ err, auditAction: params.action }, 'Failed to write audit log');
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/server && pnpm test src/lib/__tests__/audit.test.ts`
Expected: 3 tests PASS.

**Step 5: Commit**

```bash
git add packages/server/src/lib/audit.ts packages/server/src/lib/__tests__/audit.test.ts
git commit -m "feat(admin): add audit log utility with tests"
```

---

## Task 3: Auth Events, blocked user enforcement, JWT role freshness

**Files:**
- Modify: `packages/server/src/lib/auth.ts` (authorize callback, jwt callback)
- Modify: `packages/server/src/lib/api-utils.ts` (getUserSession — isBlocked check)
- Modify: `packages/server/src/app/api/auth/register/route.ts`

**Step 1: Block login for blocked users and log auth events**

In `packages/server/src/lib/auth.ts`, modify the `authorize` function inside `Credentials` provider (line ~72):

After the existing `select` on line 79, add `isBlocked: true` to the select:
```typescript
select: { id: true, email: true, passwordHash: true, role: true, isBlocked: true },
```

After password validation succeeds (after line 93), add blocked check:
```typescript
if (user.isBlocked) {
  // Fire audit for blocked attempt (fire-and-forget, no await in authorize)
  auditLog({
    userId: user.id,
    action: 'auth.blocked_attempt',
    details: { email: user.email },
  });
  return null;
}
```

Add at the top of auth.ts:
```typescript
import { auditLog } from './audit';
```

In the `jwt` callback, replace the entire `if (user)` block AND the `if (!token.role)` block with:
```typescript
if (user) {
  token.id = user.id as string;
  token.email = user.email as string;
  token.role = (user as { role?: string }).role as JWT['role'] ?? 'USER';

  // Audit: successful login (fire-and-forget)
  auditLog({ userId: user.id as string, action: 'auth.login' });

  // Update lastLoginAt (fire-and-forget)
  prisma.user.update({
    where: { id: user.id as string },
    data: { lastLoginAt: new Date() },
  }).catch(() => {});
}

// Always refresh role from DB to catch role changes between token refreshes
if (token.email) {
  const dbUser = await prisma.user.findUnique({
    where: { email: token.email as string },
    select: { role: true },
  });
  if (dbUser) token.role = dbUser.role;
}
```

This replaces the old "refresh only if missing" logic — role is now always fresh.

**Step 2: Add isBlocked check to getUserSession**

In `packages/server/src/lib/api-utils.ts`, modify `getUserSession()` to also select and check `isBlocked`:

```typescript
const user = await prisma.user.findUnique({
  where: { email: session.user.email },
  select: { id: true, email: true, isBlocked: true },
});

if (!user || user.isBlocked) {
  return null;
}
```

This ensures that even with a valid JWT, a blocked user gets rejected on every API call immediately.

**Step 3: Audit registration**

In `packages/server/src/app/api/auth/register/route.ts`, after the `prisma.user.create` call (line ~54), add:

```typescript
import { auditLog } from '@/lib/audit';
```

After user creation:
```typescript
// Audit: user registered
await auditLog({
  userId: user.id,
  action: 'auth.register',
  details: { email: user.email },
});
```

**Step 4: Verify app compiles**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add packages/server/src/lib/auth.ts packages/server/src/lib/api-utils.ts packages/server/src/app/api/auth/register/route.ts
git commit -m "feat(admin): add auth audit events, blocked user enforcement, JWT role refresh"
```

---

## Task 4: Admin Layout Guard + Middleware

**Files:**
- Create: `packages/server/src/app/(dashboard)/admin/layout.tsx`
- Modify: `packages/server/middleware.ts`
- Modify: `packages/server/src/lib/auth.config.ts`

**Step 1: Create admin layout guard**

Create `packages/server/src/app/(dashboard)/admin/layout.tsx`:

```typescript
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  return <>{children}</>;
}
```

**Step 2: Add `/admin` to middleware matcher**

In `packages/server/middleware.ts`, add `/admin/:path*` to the matcher array:

```typescript
export const config = {
  matcher: [
    '/dashboard/:path*',
    '/orders/:path*',
    '/demo/:path*',
    '/settings/:path*',
    '/admin/:path*',
    '/login',
    '/register',
  ],
};
```

**Step 3: Add `/admin` to protected paths in auth.config.ts**

In `packages/server/src/lib/auth.config.ts`, add `'/admin'` to the `protectedPaths` array (line ~16):

```typescript
const protectedPaths = [
  '/dashboard',
  '/orders',
  '/demo',
  '/settings',
  '/admin',
];
```

**Step 4: Commit**

```bash
git add packages/server/src/app/(dashboard)/admin/layout.tsx packages/server/middleware.ts packages/server/src/lib/auth.config.ts
git commit -m "feat(admin): add admin layout guard and middleware protection"
```

---

## Task 5: Admin Sidebar Section

**Files:**
- Modify: `packages/server/src/components/layout/sidebar.tsx`

**Step 1: Add session query and admin nav items**

In `packages/server/src/components/layout/sidebar.tsx`:

Add `useSession` import:
```typescript
import { signOut, useSession } from 'next-auth/react';
```

Add admin nav icons import (add to existing lucide import):
```typescript
import {
  LayoutDashboard,
  ClipboardList,
  Settings,
  LogOut,
  Plus,
  Circle,
  Shield,
  Users,
  ListOrdered,
  Activity,
  ScrollText,
  Settings2,
} from 'lucide-react';
```

Add admin navigation array after the existing `navigation` array:
```typescript
const adminNavigation = [
  { name: 'Overview', href: '/admin', icon: Shield },
  { name: 'Users', href: '/admin/users', icon: Users },
  { name: 'All Orders', href: '/admin/orders', icon: ListOrdered },
  { name: 'Monitoring', href: '/admin/monitoring', icon: Activity },
  { name: 'Audit Log', href: '/admin/audit', icon: ScrollText },
  { name: 'Settings', href: '/admin/settings', icon: Settings2 },
];
```

Inside the `Sidebar` component, add session check:
```typescript
const { data: session } = useSession();
const isAdmin = session?.user?.role === 'ADMIN';
```

In the JSX, after the `</nav>` closing tag of the main navigation and before the Footer section, add the admin section:

```tsx
{/* Admin Navigation */}
{isAdmin && (
  <>
    <div className="px-4">
      <Separator />
    </div>
    <nav className="space-y-1 px-4 py-2">
      <p className="px-3 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Admin
      </p>
      {adminNavigation.map((item) => {
        const isActive = item.href === '/admin'
          ? pathname === '/admin'
          : pathname.startsWith(item.href);
        return (
          <Link
            key={item.name}
            href={item.href}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <item.icon className="h-5 w-5" />
            {item.name}
          </Link>
        );
      })}
    </nav>
  </>
)}
```

**Step 2: Verify app compiles**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add packages/server/src/components/layout/sidebar.tsx
git commit -m "feat(admin): add admin section to sidebar (ADMIN-only)"
```

---

## Task 6: Admin Stats API + Overview Page

**Files:**
- Create: `packages/server/src/app/api/admin/stats/route.ts`
- Create: `packages/server/src/app/(dashboard)/admin/page.tsx`

**Step 1: Create stats API**

Create `packages/server/src/app/api/admin/stats/route.ts`:

```typescript
import prisma from '@/lib/db';
import { apiResponse, requireAdmin, isErrorResponse } from '@/lib/api-utils';

export async function GET() {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  const [
    totalUsers,
    blockedUsers,
    totalOrders,
    ordersByStatus,
    activeJobs,
    recentAudit,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isBlocked: true } }),
    prisma.order.count(),
    prisma.order.groupBy({
      by: ['status'],
      _count: { id: true },
    }),
    prisma.analysisJob.count({
      where: { status: { in: ['PENDING', 'RUNNING'] } },
    }),
    prisma.auditLog.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true } } },
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const entry of ordersByStatus) {
    statusCounts[entry.status] = entry._count.id;
  }

  return apiResponse({
    users: { total: totalUsers, blocked: blockedUsers, active: totalUsers - blockedUsers },
    orders: {
      total: totalOrders,
      processing: statusCounts['PROCESSING'] ?? 0,
      completed: statusCounts['COMPLETED'] ?? 0,
      failed: statusCounts['FAILED'] ?? 0,
    },
    activeJobs,
    recentAudit: recentAudit.map((entry) => ({
      id: entry.id,
      action: entry.action,
      userEmail: entry.user?.email ?? null,
      targetType: entry.targetType,
      targetId: entry.targetId,
      createdAt: entry.createdAt,
    })),
  });
}
```

**Step 2: Create overview page**

Create `packages/server/src/app/(dashboard)/admin/page.tsx`:

```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Users, ClipboardList, Activity, ScrollText } from 'lucide-react';

interface AdminStats {
  users: { total: number; active: number; blocked: number };
  orders: { total: number; processing: number; completed: number; failed: number };
  activeJobs: number;
  recentAudit: {
    id: string;
    action: string;
    userEmail: string | null;
    targetType: string | null;
    targetId: string | null;
    createdAt: string;
  }[];
}

export default function AdminOverviewPage() {
  const { data: stats, isLoading } = useQuery<AdminStats>({
    queryKey: ['admin-stats'],
    queryFn: async () => {
      const res = await fetch('/api/admin/stats');
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!stats) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Admin Overview</h1>
        <p className="text-muted-foreground">System status at a glance</p>
      </div>

      {/* Stats Cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.users.total}</div>
            <p className="text-xs text-muted-foreground">
              {stats.users.active} active, {stats.users.blocked} blocked
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Orders</CardTitle>
            <ClipboardList className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.orders.total}</div>
            <p className="text-xs text-muted-foreground">
              {stats.orders.completed} completed, {stats.orders.failed} failed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Jobs</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.activeJobs}</div>
            <p className="text-xs text-muted-foreground">
              {stats.orders.processing} orders processing
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Recent Events</CardTitle>
            <ScrollText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.recentAudit.length}</div>
            <p className="text-xs text-muted-foreground">last audit entries</p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Audit Log */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Last 10 audit log entries</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {stats.recentAudit.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between rounded-md border px-4 py-2 text-sm"
              >
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="font-mono text-xs">
                    {entry.action}
                  </Badge>
                  <span className="text-muted-foreground">
                    {entry.userEmail ?? 'system'}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </div>
            ))}
            {stats.recentAudit.length === 0 && (
              <p className="text-sm text-muted-foreground">No audit events yet</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 3: Verify app compiles**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add packages/server/src/app/api/admin/stats/route.ts packages/server/src/app/(dashboard)/admin/page.tsx
git commit -m "feat(admin): add overview page with stats API"
```

---

## Task 7: User Management API

**Files:**
- Create: `packages/server/src/app/api/admin/users/route.ts`
- Create: `packages/server/src/app/api/admin/users/[id]/route.ts`
- Create: `packages/server/src/app/api/admin/users/[id]/reset-password/route.ts`

**Step 1: Create users list API**

Create `packages/server/src/app/api/admin/users/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  const url = request.nextUrl;
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20')));
  const search = url.searchParams.get('search')?.trim() ?? '';

  const where = search
    ? {
        OR: [
          { email: { contains: search, mode: 'insensitive' as const } },
          { name: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isBlocked: true,
        blockedAt: true,
        lastLoginAt: true,
        createdAt: true,
        _count: { select: { orders: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  return apiResponse({
    users: users.map((u) => ({
      ...u,
      orderCount: u._count.orders,
      _count: undefined,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}
```

**Step 2: Create user update/delete API**

Create `packages/server/src/app/api/admin/users/[id]/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { auditLog } from '@/lib/audit';

const updateSchema = z.object({
  role: z.enum(['USER', 'ADMIN']).optional(),
  isBlocked: z.boolean().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true, isBlocked: true },
  });
  if (!target) return apiError('User not found', 404);

  // Prevent self-modification
  if (target.id === session.user.id) {
    return apiError('Cannot modify your own account', 400);
  }

  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return apiError(parsed.error.errors[0].message, 400);

  const data: Record<string, unknown> = {};

  if (parsed.data.role !== undefined) {
    // Last-admin protection: prevent demoting when only one admin remains
    if (target.role === 'ADMIN' && parsed.data.role !== 'ADMIN') {
      const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
      if (adminCount <= 1) {
        return apiError('Cannot demote the last admin', 400);
      }
    }
    data.role = parsed.data.role;
    await auditLog({
      userId: session.user.id,
      action: 'admin.user.role_change',
      targetType: 'User',
      targetId: id,
      details: { oldRole: target.role, newRole: parsed.data.role },
    });
  }

  if (parsed.data.isBlocked !== undefined) {
    data.isBlocked = parsed.data.isBlocked;
    if (parsed.data.isBlocked) {
      data.blockedAt = new Date();
      await auditLog({
        userId: session.user.id,
        action: 'admin.user.block',
        targetType: 'User',
        targetId: id,
        details: { email: target.email },
      });
    } else {
      data.blockedAt = null;
      await auditLog({
        userId: session.user.id,
        action: 'admin.user.unblock',
        targetType: 'User',
        targetId: id,
        details: { email: target.email },
      });
    }
  }

  if (Object.keys(data).length === 0) {
    return apiError('No fields to update', 400);
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, email: true, name: true, role: true, isBlocked: true, blockedAt: true },
  });

  return apiResponse(updated);
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true, role: true },
  });
  if (!target) return apiError('User not found', 404);

  if (target.id === session.user.id) {
    return apiError('Cannot delete your own account', 400);
  }

  // Last-admin protection
  if (target.role === 'ADMIN') {
    const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
    if (adminCount <= 1) {
      return apiError('Cannot delete the last admin', 400);
    }
  }

  await auditLog({
    userId: session.user.id,
    action: 'admin.user.delete',
    targetType: 'User',
    targetId: id,
    details: { email: target.email },
  });

  await prisma.user.delete({ where: { id } });

  return apiResponse({ deleted: true });
}
```

**Step 3: Create password reset API**

Create `packages/server/src/app/api/admin/users/[id]/reset-password/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { hashPassword } from '@/lib/auth';
import { auditLog } from '@/lib/audit';
import crypto from 'crypto';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, email: true },
  });
  if (!target) return apiError('User not found', 404);

  // Generate random 12-char password
  const tempPassword = crypto.randomBytes(9).toString('base64url');
  const passwordHash = await hashPassword(tempPassword);

  await prisma.user.update({
    where: { id },
    data: { passwordHash },
  });

  await auditLog({
    userId: session.user.id,
    action: 'admin.user.reset_password',
    targetType: 'User',
    targetId: id,
    details: { email: target.email },
  });

  return apiResponse({ tempPassword });
}
```

**Step 4: Verify app compiles**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add packages/server/src/app/api/admin/users/
git commit -m "feat(admin): add user management API (list, update, delete, reset password)"
```

---

## Task 7b: Make `getOrderWithAuth` admin-aware

**Files:**
- Modify: `packages/server/src/lib/api-utils.ts`

**Context:** The design requires admins to view/edit/rerun any user's orders. Currently `getOrderWithAuth()` enforces `userId: session.user.id` ownership check. Instead of duplicating order routes under `/api/admin/`, we make the existing helper admin-aware so all order detail pages and endpoints work for admins without changes.

**Step 1: Modify `getOrderWithAuth` to skip ownership for ADMIN**

In `packages/server/src/lib/api-utils.ts`, modify `getOrderWithAuth()`:

```typescript
export async function getOrderWithAuth<T = Order>(
  orderId: string,
  options?: GetOrderOptions
): Promise<OrderWithAuth<T>> {
  const session = await getUserSession();
  if (!session) {
    return { success: false, error: 'Unauthorized', status: 401 };
  }

  // Check if user is admin (skip ownership check)
  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });
  const isAdmin = currentUser?.role === 'ADMIN';

  // Build query — admin sees all orders, regular user only their own
  const where: { id: string; userId?: string } = { id: orderId };
  if (!isAdmin) {
    where.userId = session.user.id;
  }

  const query: {
    where: typeof where;
    include?: Record<string, unknown>;
    select?: Record<string, unknown>;
  } = { where };

  if (options?.include) query.include = options.include;
  if (options?.select) query.select = options.select;

  const order = await prisma.order.findFirst(query);
  if (!order) {
    return { success: false, error: 'Order not found', status: 404 };
  }

  return { success: true, order: order as T, session };
}
```

Note: `getUserSession()` already does a DB lookup, and now `getOrderWithAuth` does a second one for role. This is acceptable — the role check is a simple primary key lookup. If perf matters later, `getUserSession` could return role too.

**Step 2: Verify existing tests pass**

Run: `cd packages/server && pnpm test`
Expected: All tests pass (no behavior change for non-admin users).

**Step 3: Commit**

```bash
git add packages/server/src/lib/api-utils.ts
git commit -m "feat(admin): make getOrderWithAuth admin-aware (skip ownership check for ADMIN)"
```

---

## Task 8: User Management Page

**Files:**
- Create: `packages/server/src/app/(dashboard)/admin/users/page.tsx`

**Step 1: Create users page**

Create `packages/server/src/app/(dashboard)/admin/users/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, MoreHorizontal, Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface User {
  id: string;
  email: string;
  name: string | null;
  role: 'USER' | 'ADMIN';
  isBlocked: boolean;
  blockedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  orderCount: number;
}

interface UsersResponse {
  users: User[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export default function AdminUsersPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);

  const { data, isLoading } = useQuery<UsersResponse>({
    queryKey: ['admin-users', page, search],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (search) params.set('search', search);
      const res = await fetch(`/api/admin/users?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
  });

  const updateUser = useMutation({
    mutationFn: async ({ id, ...data }: { id: string; role?: string; isBlocked?: boolean }) => {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      toast({ title: 'User updated' });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const deleteUser = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setDeleteTarget(null);
      toast({ title: 'User deleted' });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const resetPassword = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/users/${id}/reset-password`, { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data as { tempPassword: string };
    },
    onSuccess: (data, id) => {
      const user = (data as any); // data has tempPassword
      const target = (data as any);
      // Find user email from current list
      const u = (data as any)?.users?.find?.((u: User) => u.id === id);
      setTempPassword({ email: u?.email ?? id, password: (data as { tempPassword: string }).tempPassword });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const handleSearch = () => {
    setSearch(searchInput);
    setPage(1);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">User Management</h1>
        <p className="text-muted-foreground">Manage users, roles, and access</p>
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by email or name..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="pl-9"
          />
        </div>
        <Button variant="outline" onClick={handleSearch}>Search</Button>
      </div>

      {/* Users Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>Last Login</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-mono text-sm">{user.email}</TableCell>
                    <TableCell>{user.name ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={user.role === 'ADMIN' ? 'default' : 'secondary'}>
                        {user.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.isBlocked ? 'destructive' : 'outline'}>
                        {user.isBlocked ? 'Blocked' : 'Active'}
                      </Badge>
                    </TableCell>
                    <TableCell>{user.orderCount}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString() : '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(user.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              updateUser.mutate({
                                id: user.id,
                                role: user.role === 'ADMIN' ? 'USER' : 'ADMIN',
                              })
                            }
                          >
                            {user.role === 'ADMIN' ? 'Demote to USER' : 'Promote to ADMIN'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              updateUser.mutate({ id: user.id, isBlocked: !user.isBlocked })
                            }
                          >
                            {user.isBlocked ? 'Unblock' : 'Block'}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              const u = data?.users.find((u) => u.id === user.id);
                              resetPassword.mutate(user.id);
                              if (u) {
                                // We'll set the email in onSuccess via the list
                              }
                            }}
                          >
                            Reset Password
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteTarget(user)}
                          >
                            Delete User
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
                {data?.users.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                      No users found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {data.pagination.total} users total
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">
              Page {page} of {data.pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.pagination.totalPages}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {deleteTarget?.email} and all their orders. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteUser.mutate(deleteTarget.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Temp Password Dialog */}
      <Dialog open={!!tempPassword} onOpenChange={() => setTempPassword(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Password Reset</DialogTitle>
            <DialogDescription>
              Temporary password for {tempPassword?.email}. Share it securely — it won't be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md bg-muted p-4 font-mono text-lg text-center select-all">
            {tempPassword?.password}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

Note: The `resetPassword` mutation `onSuccess` handler needs a fix — extract user email before mutating:
```tsx
// Simpler approach: track the email in resetPassword.mutate wrapper
const handleResetPassword = (user: User) => {
  resetPassword.mutate(user.id, {
    onSuccess: (data) => {
      setTempPassword({ email: user.email, password: data.tempPassword });
    },
  });
};
```
Use `handleResetPassword(user)` instead of inline `resetPassword.mutate(user.id)`.

**Step 2: Verify app compiles**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add packages/server/src/app/(dashboard)/admin/users/page.tsx
git commit -m "feat(admin): add user management page"
```

---

## Task 9: Admin Orders API + Page

**Files:**
- Create: `packages/server/src/app/api/admin/orders/route.ts`
- Create: `packages/server/src/app/api/admin/orders/[id]/route.ts`
- Create: `packages/server/src/app/api/admin/orders/[id]/rerun/route.ts`
- Create: `packages/server/src/app/(dashboard)/admin/orders/page.tsx`

**Step 1: Create admin orders list API**

Create `packages/server/src/app/api/admin/orders/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, requireAdmin, isErrorResponse } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  const url = request.nextUrl;
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '20')));
  const status = url.searchParams.get('status') ?? '';
  const userId = url.searchParams.get('userId') ?? '';

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (userId) where.userId = userId;

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: {
        id: true,
        name: true,
        status: true,
        selectedRepos: true,
        totalCommits: true,
        createdAt: true,
        completedAt: true,
        errorMessage: true,
        user: { select: { email: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return apiResponse({
    orders: orders.map((o) => ({
      ...o,
      repoCount: Array.isArray(o.selectedRepos) ? (o.selectedRepos as unknown[]).length : 0,
      ownerEmail: o.user.email,
      ownerName: o.user.name,
      user: undefined,
      selectedRepos: undefined,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}
```

**Step 2: Create admin order delete API**

Create `packages/server/src/app/api/admin/orders/[id]/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { auditLog } from '@/lib/audit';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, name: true, user: { select: { email: true } } },
  });
  if (!order) return apiError('Order not found', 404);

  await auditLog({
    userId: session.user.id,
    action: 'admin.order.delete',
    targetType: 'Order',
    targetId: id,
    details: { orderName: order.name, ownerEmail: order.user.email },
  });

  await prisma.order.delete({ where: { id } });

  return apiResponse({ deleted: true });
}
```

**Step 3: Create admin order rerun API**

Create `packages/server/src/app/api/admin/orders/[id]/rerun/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { processAnalysisJob } from '@/lib/services/analysis-worker';
import { auditLog } from '@/lib/audit';
import { analysisLogger } from '@/lib/logger';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;
  const { id } = await params;

  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) return apiError('Order not found', 404);

  if (order.status === 'PROCESSING') {
    return apiError('Analysis already in progress', 409);
  }

  // Create new analysis job
  const job = await prisma.analysisJob.create({
    data: {
      orderId: id,
      status: 'PENDING',
    },
  });

  // Update order status
  await prisma.order.update({
    where: { id },
    data: {
      status: 'PROCESSING',
      repositoriesProcessed: 0,
      repositoriesFailed: 0,
      errorMessage: null,
    },
  });

  await auditLog({
    userId: session.user.id,
    action: 'admin.order.rerun',
    targetType: 'Order',
    targetId: id,
    details: { jobId: job.id },
  });

  // Fire-and-forget analysis
  processAnalysisJob(job.id).catch((err) => {
    analysisLogger.error({ err, jobId: job.id }, 'Admin rerun failed');
  });

  return apiResponse({ jobId: job.id });
}
```

**Step 4: Create admin orders page**

Create `packages/server/src/app/(dashboard)/admin/orders/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, MoreHorizontal, ChevronLeft, ChevronRight, ExternalLink, RotateCcw } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

const ORDER_STATUSES = ['', 'DRAFT', 'DEVELOPERS_LOADED', 'READY_FOR_ANALYSIS', 'PROCESSING', 'COMPLETED', 'FAILED'];

const statusColors: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  DEVELOPERS_LOADED: 'bg-blue-100 text-blue-700',
  READY_FOR_ANALYSIS: 'bg-yellow-100 text-yellow-700',
  PROCESSING: 'bg-purple-100 text-purple-700',
  COMPLETED: 'bg-green-100 text-green-700',
  FAILED: 'bg-red-100 text-red-700',
};

interface AdminOrder {
  id: string;
  name: string;
  status: string;
  repoCount: number;
  totalCommits: number;
  ownerEmail: string;
  ownerName: string | null;
  createdAt: string;
  completedAt: string | null;
  errorMessage: string | null;
}

export default function AdminOrdersPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AdminOrder | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-orders', page, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/admin/orders?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data as { orders: AdminOrder[]; pagination: { page: number; totalPages: number; total: number } };
    },
  });

  const deleteOrder = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/orders/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-orders'] });
      setDeleteTarget(null);
      toast({ title: 'Order deleted' });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const rerunOrder = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/orders/${id}/rerun`, { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-orders'] });
      toast({ title: 'Analysis re-started' });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">All Orders</h1>
        <p className="text-muted-foreground">View and manage all system orders</p>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v === 'ALL' ? '' : v); setPage(1); }}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All statuses</SelectItem>
            {ORDER_STATUSES.filter(Boolean).map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Orders Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Repos</TableHead>
                  <TableHead>Commits</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-medium max-w-[200px] truncate">
                      {order.name}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {order.ownerEmail}
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColors[order.status] ?? ''}>
                        {order.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{order.repoCount}</TableCell>
                    <TableCell>{order.totalCommits}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(order.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/orders/${order.id}`}>
                              <ExternalLink className="mr-2 h-4 w-4" />
                              View Order
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={order.status === 'PROCESSING'}
                            onClick={() => rerunOrder.mutate(order.id)}
                          >
                            <RotateCcw className="mr-2 h-4 w-4" />
                            Re-run Analysis
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteTarget(order)}
                          >
                            Delete Order
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
                {data?.orders.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      No orders found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{data.pagination.total} orders total</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">Page {page} of {data.pagination.totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= data.pagination.totalPages} onClick={() => setPage(page + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete order?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{deleteTarget?.name}&quot; (owned by {deleteTarget?.ownerEmail}). This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteOrder.mutate(deleteTarget.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

**Step 5: Verify app compiles**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds.

**Step 6: Commit**

```bash
git add packages/server/src/app/api/admin/orders/ packages/server/src/app/(dashboard)/admin/orders/
git commit -m "feat(admin): add admin orders API and page (list, delete, rerun)"
```

---

## Task 10: Monitoring API + Page

**Files:**
- Create: `packages/server/src/app/api/admin/monitoring/route.ts`
- Create: `packages/server/src/app/(dashboard)/admin/monitoring/page.tsx`

**Step 1: Create monitoring API**

Create `packages/server/src/app/api/admin/monitoring/route.ts`:

```typescript
import prisma from '@/lib/db';
import { apiResponse, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import fs from 'fs/promises';
import path from 'path';

const CACHE_DIR = process.env.PIPELINE_CACHE_DIR || path.resolve(process.cwd(), '..', '..', '..', '.cache');

async function dirSize(dir: string): Promise<{ count: number; bytes: number }> {
  let count = 0, bytes = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    for (const e of entries) {
      if (e.isFile()) {
        count++;
        const stat = await fs.stat(path.join(e.parentPath || dir, e.name));
        bytes += stat.size;
      }
    }
  } catch { /* dir doesn't exist */ }
  return { count, bytes };
}

export async function GET() {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  const [activeJobs, recentFailed, repos, diffs, llm] = await Promise.all([
    prisma.analysisJob.findMany({
      where: { status: { in: ['PENDING', 'RUNNING'] } },
      select: {
        id: true,
        status: true,
        progress: true,
        currentStep: true,
        startedAt: true,
        order: { select: { id: true, name: true, user: { select: { email: true } } } },
      },
      orderBy: { startedAt: 'desc' },
      take: 20,
    }),
    prisma.analysisJob.findMany({
      where: { status: 'FAILED' },
      select: {
        id: true,
        error: true,
        completedAt: true,
        order: { select: { id: true, name: true, user: { select: { email: true } } } },
      },
      orderBy: { completedAt: 'desc' },
      take: 10,
    }),
    dirSize(path.join(CACHE_DIR, 'repos')),
    dirSize(path.join(CACHE_DIR, 'diffs')),
    dirSize(path.join(CACHE_DIR, 'llm')),
  ]);

  return apiResponse({
    activeJobs: activeJobs.map((j) => ({
      id: j.id,
      status: j.status,
      progress: j.progress,
      currentStep: j.currentStep,
      startedAt: j.startedAt,
      orderId: j.order.id,
      orderName: j.order.name,
      ownerEmail: j.order.user.email,
    })),
    recentFailed: recentFailed.map((j) => ({
      id: j.id,
      error: j.error,
      completedAt: j.completedAt,
      orderId: j.order.id,
      orderName: j.order.name,
      ownerEmail: j.order.user.email,
    })),
    cache: {
      totalMb: Math.round((repos.bytes + diffs.bytes + llm.bytes) / 1024 / 1024 * 10) / 10,
      repos: repos.count,
      diffs: diffs.count,
      llm: llm.count,
    },
  });
}
```

**Step 2: Create monitoring page**

Create `packages/server/src/app/(dashboard)/admin/monitoring/page.tsx`:

```tsx
'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Trash2, Database, Activity, AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface MonitoringData {
  activeJobs: {
    id: string;
    status: string;
    progress: number;
    currentStep: string | null;
    startedAt: string | null;
    orderId: string;
    orderName: string;
    ownerEmail: string;
  }[];
  recentFailed: {
    id: string;
    error: string | null;
    completedAt: string | null;
    orderId: string;
    orderName: string;
    ownerEmail: string;
  }[];
  cache: { totalMb: number; repos: number; diffs: number; llm: number };
}

export default function AdminMonitoringPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<MonitoringData>({
    queryKey: ['admin-monitoring'],
    queryFn: async () => {
      const res = await fetch('/api/admin/monitoring');
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
    refetchInterval: 10_000,
  });

  const clearCache = useMutation({
    mutationFn: async (level: string) => {
      const res = await fetch(`/api/cache?level=${level}`, { method: 'DELETE' });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      return json;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['admin-monitoring'] });
      toast({ title: 'Cache cleared', description: `Freed ${data.freedMb} MB` });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">System Monitoring</h1>
        <p className="text-muted-foreground">Active jobs, cache, and recent errors</p>
      </div>

      {/* Active Jobs */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            <CardTitle>Active Jobs</CardTitle>
          </div>
          <CardDescription>{data.activeJobs.length} jobs running</CardDescription>
        </CardHeader>
        <CardContent>
          {data.activeJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active jobs</p>
          ) : (
            <div className="space-y-3">
              {data.activeJobs.map((job) => (
                <div key={job.id} className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <p className="font-medium text-sm">{job.orderName}</p>
                    <p className="text-xs text-muted-foreground">{job.ownerEmail}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">{job.currentStep ?? 'Starting...'}</span>
                    <Badge variant="outline">{job.progress}%</Badge>
                    <Badge>{job.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pipeline Cache */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            <CardTitle>Pipeline Cache</CardTitle>
          </div>
          <CardDescription>Cached git repos, diffs, and LLM responses</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-md border p-3 text-center">
              <p className="text-2xl font-bold">{data.cache.totalMb}</p>
              <p className="text-xs text-muted-foreground">Total (MB)</p>
            </div>
            <div className="rounded-md border p-3 text-center">
              <p className="text-2xl font-bold">{data.cache.repos}</p>
              <p className="text-xs text-muted-foreground">Repo clones</p>
            </div>
            <div className="rounded-md border p-3 text-center">
              <p className="text-2xl font-bold">{data.cache.diffs}</p>
              <p className="text-xs text-muted-foreground">Diff cache</p>
            </div>
            <div className="rounded-md border p-3 text-center">
              <p className="text-2xl font-bold">{data.cache.llm}</p>
              <p className="text-xs text-muted-foreground">LLM cache</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={clearCache.isPending}
              onClick={() => clearCache.mutate('all')}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Clear All
            </Button>
            <Button variant="outline" size="sm" disabled={clearCache.isPending} onClick={() => clearCache.mutate('llm')}>
              Clear LLM
            </Button>
            <Button variant="outline" size="sm" disabled={clearCache.isPending} onClick={() => clearCache.mutate('diffs')}>
              Clear Diffs
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Recent Failures */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            <CardTitle>Recent Failures</CardTitle>
          </div>
          <CardDescription>Last 10 failed analysis jobs</CardDescription>
        </CardHeader>
        <CardContent>
          {data.recentFailed.length === 0 ? (
            <p className="text-sm text-muted-foreground">No recent failures</p>
          ) : (
            <div className="space-y-2">
              {data.recentFailed.map((job) => (
                <div key={job.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-sm">{job.orderName}</p>
                    <span className="text-xs text-muted-foreground">
                      {job.completedAt ? new Date(job.completedAt).toLocaleString() : '—'}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{job.ownerEmail}</p>
                  {job.error && (
                    <p className="mt-1 text-xs text-destructive font-mono truncate">{job.error}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 3: Verify app compiles**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add packages/server/src/app/api/admin/monitoring/ packages/server/src/app/(dashboard)/admin/monitoring/
git commit -m "feat(admin): add monitoring page (jobs, cache, failures)"
```

---

## Task 11: Audit Log API + Page

**Files:**
- Create: `packages/server/src/app/api/admin/audit/route.ts`
- Create: `packages/server/src/app/(dashboard)/admin/audit/page.tsx`

**Step 1: Create audit API**

Create `packages/server/src/app/api/admin/audit/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, requireAdmin, isErrorResponse } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const result = await requireAdmin();
  if (isErrorResponse(result)) return result;

  const url = request.nextUrl;
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1'));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get('pageSize') ?? '30')));
  const actionFilter = url.searchParams.get('action') ?? '';
  const userFilter = url.searchParams.get('userId') ?? '';

  const where: Record<string, unknown> = {};
  if (actionFilter) where.action = { startsWith: actionFilter };
  if (userFilter) where.userId = userFilter;

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return apiResponse({
    entries: entries.map((e) => ({
      id: e.id,
      action: e.action,
      userEmail: e.user?.email ?? null,
      userId: e.userId,
      targetType: e.targetType,
      targetId: e.targetId,
      details: e.details,
      createdAt: e.createdAt,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}
```

**Step 2: Create audit page**

Create `packages/server/src/app/(dashboard)/admin/audit/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, ChevronLeft, ChevronRight } from 'lucide-react';

const ACTION_CATEGORIES = [
  { value: '', label: 'All actions' },
  { value: 'auth', label: 'Auth events' },
  { value: 'admin.user', label: 'User management' },
  { value: 'admin.order', label: 'Order management' },
  { value: 'admin.settings', label: 'Settings changes' },
  { value: 'admin.cache', label: 'Cache operations' },
];

const actionColors: Record<string, string> = {
  'auth': 'bg-blue-100 text-blue-700',
  'admin.user': 'bg-orange-100 text-orange-700',
  'admin.order': 'bg-purple-100 text-purple-700',
  'admin.settings': 'bg-green-100 text-green-700',
  'admin.cache': 'bg-gray-100 text-gray-700',
};

function getActionColor(action: string): string {
  for (const [prefix, color] of Object.entries(actionColors)) {
    if (action.startsWith(prefix)) return color;
  }
  return '';
}

interface AuditEntry {
  id: string;
  action: string;
  userEmail: string | null;
  userId: string | null;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export default function AdminAuditPage() {
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['admin-audit', page, actionFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '30' });
      if (actionFilter) params.set('action', actionFilter);
      const res = await fetch(`/api/admin/audit?${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data as { entries: AuditEntry[]; pagination: { page: number; totalPages: number; total: number } };
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Audit Log</h1>
        <p className="text-muted-foreground">System activity history</p>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <Select value={actionFilter || 'ALL'} onValueChange={(v) => { setActionFilter(v === 'ALL' ? '' : v); setPage(1); }}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            {ACTION_CATEGORIES.map((cat) => (
              <SelectItem key={cat.value || 'ALL'} value={cat.value || 'ALL'}>
                {cat.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Audit Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>User</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {new Date(entry.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-sm">
                      {entry.userEmail ?? <span className="text-muted-foreground">system</span>}
                    </TableCell>
                    <TableCell>
                      <Badge className={getActionColor(entry.action)} variant="outline">
                        {entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {entry.targetType && entry.targetId
                        ? `${entry.targetType}:${entry.targetId.slice(0, 8)}`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono max-w-[200px] truncate">
                      {Object.keys(entry.details).length > 0
                        ? JSON.stringify(entry.details)
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
                {data?.entries.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      No audit entries found
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {data && data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{data.pagination.total} entries total</p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">Page {page} of {data.pagination.totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= data.pagination.totalPages} onClick={() => setPage(page + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 3: Verify app compiles**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add packages/server/src/app/api/admin/audit/ packages/server/src/app/(dashboard)/admin/audit/
git commit -m "feat(admin): add audit log API and page"
```

---

## Task 12: Admin Settings Page (migrate LLM from Settings)

**Files:**
- Create: `packages/server/src/app/(dashboard)/admin/settings/page.tsx`
- Modify: `packages/server/src/app/(dashboard)/settings/page.tsx`
- Modify: `packages/server/src/app/api/admin/llm-settings/route.ts`
- Modify: `packages/server/src/app/api/cache/route.ts`

**Step 1: Create admin settings page**

Create `packages/server/src/app/(dashboard)/admin/settings/page.tsx` by extracting the LLM settings section from the current Settings page. This page will be a client component that includes:
- LLM Provider selection (Ollama/OpenRouter)
- Ollama URL + model config
- OpenRouter API key, model picker, provider routing, pricing
- Save button

Copy the LLM-related state, effects, handlers, and JSX from `packages/server/src/app/(dashboard)/settings/page.tsx` (the `LlmSettings` interface, `OpenRouterModel` interface, all `llm*` state, `useEffect` blocks for loading LLM settings and OpenRouter models, `handleLlmSave`, and the Card JSX block from line ~398 to ~726).

Remove the `isAdmin` check wrapping — the entire page is already admin-guarded by the layout.

**Step 2: Remove LLM section from Settings page**

In `packages/server/src/app/(dashboard)/settings/page.tsx`:
- Remove the `LlmSettings` interface, `OpenRouterModel` interface
- Remove `isAdmin` const and session query (if only used for admin check)
- Remove all `llm*` state variables
- Remove the `useEffect` blocks for LLM settings and OpenRouter models
- Remove `handleLlmSave` function
- Remove the `{isAdmin && (` Card block for LLM Provider
- Remove the `{isAdmin && (` block for cache clear buttons (keep cache stats display for all users)
- Clean up unused imports

**Step 3: Add audit logging to LLM settings save**

In `packages/server/src/app/api/admin/llm-settings/route.ts`, add audit log to the PATCH handler:

```typescript
import { auditLog } from '@/lib/audit';
```

After successful upsert (line ~148), before returning:
```typescript
await auditLog({
  userId: result.user.id,
  action: 'admin.settings.update',
  targetType: 'SystemSettings',
  targetId: 'singleton',
  details: data,
});
```

**Step 4: Add audit logging to cache clear**

In `packages/server/src/app/api/cache/route.ts`, add audit log to the DELETE handler:

```typescript
import { auditLog } from '@/lib/audit';
```

After clearing, before returning:
```typescript
await auditLog({
  userId: session.user.id,
  action: 'admin.cache.clear',
  targetType: 'SystemSettings',
  details: { level, freedMb: Math.round(freedBytes / 1024 / 1024 * 10) / 10 },
});
```

**Step 5: Verify app compiles**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds.

**Step 6: Commit**

```bash
git add packages/server/src/app/(dashboard)/admin/settings/ packages/server/src/app/(dashboard)/settings/page.tsx packages/server/src/app/api/admin/llm-settings/route.ts packages/server/src/app/api/cache/route.ts
git commit -m "feat(admin): migrate LLM settings to admin panel, add audit logging"
```

---

## Task 13: Run Tests + Final Build

**Step 1: Run all tests**

Run: `cd packages/server && pnpm test`
Expected: All tests pass.

**Step 2: Full production build**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds with no errors.

**Step 3: Fix any issues found**

Address any test failures or build errors.

**Step 4: Final commit (if fixes needed)**

```bash
git add -A
git commit -m "fix(admin): address build/test issues"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Schema changes | prisma/schema.prisma |
| 2 | Audit log utility | lib/audit.ts + test |
| 3 | Auth events + blocked enforcement + JWT role refresh | lib/auth.ts, api-utils.ts, register/route.ts |
| 4 | Admin layout guard + middleware | admin/layout.tsx, middleware.ts, auth.config.ts |
| 5 | Admin sidebar section | components/layout/sidebar.tsx |
| 6 | Stats API + Overview page | api/admin/stats, admin/page.tsx |
| 7 | User management API (with last-admin protection) | api/admin/users/* |
| 7b | Make getOrderWithAuth admin-aware | lib/api-utils.ts |
| 8 | User management page | admin/users/page.tsx |
| 9 | Orders API + page | api/admin/orders/*, admin/orders/page.tsx |
| 10 | Monitoring API + page | api/admin/monitoring, admin/monitoring/page.tsx |
| 11 | Audit log API + page | api/admin/audit, admin/audit/page.tsx |
| 12 | Admin settings (migrate LLM) | admin/settings/page.tsx, settings/page.tsx |
| 13 | Tests + final build | — |

## Review Findings Addressed

| Finding | Severity | Fix |
|---------|----------|-----|
| Last-admin lockout | High | `count(ADMIN) > 1` check in PATCH/DELETE user (Task 7) |
| Edit orders not in API | High | `getOrderWithAuth` admin-aware — skips ownership for ADMIN (Task 7b) |
| Blocked user active sessions | High | `getUserSession()` checks `isBlocked` on every API call (Task 3) |
| Stale JWT role | High | `jwt` callback always refreshes role from DB (Task 3) |
| Audit "after success" contradiction | Medium | Clarified: auth failure events logged in authorize callback (design doc) |
| Reset password security | Medium | Temp password in UI, pragmatic for single-tenant. Forced-change deferred (YAGNI) |
