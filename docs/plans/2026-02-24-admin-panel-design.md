# Admin Panel Design

**Date**: 2026-02-24
**Status**: Approved

## Context

DevGhost currently has minimal admin functionality: LLM settings, cache clearing, and OpenRouter model listing — all embedded in the shared Settings page. There's no user management, no visibility into other users' orders, no monitoring, and no audit trail.

**Deployment**: Single-tenant, one admin, 20+ users.

## Requirements

1. **User management** — list, role change, block/unblock, delete, password reset
2. **All orders visibility** — view, re-run analysis, edit, delete any user's orders
3. **System monitoring** — active jobs, cache stats, recent errors
4. **Audit log** — admin actions + auth events (login/logout/register/failed)
5. **System settings** — LLM provider config (migrate from Settings page)

## Architecture: Route Group in `(dashboard)`

### File Structure

```
src/app/(dashboard)/admin/
  ├── layout.tsx              # AdminGuard — checks role, redirects if USER
  ├── page.tsx                # Overview dashboard
  ├── users/page.tsx          # User management
  ├── orders/page.tsx         # All orders
  ├── monitoring/page.tsx     # Jobs, cache, errors
  ├── audit/page.tsx          # Audit log
  └── settings/page.tsx       # LLM and system settings
```

Admin section appears in the sidebar only for `role === 'ADMIN'`.

### Navigation (Sidebar)

```
─── Dashboard
─── Orders
    ├── Order 1
    └── Order 2
─── ──────────
─── Admin                  // ADMIN only
    ├── Overview
    ├── Users
    ├── All Orders
    ├── Monitoring
    ├── Audit Log
    └── Settings
─── ──────────
─── Settings               // User profile settings (remains for all)
─── Sign out
```

## Data Model Changes

### User — new fields

```prisma
model User {
  // ... existing fields
  isBlocked    Boolean  @default(false)
  blockedAt    DateTime?
  lastLoginAt  DateTime?
}
```

### AuditLog — new model

```prisma
model AuditLog {
  id         String   @id @default(cuid())
  userId     String?
  user       User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  action     String               // e.g. "auth.login", "admin.user.block"
  targetType String?              // "User", "Order", "SystemSettings"
  targetId   String?
  details    Json     @default("{}")
  createdAt  DateTime @default(now())

  @@index([userId])
  @@index([action])
  @@index([createdAt])
}
```

## Authorization

- `admin/layout.tsx` — Server Component, checks `session.user.role === 'ADMIN'`, redirects to `/dashboard` otherwise
- `middleware.ts` — add `/admin/*` route check (role from JWT)
- API: all `/api/admin/*` routes use `requireAdmin()`
- Blocked users (`isBlocked=true`) — rejected at two layers:
  1. `authorize` callback — prevents new logins
  2. `getUserSession()` — checks `isBlocked` on every API call, immediately rejects blocked users even with valid JWT
- JWT role staleness mitigation: `jwt` callback always refreshes `role` from DB (not only when missing), so role changes propagate on next token refresh

### Safety Invariants

- **No self-modification**: admin cannot change own role, block, or delete themselves
- **Last-admin protection**: role demotion and deletion require `count(ADMIN) > 1` — prevents system lockout
- **Admin-aware order access**: `getOrderWithAuth()` skips ownership check when caller is ADMIN, enabling full order management through existing endpoints

## API Routes

All under `/api/admin/`, all require `requireAdmin()`:

```
GET    /api/admin/stats                      — Overview stats
GET    /api/admin/users                      — List users (pagination, search)
PATCH  /api/admin/users/[id]                 — Update user (role, isBlocked)
DELETE /api/admin/users/[id]                 — Delete user (cascade)
POST   /api/admin/users/[id]/reset-password  — Generate temp password
GET    /api/admin/orders                     — All orders (pagination, filters)
DELETE /api/admin/orders/[id]                — Delete order
POST   /api/admin/orders/[id]/rerun          — Re-trigger analysis
GET    /api/admin/monitoring                 — Jobs, cache, recent errors
GET    /api/admin/audit                      — Audit log (pagination, filters)
GET    /api/admin/llm-settings               — (existing, reuse)
PATCH  /api/admin/llm-settings               — (existing, reuse)
GET    /api/admin/openrouter-models          — (existing, reuse)
```

## Pages Detail

### `/admin` — Overview

- User stats: total / active / blocked
- Order stats: total / in progress / completed / failed
- Last 10 audit log entries
- LLM provider status (Ollama/OpenRouter, reachability)

### `/admin/users` — User Management

- Table with pagination: email, name, role, createdAt, lastLoginAt, isBlocked
- Search by email/name
- Actions per row: change role (USER/ADMIN), block/unblock, delete (confirmation dialog), reset password

### `/admin/orders` — All Orders

- Table: name, owner email, status, repo count, createdAt
- Filters: by status, by user
- Actions: view (navigate to standard order page), edit (same page, admin bypasses ownership), re-run analysis, delete

### `/admin/monitoring` — System Monitoring

- Active analysis jobs (from AnalysisJob table)
- Pipeline cache stats + clear buttons (migrated from Settings)
- Recent failed orders/jobs with error messages

### `/admin/audit` — Audit Log

- Table: timestamp, user (email), action, target, details
- Filters: by action category, by user, by date range
- Pagination

### `/admin/settings` — System Settings

- LLM provider configuration (migrated from Settings page)
- Future: rates, regions

## Audit Log Events

### Auth events (all users)

| Action | Details |
|---|---|
| `auth.login` | userId, ip |
| `auth.logout` | userId |
| `auth.register` | userId, email |
| `auth.login_failed` | email, ip, reason |
| `auth.blocked_attempt` | email, ip |

### Admin events

| Action | Details |
|---|---|
| `admin.user.role_change` | targetId, oldRole, newRole |
| `admin.user.block` | targetId, reason |
| `admin.user.unblock` | targetId |
| `admin.user.delete` | targetId, email |
| `admin.user.reset_password` | targetId |
| `admin.order.delete` | targetId, ownerEmail, orderName |
| `admin.order.rerun` | targetId |
| `admin.settings.update` | changed fields |
| `admin.cache.clear` | level (all/repos/diffs/llm), freedMb |

## Audit Utility

```typescript
// lib/audit.ts
export async function auditLog(params: {
  userId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}): Promise<void>
```

Called in API routes after actions (both success and failure where security-relevant). Admin events are logged after successful mutation. Auth events cover both success (`auth.login`, `auth.register`) and failure (`auth.login_failed`, `auth.blocked_attempt`) — the latter are logged in NextAuth `authorize` callback before returning null.

## Migration Notes

- LLM settings section removed from `/settings` page (moved to `/admin/settings`)
- Cache clear buttons removed from `/settings` (moved to `/admin/monitoring`)
- Cache stats read (GET /api/cache) remains accessible to all users on Settings page
- Existing `/api/admin/llm-settings` and `/api/admin/openrouter-models` routes reused as-is
