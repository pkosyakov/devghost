# Contributor Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce canonical contributor identity (Workspace, Contributor, ContributorAlias) as a first-class domain layer with People UI, replacing dependency on per-order developer blobs for people-facing analytics.

**Architecture:** New Prisma models (Workspace 1:1 User, Contributor, ContributorAlias, CurationAuditLog) with idempotent projection from legacy Order data. v2 API namespace (`/api/v2/contributors/`) with read/write endpoints. Client-first People List and Contributor Detail pages. Best-effort integration hook in analysis worker.

**Tech Stack:** Prisma 6.19, Next.js App Router, Zod, TanStack Query, next-intl, shadcn/ui, Tailwind CSS, vitest

**Spec:** `docs/superpowers/specs/2026-03-29-contributor-foundation-design.md`

---

## File Structure

### New files

```
packages/server/
├── prisma/
│   └── migrations/YYYYMMDD_contributor_foundation/  (created by `pnpm db:migrate`)
├── scripts/
│   └── backfill-contributors.ts
├── src/
│   ├── lib/
│   │   ├── schemas/
│   │   │   └── contributor.ts          — Zod validation schemas for all v2 endpoints
│   │   └── services/
│   │       ├── workspace-service.ts    — ensureWorkspaceForUser()
│   │       └── contributor-identity.ts — projection, auto-merge, identity health computation
│   ├── app/
│   │   ├── api/v2/contributors/
│   │   │   ├── route.ts                         — GET list
│   │   │   ├── merge/route.ts                   — POST merge
│   │   │   ├── unmerge/route.ts                 — POST unmerge
│   │   │   ├── identity-queue/route.ts          — GET identity queue
│   │   │   ├── [id]/
│   │   │   │   ├── route.ts                     — GET detail
│   │   │   │   ├── commits/route.ts             — GET paginated commits
│   │   │   │   ├── exclude/route.ts             — POST exclude
│   │   │   │   ├── include/route.ts             — POST include
│   │   │   │   └── classify/route.ts            — POST classify
│   │   │   └── aliases/[aliasId]/
│   │   │       ├── classify/route.ts            — POST alias classify
│   │   │       └── resolve/route.ts             — POST alias resolve
│   │   └── [locale]/(dashboard)/people/
│   │       ├── page.tsx                          — People List page
│   │       ├── components/
│   │       │   ├── people-summary-strip.tsx
│   │       │   ├── people-filters.tsx
│   │       │   ├── people-identity-queue.tsx
│   │       │   ├── people-table.tsx
│   │       │   ├── people-table-row.tsx
│   │       │   └── identity-health-badge.tsx
│   │       └── [id]/
│   │           ├── page.tsx                      — Contributor Detail page
│   │           └── components/
│   │               ├── contributor-header.tsx
│   │               ├── contributor-kpi-summary.tsx
│   │               ├── contributor-aliases-panel.tsx
│   │               ├── contributor-repo-breakdown.tsx
│   │               ├── contributor-commit-evidence.tsx
│   │               └── contributor-merge-modal.tsx
```

### Modified files

```
packages/server/
├── prisma/schema.prisma                           — add 4 models + 3 enums + User relations
├── middleware.ts                                   — add '/people' to PROTECTED_PREFIXES
├── messages/en.json                               — add people.* and contributorDetail.* keys
├── messages/ru.json                               — add people.* and contributorDetail.* keys
├── src/
│   ├── components/layout/sidebar.tsx              — add People nav item
│   ├── lib/services/analysis-worker.ts            — add best-effort projection hook
│   └── app/api/auth/register/route.ts             — add best-effort workspace creation
```

---

## Task 1: Schema — Add Prisma Models

**Files:**
- Modify: `packages/server/prisma/schema.prisma`

This task adds the 4 new models, 3 new enums, and User relation changes. No tests — schema correctness is validated by `db:migrate`.

- [ ] **Step 1: Add enums to schema.prisma**

Add after existing enums (after `enum OrderStatus`):

```prisma
enum ContributorClassification {
  INTERNAL
  EXTERNAL
  BOT
  FORMER_EMPLOYEE
}

enum AliasResolveStatus {
  AUTO_MERGED
  MANUAL
  SUGGESTED
  UNRESOLVED
}

enum CurationAction {
  MERGE
  UNMERGE
  EXCLUDE
  INCLUDE
  CLASSIFY
}
```

- [ ] **Step 2: Add Workspace model**

Add after the User model:

```prisma
model Workspace {
  id           String              @id @default(cuid())
  name         String              @default("My Workspace")
  ownerId      String              @unique
  owner        User                @relation(fields: [ownerId], references: [id], onDelete: Cascade)

  contributors Contributor[]
  aliases      ContributorAlias[]
  auditLogs    CurationAuditLog[]

  createdAt    DateTime            @default(now())
  updatedAt    DateTime            @updatedAt
}
```

- [ ] **Step 3: Add Contributor model**

```prisma
model Contributor {
  id             String                      @id @default(cuid())
  workspaceId    String
  workspace      Workspace                   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  displayName    String
  primaryEmail   String
  classification ContributorClassification   @default(INTERNAL)
  isExcluded     Boolean                     @default(false)
  excludedAt     DateTime?

  aliases        ContributorAlias[]
  auditLogs      CurationAuditLog[]

  createdAt      DateTime                    @default(now())
  updatedAt      DateTime                    @updatedAt

  @@unique([workspaceId, primaryEmail])
  @@index([workspaceId])
}
```

- [ ] **Step 4: Add ContributorAlias model**

```prisma
model ContributorAlias {
  id                 String                      @id @default(cuid())
  workspaceId        String
  workspace          Workspace                   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  contributorId      String?
  contributor        Contributor?                @relation(fields: [contributorId], references: [id], onDelete: SetNull)

  providerType       String                      @default("github")
  providerId         String?
  email              String
  username           String?

  resolveStatus      AliasResolveStatus          @default(UNRESOLVED)
  mergeReason        String?
  confidence         Float                       @default(0)
  classificationHint ContributorClassification?
  lastSeenAt         DateTime?
  createdAt          DateTime                    @default(now())
  updatedAt          DateTime                    @updatedAt

  @@unique([workspaceId, providerType, email])
  @@unique([workspaceId, providerType, providerId])
  @@index([contributorId])
  @@index([resolveStatus])
  @@index([workspaceId])
}
```

- [ ] **Step 5: Add CurationAuditLog model**

```prisma
model CurationAuditLog {
  id                String       @id @default(cuid())
  workspaceId       String
  workspace         Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  contributorId     String?
  contributor       Contributor? @relation(fields: [contributorId], references: [id], onDelete: SetNull)

  aliasId           String?
  action            CurationAction
  payload           Json         @default("{}")
  performedByUserId String
  performedByUser   User         @relation(fields: [performedByUserId], references: [id], onDelete: Cascade)
  createdAt         DateTime     @default(now())

  @@index([workspaceId])
  @@index([contributorId])
  @@index([aliasId])
}
```

- [ ] **Step 6: Add reverse relations to User model**

In the User model's relations section (after existing relations like `developerProfile`, `comments`, etc.), add:

```prisma
  workspace            Workspace?
  curationAuditLogs    CurationAuditLog[]
```

- [ ] **Step 7: Create migration and generate Prisma client**

Run:
```bash
cd packages/server && pnpm db:migrate --name contributor_foundation
```

This creates a migration file in `prisma/migrations/` AND generates the Prisma client. Verify the generated SQL contains `CREATE TABLE "Workspace"`, `"Contributor"`, `"ContributorAlias"`, `"CurationAuditLog"`, and the three enums.

Expected: Migration applied successfully. No errors.

- [ ] **Step 8: Commit**

```bash
git add packages/server/prisma/schema.prisma packages/server/prisma/migrations/
git commit -m "feat(schema): add Workspace, Contributor, ContributorAlias, CurationAuditLog models"
```

---

## Task 2: Workspace Service

**Files:**
- Create: `packages/server/src/lib/services/workspace-service.ts`
- Test: `packages/server/src/lib/services/workspace-service.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/lib/services/workspace-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma
const mockPrisma = {
  workspace: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
};

vi.mock('@/lib/db', () => ({
  prisma: mockPrisma,
}));

import { ensureWorkspaceForUser } from './workspace-service';

describe('ensureWorkspaceForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns existing workspace if found', async () => {
    const existing = { id: 'ws-1', ownerId: 'user-1', name: 'My Workspace' };
    mockPrisma.workspace.findUnique.mockResolvedValue(existing);

    const result = await ensureWorkspaceForUser('user-1');

    expect(result).toEqual(existing);
    expect(mockPrisma.workspace.create).not.toHaveBeenCalled();
  });

  it('creates new workspace if none exists', async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(null);
    const created = { id: 'ws-2', ownerId: 'user-2', name: 'My Workspace' };
    mockPrisma.workspace.create.mockResolvedValue(created);

    const result = await ensureWorkspaceForUser('user-2');

    expect(result).toEqual(created);
    expect(mockPrisma.workspace.create).toHaveBeenCalledWith({
      data: { ownerId: 'user-2' },
    });
  });

  it('handles race condition (unique constraint) by re-fetching', async () => {
    mockPrisma.workspace.findUnique.mockResolvedValueOnce(null);
    const prismaError = new Error('Unique constraint failed');
    (prismaError as any).code = 'P2002';
    mockPrisma.workspace.create.mockRejectedValue(prismaError);
    const existing = { id: 'ws-3', ownerId: 'user-3', name: 'My Workspace' };
    mockPrisma.workspace.findUnique.mockResolvedValueOnce(existing);

    const result = await ensureWorkspaceForUser('user-3');

    expect(result).toEqual(existing);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/server && pnpm test -- src/lib/services/workspace-service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `packages/server/src/lib/services/workspace-service.ts`:

```typescript
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { Workspace } from '@prisma/client';

const log = logger.child({ service: 'workspace' });

/**
 * Ensures a Workspace exists for the given user. Idempotent.
 * Returns the existing or newly created Workspace.
 */
export async function ensureWorkspaceForUser(userId: string): Promise<Workspace> {
  const existing = await prisma.workspace.findUnique({
    where: { ownerId: userId },
  });

  if (existing) {
    return existing;
  }

  try {
    const workspace = await prisma.workspace.create({
      data: { ownerId: userId },
    });
    log.info({ workspaceId: workspace.id, userId }, 'Workspace created');
    return workspace;
  } catch (err: any) {
    // Race condition: another process created the workspace
    if (err?.code === 'P2002') {
      const raced = await prisma.workspace.findUnique({
        where: { ownerId: userId },
      });
      if (raced) return raced;
    }
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/server && pnpm test -- src/lib/services/workspace-service.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/lib/services/workspace-service.ts packages/server/src/lib/services/workspace-service.test.ts
git commit -m "feat: add ensureWorkspaceForUser service with race condition handling"
```

---

## Task 3: Contributor Identity Projection Service

**Files:**
- Create: `packages/server/src/lib/services/contributor-identity.ts`
- Test: `packages/server/src/lib/services/contributor-identity.test.ts`

This is the core domain service. It extracts developer data from Orders and projects them into Contributor/ContributorAlias records.

- [ ] **Step 1: Write tests for extractAliasesFromOrder**

Create `packages/server/src/lib/services/contributor-identity.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = {
  order: { findUnique: vi.fn() },
  workspace: { findUnique: vi.fn() },
  contributor: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    upsert: vi.fn(),
  },
  contributorAlias: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn((fn: any) => fn(mockPrisma)),
};

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  analysisLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('./workspace-service', () => ({
  ensureWorkspaceForUser: vi.fn().mockResolvedValue({ id: 'ws-1', ownerId: 'user-1' }),
}));

import { extractAliasesFromOrder, resolveIdentities, computeIdentityHealth } from './contributor-identity';

describe('extractAliasesFromOrder', () => {
  it('extracts seed aliases from selectedDevelopers', () => {
    const order = {
      selectedDevelopers: [
        { name: 'John Doe', email: 'john@example.com', login: 'johndoe' },
        { name: 'Jane Smith', email: 'jane@corp.com' },
      ],
      developerMapping: {},
    };

    const aliases = extractAliasesFromOrder(order as any);

    expect(aliases).toHaveLength(2);
    expect(aliases[0]).toMatchObject({
      email: 'john@example.com',
      displayName: 'John Doe',
      username: 'johndoe',
      providerType: 'github',
    });
    expect(aliases[1]).toMatchObject({
      email: 'jane@corp.com',
      displayName: 'Jane Smith',
      username: undefined,
    });
  });

  it('extracts additional alias hints from developerMapping', () => {
    const order = {
      selectedDevelopers: [
        { name: 'John Doe', email: 'john@example.com', login: 'johndoe' },
      ],
      developerMapping: {
        'john@example.com': {
          primary: { name: 'John Doe', email: 'john@example.com' },
          merged_from: [
            { name: 'J. Doe', email: 'jdoe@old.com' },
          ],
        },
      },
    };

    const aliases = extractAliasesFromOrder(order as any);

    expect(aliases.length).toBeGreaterThanOrEqual(2);
    const emails = aliases.map((a: any) => a.email);
    expect(emails).toContain('john@example.com');
    expect(emails).toContain('jdoe@old.com');
  });

  it('deduplicates aliases by email', () => {
    const order = {
      selectedDevelopers: [
        { name: 'John Doe', email: 'john@example.com' },
      ],
      developerMapping: {
        'john@example.com': {
          primary: { name: 'John Doe', email: 'john@example.com' },
          merged_from: [],
        },
      },
    };

    const aliases = extractAliasesFromOrder(order as any);

    const emailCounts = aliases.filter((a: any) => a.email === 'john@example.com');
    expect(emailCounts).toHaveLength(1);
  });
});

describe('computeIdentityHealth', () => {
  it('returns healthy when all aliases resolved', () => {
    const result = computeIdentityHealth({ resolvedCount: 3, unresolvedCount: 0 });
    expect(result).toEqual({ status: 'healthy', unresolvedAliasCount: 0 });
  });

  it('returns attention when some aliases unresolved', () => {
    const result = computeIdentityHealth({ resolvedCount: 2, unresolvedCount: 1 });
    expect(result).toEqual({ status: 'attention', unresolvedAliasCount: 1 });
  });

  it('returns unresolved when no aliases resolved', () => {
    const result = computeIdentityHealth({ resolvedCount: 0, unresolvedCount: 2 });
    expect(result).toEqual({ status: 'unresolved', unresolvedAliasCount: 2 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test -- src/lib/services/contributor-identity.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/lib/services/contributor-identity.ts`:

```typescript
import { prisma } from '@/lib/db';
import { analysisLogger } from '@/lib/logger';
import { ensureWorkspaceForUser } from './workspace-service';
import type { Order, Contributor, ContributorAlias, AliasResolveStatus } from '@prisma/client';

const log = analysisLogger.child({ service: 'contributor-identity' });

// ─── Types ───

interface RawAlias {
  email: string;
  displayName: string;
  username?: string;
  providerId?: string;
  providerType: string;
}

type IdentityHealthStatus = 'healthy' | 'attention' | 'unresolved';

interface IdentityHealth {
  status: IdentityHealthStatus;
  unresolvedAliasCount: number;
}

// ─── Extract aliases from Order data ───

export function extractAliasesFromOrder(order: {
  selectedDevelopers: any;
  developerMapping: any;
}): RawAlias[] {
  const seen = new Map<string, RawAlias>();
  const developers: any[] = Array.isArray(order.selectedDevelopers)
    ? order.selectedDevelopers
    : [];

  // Seed identities from selectedDevelopers
  for (const dev of developers) {
    const email = (dev.email || '').toLowerCase().trim();
    if (!email) continue;
    seen.set(email, {
      email,
      displayName: dev.name || dev.login || email,
      username: dev.login || dev.username || undefined,
      providerId: dev.id?.toString() || undefined,
      providerType: 'github',
    });
  }

  // Additional alias hints from developerMapping
  const mapping = order.developerMapping || {};
  for (const key of Object.keys(mapping)) {
    const group = mapping[key];
    if (!group) continue;

    // Primary
    if (group.primary?.email) {
      const email = group.primary.email.toLowerCase().trim();
      if (!seen.has(email)) {
        seen.set(email, {
          email,
          displayName: group.primary.name || email,
          username: group.primary.login || group.primary.username || undefined,
          providerId: group.primary.id?.toString() || undefined,
          providerType: 'github',
        });
      }
    }

    // Merged-from aliases (hints only)
    const mergedFrom: any[] = Array.isArray(group.merged_from) ? group.merged_from : [];
    for (const alias of mergedFrom) {
      const email = (alias.email || '').toLowerCase().trim();
      if (!email || seen.has(email)) continue;
      seen.set(email, {
        email,
        displayName: alias.name || alias.login || email,
        username: alias.login || alias.username || undefined,
        providerId: alias.id?.toString() || undefined,
        providerType: 'github',
      });
    }
  }

  return Array.from(seen.values());
}

// ─── Identity health computation ───

export function computeIdentityHealth(counts: {
  resolvedCount: number;
  unresolvedCount: number;
}): IdentityHealth {
  const { resolvedCount, unresolvedCount } = counts;
  let status: IdentityHealthStatus;

  if (unresolvedCount === 0) {
    status = 'healthy';
  } else if (resolvedCount > 0) {
    status = 'attention';
  } else {
    status = 'unresolved';
  }

  return { status, unresolvedAliasCount: unresolvedCount };
}

// ─── Auto-merge rules ───

/**
 * Try to find an existing Contributor for a raw alias.
 * Priority: 1) exact providerId match, 2) exact email match.
 * Returns null if no match (alias stays UNRESOLVED).
 */
async function findContributorMatch(
  workspaceId: string,
  raw: RawAlias
): Promise<Contributor | null> {
  // Rule 1: Exact provider ID match
  if (raw.providerId) {
    const aliasMatch = await prisma.contributorAlias.findFirst({
      where: {
        workspaceId,
        providerType: raw.providerType,
        providerId: raw.providerId,
        contributorId: { not: null },
      },
      include: { contributor: true },
    });
    if (aliasMatch?.contributor) {
      return aliasMatch.contributor;
    }
  }

  // Rule 2: Exact email match
  const contributor = await prisma.contributor.findFirst({
    where: {
      workspaceId,
      primaryEmail: raw.email,
    },
  });
  if (contributor) {
    return contributor;
  }

  return null;
}

// ─── Project contributors from a single order ───

export async function projectContributorsFromOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      selectedDevelopers: true,
      developerMapping: true,
    },
  });

  if (!order) {
    log.warn({ orderId }, 'Order not found for projection');
    return;
  }

  const workspace = await ensureWorkspaceForUser(order.userId);
  const rawAliases = extractAliasesFromOrder(order);

  if (rawAliases.length === 0) {
    log.debug({ orderId }, 'No aliases to project');
    return;
  }

  for (const raw of rawAliases) {
    // Upsert alias record
    const existingAlias = await prisma.contributorAlias.findFirst({
      where: {
        workspaceId: workspace.id,
        providerType: raw.providerType,
        email: raw.email,
      },
    });

    if (existingAlias) {
      // Manual resolution is authoritative — don't reassign
      if (existingAlias.resolveStatus === 'MANUAL') {
        await prisma.contributorAlias.update({
          where: { id: existingAlias.id },
          data: {
            lastSeenAt: new Date(),
            username: raw.username || existingAlias.username,
          },
        });
        continue;
      }

      // Update signals for non-manual aliases
      const updateData: any = {
        lastSeenAt: new Date(),
        username: raw.username || existingAlias.username,
      };

      if (raw.providerId && !existingAlias.providerId) {
        updateData.providerId = raw.providerId;
      }

      // If already resolved (AUTO_MERGED), just update signals
      if (existingAlias.contributorId) {
        await prisma.contributorAlias.update({
          where: { id: existingAlias.id },
          data: updateData,
        });
        continue;
      }

      // Unresolved alias — try to resolve
      const match = await findContributorMatch(workspace.id, raw);
      if (match) {
        await prisma.contributorAlias.update({
          where: { id: existingAlias.id },
          data: {
            ...updateData,
            contributorId: match.id,
            resolveStatus: 'AUTO_MERGED',
            mergeReason: raw.providerId ? 'exact_provider_match' : 'exact_email_match',
            confidence: 1.0,
          },
        });
      } else {
        await prisma.contributorAlias.update({
          where: { id: existingAlias.id },
          data: updateData,
        });
      }
    } else {
      // New alias — try to find or create contributor
      const match = await findContributorMatch(workspace.id, raw);

      if (match) {
        // Attach to existing contributor
        await prisma.contributorAlias.create({
          data: {
            workspaceId: workspace.id,
            contributorId: match.id,
            providerType: raw.providerType,
            providerId: raw.providerId || null,
            email: raw.email,
            username: raw.username || null,
            resolveStatus: 'AUTO_MERGED',
            mergeReason: raw.providerId ? 'exact_provider_match' : 'exact_email_match',
            confidence: 1.0,
            lastSeenAt: new Date(),
          },
        });
      } else {
        // Bootstrap: create new Contributor + primary alias
        const contributor = await prisma.contributor.create({
          data: {
            workspaceId: workspace.id,
            displayName: raw.displayName,
            primaryEmail: raw.email,
          },
        });

        await prisma.contributorAlias.create({
          data: {
            workspaceId: workspace.id,
            contributorId: contributor.id,
            providerType: raw.providerType,
            providerId: raw.providerId || null,
            email: raw.email,
            username: raw.username || null,
            resolveStatus: 'AUTO_MERGED',
            mergeReason: 'exact_email_match',
            confidence: 1.0,
            lastSeenAt: new Date(),
          },
        });

        log.info(
          { contributorId: contributor.id, email: raw.email, orderId },
          'New contributor created'
        );
      }
    }
  }

  log.info({ orderId, aliasCount: rawAliases.length }, 'Contributor projection complete');
}

// ─── Backfill all completed orders ───

export async function backfillAllOrders(): Promise<{ usersProcessed: number; ordersProcessed: number }> {
  const users = await prisma.user.findMany({
    where: {
      orders: { some: { status: 'COMPLETED' } },
    },
    select: { id: true },
  });

  let ordersProcessed = 0;

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    log.info({ userId: user.id, progress: `${i + 1}/${users.length}` }, 'Processing user');

    await ensureWorkspaceForUser(user.id);

    const orders = await prisma.order.findMany({
      where: { userId: user.id, status: 'COMPLETED' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });

    for (let j = 0; j < orders.length; j++) {
      log.info(
        { orderId: orders[j].id, progress: `order ${j + 1}/${orders.length}` },
        'Projecting order'
      );
      await projectContributorsFromOrder(orders[j].id);
      ordersProcessed++;
    }
  }

  return { usersProcessed: users.length, ordersProcessed };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/server && pnpm test -- src/lib/services/contributor-identity.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/lib/services/contributor-identity.ts packages/server/src/lib/services/contributor-identity.test.ts
git commit -m "feat: add contributor identity projection service with auto-merge rules"
```

---

## Task 4: Zod Validation Schemas

**Files:**
- Create: `packages/server/src/lib/schemas/contributor.ts`

- [ ] **Step 1: Create Zod schemas for all v2 endpoints**

Create `packages/server/src/lib/schemas/contributor.ts`:

```typescript
import { z } from 'zod';

// ─── Enums ───

export const contributorClassificationEnum = z.enum([
  'INTERNAL',
  'EXTERNAL',
  'BOT',
  'FORMER_EMPLOYEE',
]);

export const identityHealthEnum = z.enum(['healthy', 'attention', 'unresolved']);

// ─── Query schemas ───

export const contributorListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  sort: z.enum(['displayName', 'primaryEmail', 'lastActivityAt', 'activeRepositoryCount']).default('displayName'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  classification: z.string().optional(), // comma-separated: "INTERNAL,EXTERNAL"
  identityHealth: identityHealthEnum.optional(),
  search: z.string().optional(),
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

// ─── Body schemas ───

export const mergeBodySchema = z.object({
  fromContributorId: z.string().min(1),
  toContributorId: z.string().min(1),
}).refine((data) => data.fromContributorId !== data.toContributorId, {
  message: 'Cannot merge a contributor into itself',
});

export const unmergeBodySchema = z.object({
  contributorId: z.string().min(1),
  aliasIds: z.array(z.string().min(1)).min(1),
});

export const excludeBodySchema = z.object({
  reason: z.string().optional(),
});

export const classifyContributorBodySchema = z.object({
  classification: contributorClassificationEnum,
});

export const classifyAliasBodySchema = z.object({
  classificationHint: contributorClassificationEnum,
});

export const resolveAliasBodySchema = z.object({
  contributorId: z.string().min(1),
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/lib/schemas/contributor.ts
git commit -m "feat: add Zod validation schemas for v2 contributor endpoints"
```

---

## Task 5: API — Read Endpoints

**Files:**
- Create: `packages/server/src/app/api/v2/contributors/route.ts`
- Create: `packages/server/src/app/api/v2/contributors/[id]/route.ts`
- Create: `packages/server/src/app/api/v2/contributors/[id]/commits/route.ts`
- Create: `packages/server/src/app/api/v2/contributors/identity-queue/route.ts`

- [ ] **Step 1: Create contributor list endpoint**

Create `packages/server/src/app/api/v2/contributors/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { computeIdentityHealth } from '@/lib/services/contributor-identity';
import { contributorListQuerySchema } from '@/lib/schemas/contributor';
import type { Prisma } from '@prisma/client';

export async function GET(request: NextRequest) {
  const sessionOrError = await requireUserSession();
  if (sessionOrError instanceof Response) return sessionOrError;
  const session = sessionOrError;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = contributorListQuerySchema.safeParse(params);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const { page, pageSize, sort, sortOrder, classification, identityHealth, search } = parsed.data;

  // Build where clause
  const where: Prisma.ContributorWhereInput = {
    workspaceId: workspace.id,
  };

  if (classification) {
    const values = classification.split(',').map((v) => v.trim());
    where.classification = { in: values as any[] };
  }

  if (search) {
    where.OR = [
      { displayName: { contains: search, mode: 'insensitive' } },
      { primaryEmail: { contains: search, mode: 'insensitive' } },
    ];
  }

  // Get total count
  const total = await prisma.contributor.count({ where });

  // Get contributors
  const contributors = await prisma.contributor.findMany({
    where,
    include: {
      aliases: {
        select: { id: true, resolveStatus: true },
      },
      _count: {
        select: { aliases: true },
      },
    },
    orderBy: sort === 'displayName'
      ? { displayName: sortOrder }
      : sort === 'primaryEmail'
        ? { primaryEmail: sortOrder }
        : { updatedAt: sortOrder }, // lastActivityAt approximated by updatedAt
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  // Compute identity health per contributor and apply filter
  const rows = contributors.map((c) => {
    const resolvedCount = c.aliases.filter(
      (a) => a.resolveStatus === 'AUTO_MERGED' || a.resolveStatus === 'MANUAL'
    ).length;
    const unresolvedCount = c.aliases.filter(
      (a) => a.resolveStatus === 'UNRESOLVED' || a.resolveStatus === 'SUGGESTED'
    ).length;
    const health = computeIdentityHealth({ resolvedCount, unresolvedCount });

    return {
      id: c.id,
      displayName: c.displayName,
      primaryEmail: c.primaryEmail,
      classification: c.classification,
      isExcluded: c.isExcluded,
      identityHealth: health,
      aliasCount: c._count.aliases,
      lastActivityAt: c.updatedAt,
    };
  });

  // Filter by identity health if specified (post-query since it's computed)
  const filtered = identityHealth
    ? rows.filter((r) => r.identityHealth.status === identityHealth)
    : rows;

  // Identity queue summary
  const unresolvedCount = await prisma.contributorAlias.count({
    where: { workspaceId: workspace.id, resolveStatus: 'UNRESOLVED' },
  });
  const suggestedCount = await prisma.contributorAlias.count({
    where: { workspaceId: workspace.id, resolveStatus: 'SUGGESTED' },
  });
  const excludedCount = await prisma.contributor.count({
    where: { workspaceId: workspace.id, isExcluded: true },
  });

  return apiResponse({
    contributors: filtered,
    pagination: {
      page,
      pageSize,
      total: identityHealth ? filtered.length : total,
      totalPages: Math.ceil((identityHealth ? filtered.length : total) / pageSize),
    },
    identityQueueSummary: { unresolvedCount, suggestedCount },
    totalContributors: total,
    excludedCount,
  });
}
```

- [ ] **Step 2: Create contributor detail endpoint**

Create `packages/server/src/app/api/v2/contributors/[id]/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { computeIdentityHealth } from '@/lib/services/contributor-identity';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sessionOrError = await requireUserSession();
  if (sessionOrError instanceof Response) return sessionOrError;
  const session = sessionOrError;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const contributor = await prisma.contributor.findFirst({
    where: { id, workspaceId: workspace.id },
    include: {
      aliases: {
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!contributor) {
    return apiError('Contributor not found', 404);
  }

  // Compute identity health
  const resolvedCount = contributor.aliases.filter(
    (a) => a.resolveStatus === 'AUTO_MERGED' || a.resolveStatus === 'MANUAL'
  ).length;
  const unresolvedCount = contributor.aliases.filter(
    (a) => a.resolveStatus === 'UNRESOLVED' || a.resolveStatus === 'SUGGESTED'
  ).length;
  const identityHealth = computeIdentityHealth({ resolvedCount, unresolvedCount });

  // Summary metrics from CommitAnalysis
  const aliasEmails = contributor.aliases.map((a) => a.email);
  const commitAnalyses = await prisma.commitAnalysis.findMany({
    where: {
      order: { userId: session.user.id },
      authorEmail: { in: aliasEmails },
    },
    select: {
      id: true,
      repoName: true,
      authoredAt: true,
      estimatedHours: true,
    },
  });

  // Repository breakdown
  const repoMap = new Map<string, { commitCount: number; lastActivityAt: Date }>();
  for (const ca of commitAnalyses) {
    const repo = ca.repoName || 'unknown';
    const existing = repoMap.get(repo);
    if (existing) {
      existing.commitCount++;
      if (ca.authoredAt && ca.authoredAt > existing.lastActivityAt) {
        existing.lastActivityAt = ca.authoredAt;
      }
    } else {
      repoMap.set(repo, {
        commitCount: 1,
        lastActivityAt: ca.authoredAt || new Date(0),
      });
    }
  }

  const repositoryBreakdown = Array.from(repoMap.entries())
    .map(([repoName, data]) => ({
      repoName,
      commitCount: data.commitCount,
      lastActivityAt: data.lastActivityAt,
    }))
    .sort((a, b) => b.commitCount - a.commitCount);

  // Potential matches: unresolved aliases with same email domain or from same orders
  const emailDomain = contributor.primaryEmail.split('@')[1];
  const potentialMatches = emailDomain
    ? await prisma.contributorAlias.findMany({
        where: {
          workspaceId: workspace.id,
          contributorId: null,
          resolveStatus: 'UNRESOLVED',
          email: { endsWith: `@${emailDomain}` },
        },
        select: {
          id: true,
          email: true,
          username: true,
          providerType: true,
          lastSeenAt: true,
        },
        take: 10,
      })
    : [];

  const lastActivity = commitAnalyses.reduce<Date | null>((latest, ca) => {
    if (!ca.authoredAt) return latest;
    return latest && latest > ca.authoredAt ? latest : ca.authoredAt;
  }, null);

  return apiResponse({
    contributor: {
      id: contributor.id,
      displayName: contributor.displayName,
      primaryEmail: contributor.primaryEmail,
      classification: contributor.classification,
      isExcluded: contributor.isExcluded,
      excludedAt: contributor.excludedAt,
    },
    aliases: contributor.aliases,
    summaryMetrics: {
      totalCommits: commitAnalyses.length,
      activeRepositoryCount: repoMap.size,
      lastActivityAt: lastActivity,
    },
    repositoryBreakdown,
    identityHealth,
    potentialMatches,
  });
}
```

- [ ] **Step 3: Create commits endpoint**

Create `packages/server/src/app/api/v2/contributors/[id]/commits/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { paginationQuerySchema } from '@/lib/schemas/contributor';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sessionOrError = await requireUserSession();
  if (sessionOrError instanceof Response) return sessionOrError;
  const session = sessionOrError;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  // Verify contributor belongs to workspace
  const contributor = await prisma.contributor.findFirst({
    where: { id, workspaceId: workspace.id },
    include: { aliases: { select: { email: true } } },
  });

  if (!contributor) {
    return apiError('Contributor not found', 404);
  }

  const queryParams = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = paginationQuerySchema.safeParse(queryParams);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const { page, pageSize } = parsed.data;
  const aliasEmails = contributor.aliases.map((a) => a.email);

  const [commits, total] = await Promise.all([
    prisma.commitAnalysis.findMany({
      where: {
        order: { userId: session.user.id },
        authorEmail: { in: aliasEmails },
      },
      select: {
        commitSha: true,
        commitMessage: true,
        repoName: true,
        authoredAt: true,
        estimatedHours: true,
      },
      orderBy: { authoredAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.commitAnalysis.count({
      where: {
        order: { userId: session.user.id },
        authorEmail: { in: aliasEmails },
      },
    }),
  ]);

  return apiResponse({
    commits: commits.map((c) => ({
      sha: c.commitSha,
      message: c.commitMessage,
      repo: c.repoName,
      authoredAt: c.authoredAt,
      effortHours: c.estimatedHours,
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
}
```

- [ ] **Step 4: Create identity queue endpoint**

Create `packages/server/src/app/api/v2/contributors/identity-queue/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { paginationQuerySchema } from '@/lib/schemas/contributor';

export async function GET(request: NextRequest) {
  const sessionOrError = await requireUserSession();
  if (sessionOrError instanceof Response) return sessionOrError;
  const session = sessionOrError;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const queryParams = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = paginationQuerySchema.safeParse(queryParams);
  const { page, pageSize } = parsed.success ? parsed.data : { page: 1, pageSize: 20 };

  const [aliases, total, unresolvedCount, suggestedCount] = await Promise.all([
    prisma.contributorAlias.findMany({
      where: {
        workspaceId: workspace.id,
        resolveStatus: { in: ['UNRESOLVED', 'SUGGESTED'] },
      },
      orderBy: { lastSeenAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.contributorAlias.count({
      where: {
        workspaceId: workspace.id,
        resolveStatus: { in: ['UNRESOLVED', 'SUGGESTED'] },
      },
    }),
    prisma.contributorAlias.count({
      where: { workspaceId: workspace.id, resolveStatus: 'UNRESOLVED' },
    }),
    prisma.contributorAlias.count({
      where: { workspaceId: workspace.id, resolveStatus: 'SUGGESTED' },
    }),
  ]);

  return apiResponse({
    aliases: aliases.map((alias) => ({
      alias,
      suggestedContributor: null, // No fuzzy suggestions in slice 1
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
    summary: { unresolvedCount, suggestedCount },
  });
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/api/v2/
git commit -m "feat(api): add v2 contributor read endpoints (list, detail, commits, identity-queue)"
```

---

## Task 6: API — Write Endpoints

**Files:**
- Create: `packages/server/src/app/api/v2/contributors/merge/route.ts`
- Create: `packages/server/src/app/api/v2/contributors/unmerge/route.ts`
- Create: `packages/server/src/app/api/v2/contributors/[id]/exclude/route.ts`
- Create: `packages/server/src/app/api/v2/contributors/[id]/include/route.ts`
- Create: `packages/server/src/app/api/v2/contributors/[id]/classify/route.ts`
- Create: `packages/server/src/app/api/v2/contributors/aliases/[aliasId]/classify/route.ts`
- Create: `packages/server/src/app/api/v2/contributors/aliases/[aliasId]/resolve/route.ts`

- [ ] **Step 1: Create merge endpoint**

Create `packages/server/src/app/api/v2/contributors/merge/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { mergeBodySchema } from '@/lib/schemas/contributor';

export async function POST(request: NextRequest) {
  const sessionOrError = await requireUserSession();
  if (sessionOrError instanceof Response) return sessionOrError;
  const session = sessionOrError;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const body = await request.json();
  const parsed = mergeBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const { fromContributorId, toContributorId } = parsed.data;

  // Validate both belong to workspace
  const [from, to] = await Promise.all([
    prisma.contributor.findFirst({ where: { id: fromContributorId, workspaceId: workspace.id } }),
    prisma.contributor.findFirst({ where: { id: toContributorId, workspaceId: workspace.id } }),
  ]);

  if (!from) return apiError('Source contributor not found', 404);
  if (!to) return apiError('Target contributor not found', 404);

  // Transactional merge
  const result = await prisma.$transaction(async (tx: any) => {
    // Move all aliases from source to target
    await tx.contributorAlias.updateMany({
      where: { contributorId: fromContributorId },
      data: {
        contributorId: toContributorId,
        resolveStatus: 'MANUAL',
        mergeReason: 'manual',
      },
    });

    // Audit log
    await tx.curationAuditLog.create({
      data: {
        workspaceId: workspace.id,
        contributorId: toContributorId,
        action: 'MERGE',
        payload: {
          fromContributorId,
          toContributorId,
          fromDisplayName: from.displayName,
          fromEmail: from.primaryEmail,
        },
        performedByUserId: session.user.id,
      },
    });

    // Delete source contributor
    await tx.contributor.delete({ where: { id: fromContributorId } });

    // Return updated target
    return tx.contributor.findFirst({
      where: { id: toContributorId },
      include: { aliases: true },
    });
  });

  return apiResponse({ contributor: result });
}
```

- [ ] **Step 2: Create unmerge endpoint**

Create `packages/server/src/app/api/v2/contributors/unmerge/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { unmergeBodySchema } from '@/lib/schemas/contributor';

export async function POST(request: NextRequest) {
  const sessionOrError = await requireUserSession();
  if (sessionOrError instanceof Response) return sessionOrError;
  const session = sessionOrError;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const body = await request.json();
  const parsed = unmergeBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const { contributorId, aliasIds } = parsed.data;

  // Validate contributor belongs to workspace
  const contributor = await prisma.contributor.findFirst({
    where: { id: contributorId, workspaceId: workspace.id },
    include: { aliases: true },
  });

  if (!contributor) return apiError('Contributor not found', 404);

  // Validate all aliasIds belong to this contributor
  const aliasIdsSet = new Set(aliasIds);
  const ownedAliases = contributor.aliases.filter((a) => aliasIdsSet.has(a.id));
  if (ownedAliases.length !== aliasIds.length) {
    return apiError('Some aliases do not belong to this contributor', 400);
  }

  // Must leave at least one alias on the original
  const remainingCount = contributor.aliases.length - aliasIds.length;
  if (remainingCount < 1) {
    return apiError('Cannot extract all aliases — original contributor must keep at least one', 400);
  }

  // Transactional unmerge
  const result = await prisma.$transaction(async (tx: any) => {
    // Pick display info from first extracted alias
    const primaryAlias = ownedAliases[0];

    // Create new contributor from extracted aliases
    const newContributor = await tx.contributor.create({
      data: {
        workspaceId: workspace.id,
        displayName: primaryAlias.username || primaryAlias.email,
        primaryEmail: primaryAlias.email,
      },
    });

    // Move aliases to new contributor
    await tx.contributorAlias.updateMany({
      where: { id: { in: aliasIds } },
      data: {
        contributorId: newContributor.id,
        resolveStatus: 'MANUAL',
        mergeReason: 'manual',
      },
    });

    // Audit log
    await tx.curationAuditLog.create({
      data: {
        workspaceId: workspace.id,
        contributorId,
        action: 'UNMERGE',
        payload: {
          newContributorId: newContributor.id,
          extractedAliasIds: aliasIds,
        },
        performedByUserId: session.user.id,
      },
    });

    const [original, created] = await Promise.all([
      tx.contributor.findFirst({
        where: { id: contributorId },
        include: { aliases: true },
      }),
      tx.contributor.findFirst({
        where: { id: newContributor.id },
        include: { aliases: true },
      }),
    ]);

    return { original, newContributor: created };
  });

  return apiResponse(result);
}
```

- [ ] **Step 3: Create exclude/include/classify endpoints**

Create `packages/server/src/app/api/v2/contributors/[id]/exclude/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { excludeBodySchema } from '@/lib/schemas/contributor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sessionOrError = await requireUserSession();
  if (sessionOrError instanceof Response) return sessionOrError;
  const session = sessionOrError;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const contributor = await prisma.contributor.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!contributor) return apiError('Contributor not found', 404);

  const body = await request.json().catch(() => ({}));
  const parsed = excludeBodySchema.safeParse(body);

  const updated = await prisma.contributor.update({
    where: { id },
    data: { isExcluded: true, excludedAt: new Date() },
    include: { aliases: true },
  });

  await prisma.curationAuditLog.create({
    data: {
      workspaceId: workspace.id,
      contributorId: id,
      action: 'EXCLUDE',
      payload: { reason: parsed.success ? parsed.data.reason : undefined },
      performedByUserId: session.user.id,
    },
  });

  return apiResponse({ contributor: updated });
}
```

Create `packages/server/src/app/api/v2/contributors/[id]/include/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sessionOrError = await requireUserSession();
  if (sessionOrError instanceof Response) return sessionOrError;
  const session = sessionOrError;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const contributor = await prisma.contributor.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!contributor) return apiError('Contributor not found', 404);

  const updated = await prisma.contributor.update({
    where: { id },
    data: { isExcluded: false, excludedAt: null },
    include: { aliases: true },
  });

  await prisma.curationAuditLog.create({
    data: {
      workspaceId: workspace.id,
      contributorId: id,
      action: 'INCLUDE',
      payload: {},
      performedByUserId: session.user.id,
    },
  });

  return apiResponse({ contributor: updated });
}
```

Create `packages/server/src/app/api/v2/contributors/[id]/classify/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { classifyContributorBodySchema } from '@/lib/schemas/contributor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const sessionOrError = await requireUserSession();
  if (sessionOrError instanceof Response) return sessionOrError;
  const session = sessionOrError;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const contributor = await prisma.contributor.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!contributor) return apiError('Contributor not found', 404);

  const body = await request.json();
  const parsed = classifyContributorBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const updated = await prisma.contributor.update({
    where: { id },
    data: { classification: parsed.data.classification },
    include: { aliases: true },
  });

  await prisma.curationAuditLog.create({
    data: {
      workspaceId: workspace.id,
      contributorId: id,
      action: 'CLASSIFY',
      payload: {
        previousClassification: contributor.classification,
        newClassification: parsed.data.classification,
      },
      performedByUserId: session.user.id,
    },
  });

  return apiResponse({ contributor: updated });
}
```

- [ ] **Step 4: Create alias classify and resolve endpoints**

Create `packages/server/src/app/api/v2/contributors/aliases/[aliasId]/classify/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { classifyAliasBodySchema } from '@/lib/schemas/contributor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ aliasId: string }> }
) {
  const sessionOrError = await requireUserSession();
  if (sessionOrError instanceof Response) return sessionOrError;
  const session = sessionOrError;

  const { aliasId } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const alias = await prisma.contributorAlias.findFirst({
    where: { id: aliasId, workspaceId: workspace.id },
  });
  if (!alias) return apiError('Alias not found', 404);

  const body = await request.json();
  const parsed = classifyAliasBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const updated = await prisma.contributorAlias.update({
    where: { id: aliasId },
    data: { classificationHint: parsed.data.classificationHint },
  });

  await prisma.curationAuditLog.create({
    data: {
      workspaceId: workspace.id,
      contributorId: alias.contributorId,
      aliasId,
      action: 'CLASSIFY',
      payload: {
        target: 'alias',
        previousHint: alias.classificationHint,
        newHint: parsed.data.classificationHint,
      },
      performedByUserId: session.user.id,
    },
  });

  return apiResponse({ alias: updated });
}
```

Create `packages/server/src/app/api/v2/contributors/aliases/[aliasId]/resolve/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveAliasBodySchema } from '@/lib/schemas/contributor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ aliasId: string }> }
) {
  const sessionOrError = await requireUserSession();
  if (sessionOrError instanceof Response) return sessionOrError;
  const session = sessionOrError;

  const { aliasId } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const alias = await prisma.contributorAlias.findFirst({
    where: { id: aliasId, workspaceId: workspace.id },
  });
  if (!alias) return apiError('Alias not found', 404);

  const body = await request.json();
  const parsed = resolveAliasBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  // Validate target contributor belongs to workspace
  const contributor = await prisma.contributor.findFirst({
    where: { id: parsed.data.contributorId, workspaceId: workspace.id },
  });
  if (!contributor) return apiError('Target contributor not found', 404);

  const updated = await prisma.contributorAlias.update({
    where: { id: aliasId },
    data: {
      contributorId: parsed.data.contributorId,
      resolveStatus: 'MANUAL',
      mergeReason: 'manual',
      confidence: 1.0,
    },
  });

  await prisma.curationAuditLog.create({
    data: {
      workspaceId: workspace.id,
      contributorId: parsed.data.contributorId,
      aliasId,
      action: 'MERGE',
      payload: {
        target: 'alias_resolve',
        aliasEmail: alias.email,
        previousContributorId: alias.contributorId,
      },
      performedByUserId: session.user.id,
    },
  });

  const updatedContributor = await prisma.contributor.findFirst({
    where: { id: parsed.data.contributorId },
    include: { aliases: true },
  });

  return apiResponse({ alias: updated, contributor: updatedContributor });
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/api/v2/
git commit -m "feat(api): add v2 contributor write endpoints (merge, unmerge, exclude, include, classify, resolve)"
```

---

## Task 7: Integration Hooks

**Files:**
- Modify: `packages/server/src/lib/services/analysis-worker.ts`
- Modify: `packages/server/src/app/api/auth/register/route.ts`
- Modify: `packages/server/middleware.ts`

- [ ] **Step 1: Add projection hook to analysis worker**

In `packages/server/src/lib/services/analysis-worker.ts`, find the block where Order status is set to `'COMPLETED'` (around line 869, the `data: { status: 'COMPLETED', analyzedAt: new Date(), totalCommits: inScopeCount }` block). Add the projection call **after** the order update completes, in a try/catch:

Add import at the top of the file:
```typescript
import { projectContributorsFromOrder } from './contributor-identity';
```

After the order COMPLETED update block (after the `await prisma.order.update(...)` that sets `status: 'COMPLETED'`), add:

```typescript
// Best-effort contributor projection — does not affect analysis status
try {
  await projectContributorsFromOrder(orderId);
} catch (projectionErr) {
  analysisLogger.error(
    { err: projectionErr, orderId },
    'Contributor projection failed (non-blocking)'
  );
}
```

- [ ] **Step 2: Add workspace bootstrap to registration**

In `packages/server/src/app/api/auth/register/route.ts`, add import at top:

```typescript
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
```

After the `const user = await prisma.user.create(...)` call and before the audit log, add:

```typescript
// Best-effort workspace creation — must not break registration
try {
  await ensureWorkspaceForUser(user.id);
} catch (wsErr) {
  // Workspace will be created on first projection or API access
}
```

- [ ] **Step 3: Add /people to protected routes**

In `packages/server/middleware.ts`, add `'/people'` to `PROTECTED_PREFIXES` array:

```typescript
const PROTECTED_PREFIXES = [
  '/dashboard',
  '/orders',
  '/demo',
  '/settings',
  '/admin',
  '/billing',
  '/publications',
  '/profile',
  '/people',
];
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/lib/services/analysis-worker.ts packages/server/src/app/api/auth/register/route.ts packages/server/middleware.ts
git commit -m "feat: add contributor projection hook, workspace bootstrap, and /people route protection"
```

---

## Task 8: Backfill Script

**Files:**
- Create: `packages/server/scripts/backfill-contributors.ts`

- [ ] **Step 1: Create the backfill script**

Create `packages/server/scripts/backfill-contributors.ts`:

```typescript
import prisma from '../src/lib/db';
import { backfillAllOrders } from '../src/lib/services/contributor-identity';

async function main() {
  console.log('Starting contributor backfill...');
  console.log('');

  try {
    const result = await backfillAllOrders();

    console.log('');
    console.log('Backfill complete!');
    console.log(`  Users processed: ${result.usersProcessed}`);
    console.log(`  Orders processed: ${result.ordersProcessed}`);

    // Summary counts
    const contributorCount = await prisma.contributor.count();
    const aliasCount = await prisma.contributorAlias.count();
    const unresolvedCount = await prisma.contributorAlias.count({
      where: { resolveStatus: 'UNRESOLVED' },
    });

    console.log('');
    console.log('Results:');
    console.log(`  Contributors: ${contributorCount}`);
    console.log(`  Aliases: ${aliasCount}`);
    console.log(`  Unresolved: ${unresolvedCount}`);
  } catch (err) {
    console.error('Backfill failed:', err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/scripts/backfill-contributors.ts
git commit -m "feat: add contributor backfill script"
```

---

## Task 9: i18n Messages

**Files:**
- Modify: `packages/server/messages/en.json`
- Modify: `packages/server/messages/ru.json`

- [ ] **Step 1: Add English messages**

In `packages/server/messages/en.json`, add `"people"` key to the `sidebar` section:

```json
"people": "People"
```

Add new top-level sections:

```json
"people": {
  "title": "People",
  "search": {
    "placeholder": "Search contributors..."
  },
  "summary": {
    "total": "Contributors",
    "unresolved": "Unresolved Identities",
    "excluded": "Excluded"
  },
  "filters": {
    "classification": "Classification",
    "identityHealth": "Identity Health",
    "all": "All",
    "internal": "Internal",
    "external": "External",
    "bot": "Bot",
    "formerEmployee": "Former Employee",
    "healthy": "Healthy",
    "attention": "Needs Attention",
    "unresolved": "Unresolved"
  },
  "table": {
    "name": "Name",
    "email": "Email",
    "classification": "Classification",
    "identity": "Identity",
    "repos": "Repositories",
    "lastActivity": "Last Activity"
  },
  "actions": {
    "viewDetail": "View Detail",
    "exclude": "Exclude",
    "include": "Include",
    "classify": "Classify",
    "classifyAs": "Classify as..."
  },
  "identityQueue": {
    "title": "Identity Queue",
    "description": "Unresolved aliases that need review",
    "resolve": "Resolve",
    "empty": "No unresolved identities"
  },
  "empty": {
    "title": "No contributors yet",
    "description": "Run an analysis to populate contributors."
  },
  "error": {
    "title": "Failed to load contributors",
    "retry": "Retry"
  },
  "filteredEmpty": {
    "title": "No contributors match filters",
    "reset": "Reset Filters"
  }
},
"contributorDetail": {
  "backToList": "Back to People",
  "header": {
    "excluded": "Excluded",
    "actions": "Actions"
  },
  "identity": {
    "title": "Identity & Aliases",
    "attached": "Attached Aliases",
    "potentialMatches": "Potential Matches",
    "resolved": "Resolved",
    "autoMerged": "Auto-merged",
    "manual": "Manual",
    "unresolved": "Unresolved",
    "attachToThis": "Attach to this contributor",
    "classifyHint": "Classify"
  },
  "kpi": {
    "commits": "Commits",
    "repositories": "Repositories",
    "lastActivity": "Last Activity"
  },
  "repos": {
    "title": "Repository Breakdown",
    "name": "Repository",
    "commits": "Commits",
    "lastActivity": "Last Activity",
    "empty": "No repository activity found"
  },
  "commits": {
    "title": "Commit Evidence",
    "sha": "SHA",
    "message": "Message",
    "repo": "Repository",
    "date": "Date",
    "effort": "Effort (h)",
    "empty": "No commits found"
  },
  "actions": {
    "exclude": "Exclude Contributor",
    "include": "Include Contributor",
    "classify": "Classify",
    "merge": "Merge with..."
  },
  "merge": {
    "title": "Merge into another contributor",
    "search": "Search contributors...",
    "cancel": "Cancel",
    "confirm": "Merge",
    "noResults": "No contributors found"
  },
  "empty": {
    "activity": "No activity in this period"
  },
  "error": {
    "title": "Failed to load contributor",
    "notFound": "Contributor not found",
    "retry": "Retry"
  }
}
```

- [ ] **Step 2: Add Russian messages**

In `packages/server/messages/ru.json`, add `"people"` key to the `sidebar` section:

```json
"people": "Разработчики"
```

Add new top-level sections:

```json
"people": {
  "title": "Разработчики",
  "search": {
    "placeholder": "Поиск разработчиков..."
  },
  "summary": {
    "total": "Разработчики",
    "unresolved": "Неразрешённые идентичности",
    "excluded": "Исключённые"
  },
  "filters": {
    "classification": "Классификация",
    "identityHealth": "Состояние идентичности",
    "all": "Все",
    "internal": "Внутренние",
    "external": "Внешние",
    "bot": "Бот",
    "formerEmployee": "Бывший сотрудник",
    "healthy": "В порядке",
    "attention": "Требует внимания",
    "unresolved": "Неразрешённые"
  },
  "table": {
    "name": "Имя",
    "email": "Email",
    "classification": "Классификация",
    "identity": "Идентичность",
    "repos": "Репозитории",
    "lastActivity": "Последняя активность"
  },
  "actions": {
    "viewDetail": "Подробнее",
    "exclude": "Исключить",
    "include": "Включить",
    "classify": "Классифицировать",
    "classifyAs": "Классифицировать как..."
  },
  "identityQueue": {
    "title": "Очередь идентичностей",
    "description": "Неразрешённые алиасы, требующие проверки",
    "resolve": "Разрешить",
    "empty": "Нет неразрешённых идентичностей"
  },
  "empty": {
    "title": "Нет разработчиков",
    "description": "Запустите анализ для заполнения списка разработчиков."
  },
  "error": {
    "title": "Ошибка загрузки разработчиков",
    "retry": "Повторить"
  },
  "filteredEmpty": {
    "title": "Нет разработчиков, соответствующих фильтрам",
    "reset": "Сбросить фильтры"
  }
},
"contributorDetail": {
  "backToList": "Назад к списку",
  "header": {
    "excluded": "Исключён",
    "actions": "Действия"
  },
  "identity": {
    "title": "Идентичность и алиасы",
    "attached": "Привязанные алиасы",
    "potentialMatches": "Возможные совпадения",
    "resolved": "Разрешён",
    "autoMerged": "Автоматически",
    "manual": "Вручную",
    "unresolved": "Неразрешён",
    "attachToThis": "Привязать к этому разработчику",
    "classifyHint": "Классифицировать"
  },
  "kpi": {
    "commits": "Коммиты",
    "repositories": "Репозитории",
    "lastActivity": "Последняя активность"
  },
  "repos": {
    "title": "Активность по репозиториям",
    "name": "Репозиторий",
    "commits": "Коммиты",
    "lastActivity": "Последняя активность",
    "empty": "Нет активности в репозиториях"
  },
  "commits": {
    "title": "Доказательства (коммиты)",
    "sha": "SHA",
    "message": "Сообщение",
    "repo": "Репозиторий",
    "date": "Дата",
    "effort": "Усилие (ч)",
    "empty": "Нет коммитов"
  },
  "actions": {
    "exclude": "Исключить разработчика",
    "include": "Включить разработчика",
    "classify": "Классифицировать",
    "merge": "Объединить с..."
  },
  "merge": {
    "title": "Объединить с другим разработчиком",
    "search": "Поиск разработчиков...",
    "cancel": "Отмена",
    "confirm": "Объединить",
    "noResults": "Разработчики не найдены"
  },
  "empty": {
    "activity": "Нет активности за этот период"
  },
  "error": {
    "title": "Ошибка загрузки разработчика",
    "notFound": "Разработчик не найден",
    "retry": "Повторить"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "feat(i18n): add People and Contributor Detail translations (en + ru)"
```

---

## Task 10: Sidebar — Add People Navigation

**Files:**
- Modify: `packages/server/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Add People to the user navigation array**

In `packages/server/src/components/layout/sidebar.tsx`, add the import for `Users` icon if not already imported (it is already imported for admin nav — verify). Then add to the `navigation` array (the user nav, not admin nav), between `orders` and `publications`:

```typescript
const navigation = [
  { nameKey: 'dashboard', href: '/dashboard', icon: LayoutDashboard },
  { nameKey: 'orders', href: '/orders', icon: ClipboardList },
  { nameKey: 'people', href: '/people', icon: Users },
  { nameKey: 'publications', href: '/publications', icon: Share2 },
];
```

`Users` icon is already imported for admin nav. If not, add to lucide-react imports:
```typescript
import { Users } from 'lucide-react';
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/components/layout/sidebar.tsx
git commit -m "feat(nav): add People item to sidebar navigation"
```

---

## Task 11: UI — People List Page

**Files:**
- Create: `packages/server/src/app/[locale]/(dashboard)/people/page.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/components/people-summary-strip.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/components/people-filters.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/components/people-identity-queue.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/components/people-table.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/components/people-table-row.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/components/identity-health-badge.tsx`

This task creates all People List UI components. The implementation uses TanStack Query for data fetching, URL search params for filter state, and shadcn/ui components.

- [ ] **Step 1: Create identity-health-badge.tsx**

Create `packages/server/src/app/[locale]/(dashboard)/people/components/identity-health-badge.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react';

type HealthStatus = 'healthy' | 'attention' | 'unresolved';

interface IdentityHealthBadgeProps {
  status: HealthStatus;
  unresolvedCount?: number;
}

const config: Record<HealthStatus, {
  icon: typeof CheckCircle2;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  className: string;
}> = {
  healthy: {
    icon: CheckCircle2,
    variant: 'outline',
    className: 'border-green-500/50 text-green-700 dark:text-green-400',
  },
  attention: {
    icon: AlertTriangle,
    variant: 'outline',
    className: 'border-yellow-500/50 text-yellow-700 dark:text-yellow-400',
  },
  unresolved: {
    icon: AlertCircle,
    variant: 'outline',
    className: 'border-red-500/50 text-red-700 dark:text-red-400',
  },
};

export function IdentityHealthBadge({ status, unresolvedCount }: IdentityHealthBadgeProps) {
  const t = useTranslations('people.filters');
  const { icon: Icon, variant, className } = config[status];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={variant} className={`gap-1 ${className}`}>
          <Icon className="h-3 w-3" />
          {t(status)}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        {status === 'healthy' && t('healthy')}
        {status === 'attention' && `${unresolvedCount ?? 0} unresolved`}
        {status === 'unresolved' && t('unresolved')}
      </TooltipContent>
    </Tooltip>
  );
}
```

- [ ] **Step 2: Create people-summary-strip.tsx**

Create `packages/server/src/app/[locale]/(dashboard)/people/components/people-summary-strip.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Users, AlertCircle, EyeOff } from 'lucide-react';

interface PeopleSummaryStripProps {
  totalContributors: number;
  unresolvedCount: number;
  excludedCount: number;
  onUnresolvedClick: () => void;
}

export function PeopleSummaryStrip({
  totalContributors,
  unresolvedCount,
  excludedCount,
  onUnresolvedClick,
}: PeopleSummaryStripProps) {
  const t = useTranslations('people.summary');

  return (
    <div className="grid grid-cols-3 gap-4">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Users className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{totalContributors}</p>
            <p className="text-sm text-muted-foreground">{t('total')}</p>
          </div>
        </CardContent>
      </Card>

      <Card
        className="cursor-pointer hover:border-yellow-500/50 transition-colors"
        onClick={onUnresolvedClick}
      >
        <CardContent className="flex items-center gap-3 p-4">
          <AlertCircle className="h-5 w-5 text-yellow-600" />
          <div>
            <p className="text-2xl font-bold">{unresolvedCount}</p>
            <p className="text-sm text-muted-foreground">{t('unresolved')}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <EyeOff className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{excludedCount}</p>
            <p className="text-sm text-muted-foreground">{t('excluded')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Create people-filters.tsx**

Create `packages/server/src/app/[locale]/(dashboard)/people/components/people-filters.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Search } from 'lucide-react';

interface PeopleFiltersProps {
  search: string;
  classification: string;
  identityHealth: string;
  onSearchChange: (value: string) => void;
  onClassificationChange: (value: string) => void;
  onIdentityHealthChange: (value: string) => void;
}

export function PeopleFilters({
  search,
  classification,
  identityHealth,
  onSearchChange,
  onClassificationChange,
  onIdentityHealthChange,
}: PeopleFiltersProps) {
  const t = useTranslations('people.filters');

  return (
    <div className="flex items-center gap-3">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={useTranslations('people.search')('placeholder')}
          className="pl-9"
        />
      </div>

      <Select value={classification} onValueChange={onClassificationChange}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder={t('classification')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('all')}</SelectItem>
          <SelectItem value="INTERNAL">{t('internal')}</SelectItem>
          <SelectItem value="EXTERNAL">{t('external')}</SelectItem>
          <SelectItem value="BOT">{t('bot')}</SelectItem>
          <SelectItem value="FORMER_EMPLOYEE">{t('formerEmployee')}</SelectItem>
        </SelectContent>
      </Select>

      <Select value={identityHealth} onValueChange={onIdentityHealthChange}>
        <SelectTrigger className="w-[180px]">
          <SelectValue placeholder={t('identityHealth')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('all')}</SelectItem>
          <SelectItem value="healthy">{t('healthy')}</SelectItem>
          <SelectItem value="attention">{t('attention')}</SelectItem>
          <SelectItem value="unresolved">{t('unresolved')}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 4: Create people-identity-queue.tsx**

Create `packages/server/src/app/[locale]/(dashboard)/people/components/people-identity-queue.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { IdentityHealthBadge } from './identity-health-badge';

interface PeopleIdentityQueueProps {
  unresolvedCount: number;
}

export function PeopleIdentityQueue({ unresolvedCount }: PeopleIdentityQueueProps) {
  const t = useTranslations('people.identityQueue');
  const [isOpen, setIsOpen] = useState(unresolvedCount > 0);

  const { data } = useQuery({
    queryKey: ['identity-queue'],
    queryFn: async () => {
      const res = await fetch('/api/v2/contributors/identity-queue?pageSize=5');
      const json = await res.json();
      return json.data;
    },
    enabled: isOpen && unresolvedCount > 0,
  });

  if (unresolvedCount === 0) return null;

  return (
    <Card id="identity-queue">
      <CardHeader
        className="cursor-pointer flex flex-row items-center justify-between py-3"
        onClick={() => setIsOpen(!isOpen)}
      >
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          {t('title')}
          <IdentityHealthBadge status="unresolved" unresolvedCount={unresolvedCount} />
        </CardTitle>
        {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </CardHeader>

      {isOpen && (
        <CardContent className="pt-0">
          <p className="text-sm text-muted-foreground mb-3">{t('description')}</p>
          {data?.aliases?.length > 0 ? (
            <div className="space-y-2">
              {data.aliases.map((item: any) => (
                <div
                  key={item.alias.id}
                  className="flex items-center justify-between rounded-md border p-2 text-sm"
                >
                  <div>
                    <span className="font-medium">{item.alias.email}</span>
                    {item.alias.username && (
                      <span className="text-muted-foreground ml-2">@{item.alias.username}</span>
                    )}
                  </div>
                  <Button size="sm" variant="outline">
                    {t('resolve')}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
```

- [ ] **Step 5: Create people-table-row.tsx**

Create `packages/server/src/app/[locale]/(dashboard)/people/components/people-table-row.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TableCell, TableRow } from '@/components/ui/table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { MoreHorizontal } from 'lucide-react';
import { IdentityHealthBadge } from './identity-health-badge';
import { formatDistanceToNow } from 'date-fns';

interface ContributorRow {
  id: string;
  displayName: string;
  primaryEmail: string;
  classification: string;
  isExcluded: boolean;
  identityHealth: { status: 'healthy' | 'attention' | 'unresolved'; unresolvedAliasCount: number };
  aliasCount: number;
  lastActivityAt: string;
}

interface PeopleTableRowProps {
  contributor: ContributorRow;
  searchParams: string;
}

export function PeopleTableRow({ contributor, searchParams }: PeopleTableRowProps) {
  const t = useTranslations('people.actions');
  const tFilters = useTranslations('people.filters');
  const router = useRouter();
  const queryClient = useQueryClient();

  const excludeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/contributors/${contributor.id}/exclude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contributors'] }),
  });

  const includeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/contributors/${contributor.id}/include`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contributors'] }),
  });

  const classifyMutation = useMutation({
    mutationFn: async (classification: string) => {
      const res = await fetch(`/api/v2/contributors/${contributor.id}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classification }),
      });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['contributors'] }),
  });

  const handleNavigate = () => {
    router.push(`/people/${contributor.id}?from=${encodeURIComponent(searchParams)}`);
  };

  return (
    <TableRow className="cursor-pointer" onClick={handleNavigate}>
      <TableCell className="font-medium">{contributor.displayName}</TableCell>
      <TableCell>{contributor.primaryEmail}</TableCell>
      <TableCell>{tFilters(contributor.classification.toLowerCase())}</TableCell>
      <TableCell>
        <IdentityHealthBadge
          status={contributor.identityHealth.status}
          unresolvedCount={contributor.identityHealth.unresolvedAliasCount}
        />
      </TableCell>
      <TableCell>{contributor.aliasCount}</TableCell>
      <TableCell>
        {contributor.lastActivityAt
          ? formatDistanceToNow(new Date(contributor.lastActivityAt), { addSuffix: true })
          : '—'}
      </TableCell>
      <TableCell onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleNavigate}>
              {t('viewDetail')}
            </DropdownMenuItem>
            {contributor.isExcluded ? (
              <DropdownMenuItem onClick={() => includeMutation.mutate()}>
                {t('include')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => excludeMutation.mutate()}>
                {t('exclude')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{t('classifyAs')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {['INTERNAL', 'EXTERNAL', 'BOT', 'FORMER_EMPLOYEE'].map((cls) => (
                  <DropdownMenuItem
                    key={cls}
                    onClick={() => classifyMutation.mutate(cls)}
                  >
                    {tFilters(cls.toLowerCase())}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
```

- [ ] **Step 6: Create people-table.tsx**

Create `packages/server/src/app/[locale]/(dashboard)/people/components/people-table.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { ArrowUpDown } from 'lucide-react';
import { PeopleTableRow } from './people-table-row';

interface PeopleTableProps {
  contributors: any[];
  sort: string;
  sortOrder: string;
  onSortChange: (field: string) => void;
  searchParams: string;
}

export function PeopleTable({
  contributors,
  sort,
  sortOrder,
  onSortChange,
  searchParams,
}: PeopleTableProps) {
  const t = useTranslations('people.table');

  const SortHeader = ({ field, children }: { field: string; children: React.ReactNode }) => (
    <TableHead>
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8"
        onClick={() => onSortChange(field)}
      >
        {children}
        <ArrowUpDown className="ml-1 h-3 w-3" />
      </Button>
    </TableHead>
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortHeader field="displayName">{t('name')}</SortHeader>
          <SortHeader field="primaryEmail">{t('email')}</SortHeader>
          <TableHead>{t('classification')}</TableHead>
          <TableHead>{t('identity')}</TableHead>
          <TableHead>{t('repos')}</TableHead>
          <SortHeader field="lastActivityAt">{t('lastActivity')}</SortHeader>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {contributors.map((contributor) => (
          <PeopleTableRow
            key={contributor.id}
            contributor={contributor}
            searchParams={searchParams}
          />
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 7: Create the People List page**

Create `packages/server/src/app/[locale]/(dashboard)/people/page.tsx`:

```tsx
'use client';

import { useState, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { PeopleSummaryStrip } from './components/people-summary-strip';
import { PeopleFilters } from './components/people-filters';
import { PeopleIdentityQueue } from './components/people-identity-queue';
import { PeopleTable } from './components/people-table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export default function PeoplePage() {
  const t = useTranslations('people');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const queueRef = useRef<HTMLDivElement>(null);

  // Read filter state from URL
  const page = Number(searchParams.get('page') || '1');
  const pageSize = Number(searchParams.get('pageSize') || '20');
  const sort = searchParams.get('sort') || 'displayName';
  const sortOrder = searchParams.get('sortOrder') || 'asc';
  const classification = searchParams.get('classification') || 'all';
  const identityHealth = searchParams.get('identityHealth') || 'all';
  const search = searchParams.get('search') || '';

  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === 'all' || value === '') {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      router.replace(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname]
  );

  // Fetch contributors
  const queryParams = new URLSearchParams();
  queryParams.set('page', String(page));
  queryParams.set('pageSize', String(pageSize));
  queryParams.set('sort', sort);
  queryParams.set('sortOrder', sortOrder);
  if (classification !== 'all') queryParams.set('classification', classification);
  if (identityHealth !== 'all') queryParams.set('identityHealth', identityHealth);
  if (search) queryParams.set('search', search);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['contributors', queryParams.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/v2/contributors?${queryParams.toString()}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
  });

  const handleSortChange = (field: string) => {
    if (sort === field) {
      updateParams({ sortOrder: sortOrder === 'asc' ? 'desc' : 'asc' });
    } else {
      updateParams({ sort: field, sortOrder: 'asc' });
    }
  };

  const handleUnresolvedClick = () => {
    const el = document.getElementById('identity-queue');
    el?.scrollIntoView({ behavior: 'smooth' });
    updateParams({ identityHealth: 'unresolved' });
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  // Error state
  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <p className="text-destructive">{t('error.title')}</p>
        <Button onClick={() => refetch()}>{t('error.retry')}</Button>
      </div>
    );
  }

  // Empty state
  if (!data?.contributors?.length && !search && classification === 'all' && identityHealth === 'all') {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <h2 className="text-xl font-semibold">{t('empty.title')}</h2>
        <p className="text-muted-foreground">{t('empty.description')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>

      <PeopleSummaryStrip
        totalContributors={data?.totalContributors ?? 0}
        unresolvedCount={data?.identityQueueSummary?.unresolvedCount ?? 0}
        excludedCount={data?.excludedCount ?? 0}
        onUnresolvedClick={handleUnresolvedClick}
      />

      <PeopleFilters
        search={search}
        classification={classification}
        identityHealth={identityHealth}
        onSearchChange={(v) => updateParams({ search: v, page: '1' })}
        onClassificationChange={(v) => updateParams({ classification: v, page: '1' })}
        onIdentityHealthChange={(v) => updateParams({ identityHealth: v, page: '1' })}
      />

      <PeopleIdentityQueue
        unresolvedCount={data?.identityQueueSummary?.unresolvedCount ?? 0}
      />

      {data?.contributors?.length ? (
        <>
          <PeopleTable
            contributors={data.contributors}
            sort={sort}
            sortOrder={sortOrder}
            onSortChange={handleSortChange}
            searchParams={searchParams.toString()}
          />

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {data.pagination.total} total
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => updateParams({ page: String(page - 1) })}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.pagination.totalPages}
                onClick={() => updateParams({ page: String(page + 1) })}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-8">
          <p className="text-muted-foreground">{t('filteredEmpty.title')}</p>
          <Button
            variant="link"
            onClick={() => updateParams({ search: '', classification: 'all', identityHealth: 'all', page: '1' })}
          >
            {t('filteredEmpty.reset')}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/app/\[locale\]/\(dashboard\)/people/
git commit -m "feat(ui): add People List page with summary, filters, identity queue, and table"
```

---

## Task 12: UI — Contributor Detail Page

**Files:**
- Create: `packages/server/src/app/[locale]/(dashboard)/people/[id]/page.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-header.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-kpi-summary.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-aliases-panel.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-repo-breakdown.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-commit-evidence.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-merge-modal.tsx`

- [ ] **Step 1: Create contributor-header.tsx**

Create `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-header.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { IdentityHealthBadge } from '../../components/identity-health-badge';
import { MoreHorizontal } from 'lucide-react';

interface ContributorHeaderProps {
  contributor: {
    id: string;
    displayName: string;
    primaryEmail: string;
    classification: string;
    isExcluded: boolean;
  };
  identityHealth: { status: 'healthy' | 'attention' | 'unresolved'; unresolvedAliasCount: number };
  onMergeClick: () => void;
}

export function ContributorHeader({ contributor, identityHealth, onMergeClick }: ContributorHeaderProps) {
  const t = useTranslations('contributorDetail');
  const tFilters = useTranslations('people.filters');
  const queryClient = useQueryClient();

  const excludeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/contributors/${contributor.id}/exclude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contributor', contributor.id] });
      queryClient.invalidateQueries({ queryKey: ['contributors'] });
    },
  });

  const includeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/contributors/${contributor.id}/include`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contributor', contributor.id] });
      queryClient.invalidateQueries({ queryKey: ['contributors'] });
    },
  });

  const classifyMutation = useMutation({
    mutationFn: async (classification: string) => {
      const res = await fetch(`/api/v2/contributors/${contributor.id}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ classification }),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contributor', contributor.id] });
      queryClient.invalidateQueries({ queryKey: ['contributors'] });
    },
  });

  return (
    <div className="flex items-start justify-between">
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">{contributor.displayName}</h1>
          {contributor.isExcluded && (
            <Badge variant="destructive">{t('header.excluded')}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>{contributor.primaryEmail}</span>
          <span>·</span>
          <span>{tFilters(contributor.classification.toLowerCase())}</span>
        </div>
        <IdentityHealthBadge
          status={identityHealth.status}
          unresolvedCount={identityHealth.unresolvedAliasCount}
        />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            {t('header.actions')} <MoreHorizontal className="ml-2 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {contributor.isExcluded ? (
            <DropdownMenuItem onClick={() => includeMutation.mutate()}>
              {t('actions.include')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => excludeMutation.mutate()}>
              {t('actions.exclude')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{t('actions.classify')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {['INTERNAL', 'EXTERNAL', 'BOT', 'FORMER_EMPLOYEE'].map((cls) => (
                <DropdownMenuItem key={cls} onClick={() => classifyMutation.mutate(cls)}>
                  {tFilters(cls.toLowerCase())}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={onMergeClick}>
            {t('actions.merge')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

- [ ] **Step 2: Create contributor-kpi-summary.tsx**

Create `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-kpi-summary.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { GitCommitHorizontal, FolderGit2, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface ContributorKpiSummaryProps {
  totalCommits: number;
  activeRepositoryCount: number;
  lastActivityAt: string | null;
}

export function ContributorKpiSummary({
  totalCommits,
  activeRepositoryCount,
  lastActivityAt,
}: ContributorKpiSummaryProps) {
  const t = useTranslations('contributorDetail.kpi');

  return (
    <div className="grid grid-cols-3 gap-4">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <GitCommitHorizontal className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{totalCommits}</p>
            <p className="text-sm text-muted-foreground">{t('commits')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <FolderGit2 className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{activeRepositoryCount}</p>
            <p className="text-sm text-muted-foreground">{t('repositories')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Clock className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">
              {lastActivityAt
                ? formatDistanceToNow(new Date(lastActivityAt), { addSuffix: true })
                : '—'}
            </p>
            <p className="text-sm text-muted-foreground">{t('lastActivity')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Create contributor-aliases-panel.tsx**

Create `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-aliases-panel.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CheckCircle2, AlertCircle } from 'lucide-react';

interface Alias {
  id: string;
  email: string;
  username: string | null;
  providerType: string;
  resolveStatus: string;
  mergeReason: string | null;
}

interface PotentialMatch {
  id: string;
  email: string;
  username: string | null;
  providerType: string;
  lastSeenAt: string | null;
}

interface ContributorAliasesPanelProps {
  contributorId: string;
  aliases: Alias[];
  potentialMatches: PotentialMatch[];
}

export function ContributorAliasesPanel({
  contributorId,
  aliases,
  potentialMatches,
}: ContributorAliasesPanelProps) {
  const t = useTranslations('contributorDetail.identity');
  const queryClient = useQueryClient();

  const resolveMutation = useMutation({
    mutationFn: async (aliasId: string) => {
      const res = await fetch(`/api/v2/contributors/aliases/${aliasId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contributorId }),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contributor', contributorId] });
      queryClient.invalidateQueries({ queryKey: ['contributors'] });
      queryClient.invalidateQueries({ queryKey: ['identity-queue'] });
    },
  });

  const statusLabel = (status: string) => {
    switch (status) {
      case 'AUTO_MERGED': return t('autoMerged');
      case 'MANUAL': return t('manual');
      case 'SUGGESTED': return t('unresolved');
      default: return t('unresolved');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Attached Aliases */}
        <div>
          <h4 className="text-sm font-medium mb-2">{t('attached')}</h4>
          <div className="space-y-2">
            {aliases.map((alias) => (
              <div
                key={alias.id}
                className="flex items-center justify-between rounded-md border p-2 text-sm"
              >
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <span className="font-medium">{alias.email}</span>
                  {alias.username && (
                    <span className="text-muted-foreground">@{alias.username}</span>
                  )}
                  <Badge variant="secondary" className="text-xs">
                    {alias.providerType}
                  </Badge>
                </div>
                <Badge variant="outline" className="text-xs">
                  {statusLabel(alias.resolveStatus)}
                </Badge>
              </div>
            ))}
          </div>
        </div>

        {/* Potential Matches */}
        {potentialMatches.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">{t('potentialMatches')}</h4>
            <div className="space-y-2">
              {potentialMatches.map((match) => (
                <div
                  key={match.id}
                  className="flex items-center justify-between rounded-md border border-dashed border-yellow-500/50 p-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-yellow-500" />
                    <span className="font-medium">{match.email}</span>
                    {match.username && (
                      <span className="text-muted-foreground">@{match.username}</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => resolveMutation.mutate(match.id)}
                    disabled={resolveMutation.isPending}
                  >
                    {t('attachToThis')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Create contributor-repo-breakdown.tsx and contributor-commit-evidence.tsx**

Create `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-repo-breakdown.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDistanceToNow } from 'date-fns';

interface RepoEntry {
  repoName: string;
  commitCount: number;
  lastActivityAt: string;
}

interface ContributorRepoBreakdownProps {
  repositories: RepoEntry[];
}

export function ContributorRepoBreakdown({ repositories }: ContributorRepoBreakdownProps) {
  const t = useTranslations('contributorDetail.repos');

  if (repositories.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('commits')}</TableHead>
              <TableHead>{t('lastActivity')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {repositories.map((repo) => (
              <TableRow key={repo.repoName}>
                <TableCell className="font-medium">{repo.repoName}</TableCell>
                <TableCell>{repo.commitCount}</TableCell>
                <TableCell>
                  {formatDistanceToNow(new Date(repo.lastActivityAt), { addSuffix: true })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
```

Create `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-commit-evidence.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { format } from 'date-fns';

interface ContributorCommitEvidenceProps {
  contributorId: string;
}

export function ContributorCommitEvidence({ contributorId }: ContributorCommitEvidenceProps) {
  const t = useTranslations('contributorDetail.commits');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const { data, isLoading } = useQuery({
    queryKey: ['contributor-commits', contributorId, page],
    queryFn: async () => {
      const res = await fetch(
        `/api/v2/contributors/${contributorId}/commits?page=${page}&pageSize=${pageSize}`
      );
      const json = await res.json();
      return json.data;
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('title')}</CardTitle>
        {data?.pagination && (
          <span className="text-sm text-muted-foreground">
            {data.pagination.total} total
          </span>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !data?.commits?.length ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('sha')}</TableHead>
                  <TableHead>{t('message')}</TableHead>
                  <TableHead>{t('repo')}</TableHead>
                  <TableHead>{t('date')}</TableHead>
                  <TableHead>{t('effort')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.commits.map((commit: any) => (
                  <TableRow key={commit.sha}>
                    <TableCell className="font-mono text-xs">
                      {commit.sha?.slice(0, 7)}
                    </TableCell>
                    <TableCell className="max-w-[300px] truncate">
                      {commit.message}
                    </TableCell>
                    <TableCell>{commit.repo}</TableCell>
                    <TableCell>
                      {commit.authoredAt
                        ? format(new Date(commit.authoredAt), 'MMM d, yyyy')
                        : '—'}
                    </TableCell>
                    <TableCell>
                      {commit.effortHours != null
                        ? commit.effortHours.toFixed(1)
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {data.pagination.totalPages > 1 && (
              <div className="flex justify-end gap-2 mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= data.pagination.totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 5: Create contributor-merge-modal.tsx**

Create `packages/server/src/app/[locale]/(dashboard)/people/[id]/components/contributor-merge-modal.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';

interface ContributorMergeModalProps {
  contributorId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ContributorMergeModal({
  contributorId,
  open,
  onOpenChange,
}: ContributorMergeModalProps) {
  const t = useTranslations('contributorDetail.merge');
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ['contributors-search', search],
    queryFn: async () => {
      const res = await fetch(
        `/api/v2/contributors?search=${encodeURIComponent(search)}&pageSize=10`
      );
      const json = await res.json();
      return json.data?.contributors?.filter((c: any) => c.id !== contributorId) ?? [];
    },
    enabled: open && search.length >= 2,
  });

  const mergeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/v2/contributors/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromContributorId: contributorId,
          toContributorId: selectedId,
        }),
      });
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['contributors'] });
      queryClient.invalidateQueries({ queryKey: ['identity-queue'] });
      onOpenChange(false);
      // Navigate to target contributor
      if (selectedId) {
        router.push(`/people/${selectedId}`);
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>

        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSelectedId(null);
          }}
          placeholder={t('search')}
        />

        {data && data.length > 0 ? (
          <RadioGroup value={selectedId ?? ''} onValueChange={setSelectedId}>
            <div className="space-y-2 max-h-[200px] overflow-y-auto">
              {data.map((c: any) => (
                <div key={c.id} className="flex items-center space-x-2 rounded-md border p-2">
                  <RadioGroupItem value={c.id} id={c.id} />
                  <Label htmlFor={c.id} className="flex-1 cursor-pointer">
                    <span className="font-medium">{c.displayName}</span>
                    <span className="text-muted-foreground ml-2">{c.primaryEmail}</span>
                  </Label>
                </div>
              ))}
            </div>
          </RadioGroup>
        ) : search.length >= 2 ? (
          <p className="text-sm text-muted-foreground py-4">{t('noResults')}</p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => mergeMutation.mutate()}
            disabled={!selectedId || mergeMutation.isPending}
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: Create the Contributor Detail page**

Create `packages/server/src/app/[locale]/(dashboard)/people/[id]/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft } from 'lucide-react';
import { ContributorHeader } from './components/contributor-header';
import { ContributorKpiSummary } from './components/contributor-kpi-summary';
import { ContributorAliasesPanel } from './components/contributor-aliases-panel';
import { ContributorRepoBreakdown } from './components/contributor-repo-breakdown';
import { ContributorCommitEvidence } from './components/contributor-commit-evidence';
import { ContributorMergeModal } from './components/contributor-merge-modal';

export default function ContributorDetailPage() {
  const t = useTranslations('contributorDetail');
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const [mergeOpen, setMergeOpen] = useState(false);

  // Preserve list state for back navigation
  const fromParams = searchParams.get('from') || '';

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['contributor', id],
    queryFn: async () => {
      const res = await fetch(`/api/v2/contributors/${id}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);
      return json.data;
    },
  });

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-16 w-full" />
        <div className="grid grid-cols-3 gap-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  // Error / not found state
  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <p className="text-destructive">{t(data ? 'error.title' : 'error.notFound')}</p>
        <Button onClick={() => refetch()}>{t('error.retry')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Back link preserving list state */}
      <Link
        href={`/people${fromParams ? `?${fromParams}` : ''}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <ContributorHeader
        contributor={data.contributor}
        identityHealth={data.identityHealth}
        onMergeClick={() => setMergeOpen(true)}
      />

      <ContributorKpiSummary
        totalCommits={data.summaryMetrics.totalCommits}
        activeRepositoryCount={data.summaryMetrics.activeRepositoryCount}
        lastActivityAt={data.summaryMetrics.lastActivityAt}
      />

      <ContributorAliasesPanel
        contributorId={data.contributor.id}
        aliases={data.aliases}
        potentialMatches={data.potentialMatches}
      />

      <ContributorRepoBreakdown repositories={data.repositoryBreakdown} />

      <ContributorCommitEvidence contributorId={data.contributor.id} />

      <ContributorMergeModal
        contributorId={data.contributor.id}
        open={mergeOpen}
        onOpenChange={setMergeOpen}
      />
    </div>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/app/\[locale\]/\(dashboard\)/people/\[id\]/
git commit -m "feat(ui): add Contributor Detail page with header, KPI, aliases, repos, commits, and merge modal"
```

---

## Task 13: Verify & Lint

**Files:** All created/modified files

- [ ] **Step 1: Run Prisma generate to ensure types are up to date**

```bash
cd packages/server && pnpm db:generate
```

Expected: No errors

- [ ] **Step 2: Run TypeScript type check**

```bash
cd packages/server && pnpm exec tsc --noEmit
```

Expected: No type errors. If there are errors, fix them — they likely involve import paths or missing types.

- [ ] **Step 3: Run lint**

```bash
cd packages/server && pnpm lint
```

Expected: No errors. Fix any issues found.

- [ ] **Step 4: Run all tests**

```bash
cd packages/server && pnpm test
```

Expected: All tests pass, including the new workspace-service and contributor-identity tests.

- [ ] **Step 5: Build**

```bash
cd packages/server && pnpm build
```

Expected: Successful build.

- [ ] **Step 6: Commit any fixes**

```bash
git add -u
git commit -m "fix: resolve lint and type errors from contributor foundation implementation"
```

---

## Task 14: Manual Verification

This task verifies the implementation works end-to-end.

- [ ] **Step 1: Start dev server**

```bash
cd packages/server && pnpm dev
```

Start the dev server manually. Verify it starts without errors and shows `Ready` in output. Stop with Ctrl+C when done verifying.

- [ ] **Step 2: Run backfill**

```bash
cd packages/server && npx tsx scripts/backfill-contributors.ts
```

Expected: Reports users/orders processed, shows contributor/alias counts.

- [ ] **Step 3: Verify People page loads**

Navigate to `http://localhost:3000/people` (or `/en/people`). Verify:
- Page renders with contributors table
- Summary strip shows counts
- Filters work
- Identity Queue panel shows if unresolved aliases exist
- Quick actions dropdown works on rows

- [ ] **Step 4: Verify Contributor Detail page loads**

Click a contributor row. Verify:
- Back link works and preserves list state
- Header shows name, email, classification
- KPI cards show commit count, repo count, last activity
- Aliases panel shows attached aliases
- Repository breakdown table renders
- Commit evidence table loads with pagination
- Actions dropdown (exclude, classify, merge) works

- [ ] **Step 5: Verify sidebar**

Verify People item appears in sidebar between Orders and Publications.

- [ ] **Step 6: Verify existing pages still work**

Navigate to `/dashboard`, `/orders`, an existing order detail. Verify nothing is broken.

- [ ] **Step 7: Commit any remaining fixes**

```bash
git add -u
git commit -m "fix: address manual verification findings"
```
