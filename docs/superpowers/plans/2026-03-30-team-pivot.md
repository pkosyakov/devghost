# Team Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce Team and TeamMembership as workspace-scoped entities with CRUD APIs, activity-derived repositories, and team list/detail UI pages.

**Architecture:** Prisma models for Team/TeamMembership with effective-date membership. Service layer handles business logic (membership overlap, activity derivation). V2 API routes follow existing contributor/repository patterns. UI pages follow existing repository list/detail patterns with next-intl translations.

**Tech Stack:** Prisma, Zod, Next.js App Router, TanStack Query, shadcn/ui, next-intl, vitest

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/schemas/team.ts` | Zod schemas for team API validation |
| `src/lib/services/team-service.ts` | Team CRUD, membership, activity-derived repos |
| `src/lib/services/team-service.test.ts` | Service unit tests |
| `src/app/api/v2/teams/route.ts` | GET list + POST create |
| `src/app/api/v2/teams/[id]/route.ts` | GET detail + PATCH update + DELETE |
| `src/app/api/v2/teams/[id]/members/route.ts` | POST add member |
| `src/app/api/v2/teams/[id]/members/[membershipId]/route.ts` | PATCH update + DELETE remove membership |
| `src/app/api/v2/teams/[id]/repositories/route.ts` | GET activity-derived repos |
| `src/app/[locale]/(dashboard)/teams/page.tsx` | Teams list page |
| `src/app/[locale]/(dashboard)/teams/components/team-summary-strip.tsx` | Summary cards |
| `src/app/[locale]/(dashboard)/teams/components/team-table.tsx` | Teams table |
| `src/app/[locale]/(dashboard)/teams/components/team-filters.tsx` | Search/sort controls |
| `src/app/[locale]/(dashboard)/teams/components/create-team-dialog.tsx` | Create team modal |
| `src/app/[locale]/(dashboard)/teams/[id]/page.tsx` | Team detail page |
| `src/app/[locale]/(dashboard)/teams/[id]/components/team-header.tsx` | Team name + metadata |
| `src/app/[locale]/(dashboard)/teams/[id]/components/team-kpi-summary.tsx` | KPI cards |
| `src/app/[locale]/(dashboard)/teams/[id]/components/team-contributors.tsx` | Members table |
| `src/app/[locale]/(dashboard)/teams/[id]/components/team-repositories.tsx` | Activity-derived repos table |
| `src/app/[locale]/(dashboard)/teams/[id]/components/add-member-dialog.tsx` | Add member modal |
| `src/app/[locale]/(dashboard)/teams/[id]/components/edit-membership-dialog.tsx` | Edit membership dates/primary/role |

### Modified Files

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add Team, TeamMembership models + relations |
| `src/components/layout/sidebar.tsx` | Add Teams nav item |
| `src/proxy.ts` | Add `/teams` to PROTECTED_PREFIXES |
| `messages/en.json` | Add `teams`, `teamDetail` i18n namespaces |
| `messages/ru.json` | Add `teams`, `teamDetail` i18n namespaces |

All paths relative to `packages/server/`.

---

### Task 1: Prisma Schema — Team and TeamMembership Models

**Files:**
- Modify: `packages/server/prisma/schema.prisma`

- [ ] **Step 1: Add Team and TeamMembership models to schema**

Add after the `Repository` model block (after line ~186) in `schema.prisma`:

```prisma
// ==================== TEAM ====================

model Team {
  id            String           @id @default(cuid())
  workspaceId   String
  workspace     Workspace        @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  name          String
  description   String?

  memberships   TeamMembership[]

  createdAt     DateTime         @default(now())
  updatedAt     DateTime         @updatedAt

  @@unique([workspaceId, name])
  @@index([workspaceId])
}

model TeamMembership {
  id             String       @id @default(cuid())
  teamId         String
  team           Team         @relation(fields: [teamId], references: [id], onDelete: Cascade)

  contributorId  String
  contributor    Contributor  @relation(fields: [contributorId], references: [id], onDelete: Cascade)

  effectiveFrom  DateTime     @default(now())
  effectiveTo    DateTime?
  isPrimary      Boolean      @default(false)
  role           String?

  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@unique([teamId, contributorId, effectiveFrom])
  @@index([teamId])
  @@index([contributorId])
  @@index([teamId, effectiveFrom, effectiveTo])
}
```

- [ ] **Step 2: Add reverse relations to Workspace and Contributor models**

In the `Workspace` model, add after the `repositories` relation:

```prisma
  teams        Team[]
```

In the `Contributor` model, add after the `auditLogs` relation:

```prisma
  teamMemberships TeamMembership[]
```

- [ ] **Step 3: Create migration and generate client**

Run:
```powershell
cd packages/server
npx prisma migrate dev --name add_team_and_team_membership
```

This creates a migration file under `prisma/migrations/`, applies it to the local DB, and regenerates the Prisma client in one step.

Expected: Migration created and applied. Output includes "Your database is now in sync with your schema."

- [ ] **Step 4: Verify migration file exists and contains expected DDL**

Run:
```powershell
ls packages/server/prisma/migrations/ | Select-String "team"
```

Expected: A directory like `20260330XXXXXX_add_team_and_team_membership` exists.

Verify the generated DDL contains the expected tables and constraints:
```powershell
rg "CREATE TABLE.*Team" packages/server/prisma/migrations/ --glob "*.sql"
rg "UNIQUE.*workspaceId.*name" packages/server/prisma/migrations/ --glob "*.sql"
rg "UNIQUE.*teamId.*contributorId.*effectiveFrom" packages/server/prisma/migrations/ --glob "*.sql"
```

Expected: Each `rg` command returns at least one match confirming the `Team` table, workspace-name uniqueness, and membership composite unique constraint exist in the migration SQL.

> **Rollout rule:**
> - **Local dev:** `npx prisma migrate dev` (creates + applies migration, regenerates client)
> - **Staging / production:** `npx prisma migrate deploy` (applies pending migrations only, no client generation)
> - **Never use `db:push`** for this migration — it skips migration history and can cause drift between environments.

- [ ] **Step 5: Commit schema and migration together**

```bash
git add packages/server/prisma/schema.prisma packages/server/prisma/migrations/
git commit -m "feat(schema): add Team and TeamMembership models with migration"
```

---

### Task 2: Zod Validation Schemas

**Files:**
- Create: `packages/server/src/lib/schemas/team.ts`

- [ ] **Step 1: Create team validation schemas**

```typescript
import { z } from 'zod';

export const teamListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  sort: z.enum(['name', 'memberCount', 'activeRepositoryCount', 'lastActivityAt', 'createdAt']).default('name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  search: z.string().optional(),
});

export const createTeamBodySchema = z.object({
  name: z.string().min(1).max(100).trim(),
  description: z.string().max(500).optional(),
});

export const updateTeamBodySchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).nullable().optional(),
});

export const addMemberBodySchema = z.object({
  contributorId: z.string().min(1),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  isPrimary: z.boolean().optional().default(false),
  role: z.string().max(100).optional(),
});

export const updateMemberBodySchema = z.object({
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  isPrimary: z.boolean().optional(),
  role: z.string().max(100).nullable().optional(),
});

export const teamRepositoriesQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/lib/schemas/team.ts
git commit -m "feat: add Zod validation schemas for team APIs"
```

---

### Task 3: Team Service — Core Business Logic

**Files:**
- Create: `packages/server/src/lib/services/team-service.ts`

- [ ] **Step 1: Create team service with CRUD operations**

```typescript
import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { Prisma } from '@prisma/client';

const log = logger.child({ service: 'team' });

// ── Helpers ──

/** Check whether two date ranges overlap. Open-ended (null) effectiveTo = still active. */
function rangesOverlap(
  aFrom: Date, aTo: Date | null,
  bFrom: Date, bTo: Date | null,
): boolean {
  if (aTo && aTo < bFrom) return false;
  if (bTo && bTo < aFrom) return false;
  return true;
}

// ── List teams with summary (contract: TeamSummaryRow) ──

export async function listTeams(
  workspaceId: string,
  opts: {
    page: number;
    pageSize: number;
    sort: string;
    sortOrder: 'asc' | 'desc';
    search?: string;
  },
) {
  const where: Prisma.TeamWhereInput = { workspaceId };

  if (opts.search) {
    where.OR = [
      { name: { contains: opts.search, mode: 'insensitive' } },
      { description: { contains: opts.search, mode: 'insensitive' } },
    ];
  }

  // Two-path query strategy:
  // - DB-sortable fields (name, createdAt): use Prisma orderBy + skip/take for efficiency.
  // - Derived fields (memberCount, activeRepositoryCount, lastActivityAt): fetch ALL matching
  //   teams, enrich in-memory, sort, then slice — otherwise sorting only reorders the current
  //   page, breaking list-contract semantics.
  const isDerivedSort = ['memberCount', 'activeRepositoryCount', 'lastActivityAt'].includes(opts.sort);

  const include = {
    memberships: {
      select: {
        contributorId: true,
        effectiveFrom: true,
        effectiveTo: true,
        contributor: {
          select: {
            aliases: { select: { email: true } },
          },
        },
      },
    },
  };

  const [total, teams] = await Promise.all([
    prisma.team.count({ where }),
    prisma.team.findMany({
      where,
      include,
      // DB-level sort + pagination only for DB-sortable fields
      ...(!isDerivedSort
        ? {
            orderBy: { [opts.sort]: opts.sortOrder },
            skip: (opts.page - 1) * opts.pageSize,
            take: opts.pageSize,
          }
        : {}),
    }),
  ]);

  // Collect all member emails across all fetched teams for a single commit query
  const allEmails = new Set<string>();
  for (const t of teams) {
    for (const m of t.memberships) {
      for (const a of m.contributor.aliases) {
        allEmails.add(a.email);
      }
    }
  }

  // Fetch commit activity for all team members in one query
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  let commitsByEmail = new Map<string, { repos: Set<string>; lastDate: Date | null }>();

  if (workspace && allEmails.size > 0) {
    const commits = await prisma.commitAnalysis.findMany({
      where: {
        authorEmail: { in: Array.from(allEmails) },
        order: { userId: workspace.ownerId },
      },
      select: { authorEmail: true, repository: true, authorDate: true },
    });

    for (const c of commits) {
      const entry = commitsByEmail.get(c.authorEmail) ?? { repos: new Set(), lastDate: null };
      entry.repos.add(c.repository);
      if (c.authorDate && (!entry.lastDate || c.authorDate > entry.lastDate)) {
        entry.lastDate = c.authorDate;
      }
      commitsByEmail.set(c.authorEmail, entry);
    }
  }

  // Build enriched rows
  const now = new Date();
  const rows = teams.map((t) => {
    const activeMemberships = t.memberships.filter(
      (m) => !m.effectiveTo || m.effectiveTo >= now,
    );
    const activeContributorIds = new Set(activeMemberships.map((m) => m.contributorId));

    // Derive repos and lastActivity from member emails
    const teamRepos = new Set<string>();
    let lastActivityAt: Date | null = null;
    for (const m of t.memberships) {
      for (const a of m.contributor.aliases) {
        const activity = commitsByEmail.get(a.email);
        if (activity) {
          for (const repo of activity.repos) teamRepos.add(repo);
          if (activity.lastDate && (!lastActivityAt || activity.lastDate > lastActivityAt)) {
            lastActivityAt = activity.lastDate;
          }
        }
      }
    }

    // memberCount = unique contributors, not raw membership rows (re-entries create multiple rows)
    const uniqueContributorIds = new Set(t.memberships.map((m) => m.contributorId));

    return {
      teamId: t.id,
      name: t.name,
      description: t.description,
      memberCount: uniqueContributorIds.size,
      activeContributorCount: activeContributorIds.size,
      activeRepositoryCount: teamRepos.size,
      lastActivityAt,
      healthStatus: null, // Slice 3 placeholder — real healthStatus deferred to Slice 4+
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  });

  // In-memory sort + paginate for derived fields.
  // For derived sorts we fetched ALL matching teams above, so sort is globally correct.
  if (isDerivedSort) {
    rows.sort((a, b) => {
      let va: number, vb: number;
      if (opts.sort === 'lastActivityAt') {
        va = a.lastActivityAt?.getTime() ?? 0;
        vb = b.lastActivityAt?.getTime() ?? 0;
      } else if (opts.sort === 'activeRepositoryCount') {
        va = a.activeRepositoryCount;
        vb = b.activeRepositoryCount;
      } else {
        // memberCount — distinct contributors, consistent with row value
        va = a.memberCount;
        vb = b.memberCount;
      }
      return opts.sortOrder === 'asc' ? va - vb : vb - va;
    });
    // Slice to the requested page (skip/take was omitted from the DB query)
    const start = (opts.page - 1) * opts.pageSize;
    rows.splice(0, start);
    rows.splice(opts.pageSize);
  }

  // Compute workspace-wide summary — all three values use workspace scope,
  // not the search-filtered `where`, so the summary strip stays consistent
  // regardless of active search/filter state.
  const [wsTeamCount, activeTeamIds, allMemberedContributors] = await Promise.all([
    prisma.team.count({ where: { workspaceId } }),
    prisma.teamMembership.findMany({
      where: { team: { workspaceId }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }] },
      select: { teamId: true },
      distinct: ['teamId'],
    }),
    prisma.teamMembership.findMany({
      where: { team: { workspaceId } },
      select: { contributorId: true },
      distinct: ['contributorId'],
    }),
  ]);

  return {
    teams: rows,
    pagination: {
      page: opts.page,
      pageSize: opts.pageSize,
      total, // search-filtered count — used for pagination only
      totalPages: Math.ceil(total / opts.pageSize),
    },
    summary: {
      teamCount: wsTeamCount,              // workspace-wide
      activeTeamCount: activeTeamIds.length, // workspace-wide
      memberedContributorCount: allMemberedContributors.length, // workspace-wide
    },
  };
}

// ── Create team ──

export async function createTeam(
  workspaceId: string,
  data: { name: string; description?: string },
) {
  const team = await prisma.team.create({
    data: {
      workspaceId,
      name: data.name,
      description: data.description,
    },
  });
  log.info({ teamId: team.id, workspaceId }, 'Team created');
  return team;
}

// ── Get team detail (contract: TeamDetail) ──

export async function getTeamDetail(
  teamId: string,
  workspaceId: string,
  scopeRange?: { from?: Date; to?: Date },
) {
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
    include: {
      memberships: {
        include: {
          contributor: {
            select: {
              id: true,
              displayName: true,
              primaryEmail: true,
              classification: true,
              isExcluded: true,
            },
          },
        },
        orderBy: { effectiveFrom: 'asc' },
      },
    },
  });

  if (!team) return null;

  const contributors = team.memberships.map((m) => ({
    membershipId: m.id,
    contributorId: m.contributor.id,
    displayName: m.contributor.displayName,
    primaryEmail: m.contributor.primaryEmail,
    classification: m.contributor.classification,
    isExcluded: m.contributor.isExcluded,
    effectiveFrom: m.effectiveFrom,
    effectiveTo: m.effectiveTo,
    isPrimary: m.isPrimary,
    role: m.role,
  }));

  // scopeInfo — local query-param scope for Slice 3
  const scopeInfo = {
    source: 'local' as const,
    dateRange: {
      start: scopeRange?.from?.toISOString() ?? null,
      end: scopeRange?.to?.toISOString() ?? null,
    },
  };

  // summaryMetrics — compute from activity-derived data
  const reposResult = await getTeamRepositories(teamId, workspaceId, scopeRange);
  const repositories = reposResult?.repositories ?? [];

  const now = new Date();
  const activeContributorIds = new Set(
    team.memberships
      .filter((m) => !m.effectiveTo || m.effectiveTo >= now)
      .map((m) => m.contributor.id),
  );

  const lastActivityAt = repositories.length > 0
    ? repositories.reduce((max, r) => {
        const d = r.lastActivityAt;
        return d && (!max || d > max) ? d : max;
      }, null as Date | null)
    : null;

  // memberCount = unique contributors (consistent with list row semantics)
  const uniqueMemberIds = new Set(team.memberships.map((m) => m.contributor.id));

  const summaryMetrics = {
    memberCount: uniqueMemberIds.size,
    activeContributorCount: activeContributorIds.size,
    activeRepositoryCount: repositories.length,
    lastActivityAt,
  };

  return {
    team: {
      id: team.id,
      name: team.name,
      description: team.description,
      createdAt: team.createdAt,
      updatedAt: team.updatedAt,
    },
    scopeInfo,
    summaryMetrics,
    contributors,
    repositories,
  };
}

// ── Update team metadata ──

export async function updateTeam(
  teamId: string,
  workspaceId: string,
  data: { name?: string; description?: string | null },
) {
  return prisma.team.updateMany({
    where: { id: teamId, workspaceId },
    data,
  });
}

// ── Delete team ──

export async function deleteTeam(teamId: string, workspaceId: string) {
  return prisma.team.deleteMany({
    where: { id: teamId, workspaceId },
  });
}

// ── Add membership ──

export async function addMember(
  teamId: string,
  workspaceId: string,
  data: {
    contributorId: string;
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    isPrimary?: boolean;
    role?: string;
  },
) {
  // Verify team belongs to workspace
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
  });
  if (!team) return { error: 'Team not found' as const };

  // Verify contributor belongs to same workspace
  const contributor = await prisma.contributor.findFirst({
    where: { id: data.contributorId, workspaceId },
  });
  if (!contributor) return { error: 'Contributor not found' as const };

  const newFrom = data.effectiveFrom ?? new Date();
  const newTo = data.effectiveTo ?? null;

  // Reject overlapping memberships for same contributor in same team.
  // This is a domain invariant: a contributor cannot have two active
  // memberships in the same team at the same time.
  const existingInTeam = await prisma.teamMembership.findMany({
    where: { teamId, contributorId: data.contributorId },
  });
  const hasOverlap = existingInTeam.some((m) =>
    rangesOverlap(m.effectiveFrom, m.effectiveTo, newFrom, newTo),
  );
  if (hasOverlap) {
    return { error: 'Membership overlaps with an existing membership in this team' as const };
  }

  // If isPrimary, only unset other primary memberships whose date ranges
  // overlap with the new membership — preserve historical primary assignments.
  if (data.isPrimary) {
    const overlapping = await prisma.teamMembership.findMany({
      where: { contributorId: data.contributorId, isPrimary: true },
    });
    const toUnset = overlapping
      .filter((m) => rangesOverlap(m.effectiveFrom, m.effectiveTo, newFrom, newTo))
      .map((m) => m.id);
    if (toUnset.length > 0) {
      await prisma.teamMembership.updateMany({
        where: { id: { in: toUnset } },
        data: { isPrimary: false },
      });
    }
  }

  const membership = await prisma.teamMembership.create({
    data: {
      teamId,
      contributorId: data.contributorId,
      effectiveFrom: newFrom,
      effectiveTo: newTo,
      isPrimary: data.isPrimary ?? false,
      role: data.role,
    },
    include: {
      contributor: {
        select: { id: true, displayName: true, primaryEmail: true },
      },
    },
  });

  log.info(
    { teamId, contributorId: data.contributorId, membershipId: membership.id },
    'Member added to team',
  );
  return { membership };
}

// ── Update membership ──

export async function updateMembership(
  membershipId: string,
  teamId: string,
  workspaceId: string,
  data: {
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    isPrimary?: boolean;
    role?: string | null;
  },
) {
  // Verify team belongs to workspace
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
  });
  if (!team) return { error: 'Team not found' as const };

  const membership = await prisma.teamMembership.findFirst({
    where: { id: membershipId, teamId },
  });
  if (!membership) return { error: 'Membership not found' as const };

  // If dates are changing, check for overlap with other memberships in the same team
  const effectiveFrom = data.effectiveFrom ?? membership.effectiveFrom;
  const effectiveTo = data.effectiveTo !== undefined ? data.effectiveTo : membership.effectiveTo;

  if (data.effectiveFrom !== undefined || data.effectiveTo !== undefined) {
    const siblings = await prisma.teamMembership.findMany({
      where: { teamId, contributorId: membership.contributorId, id: { not: membershipId } },
    });
    const hasOverlap = siblings.some((m) =>
      rangesOverlap(m.effectiveFrom, m.effectiveTo, effectiveFrom, effectiveTo),
    );
    if (hasOverlap) {
      return { error: 'Updated dates would overlap with another membership in this team' as const };
    }
  }

  // If setting isPrimary, only unset other overlapping primary memberships
  if (data.isPrimary) {
    const overlapping = await prisma.teamMembership.findMany({
      where: {
        contributorId: membership.contributorId,
        isPrimary: true,
        id: { not: membershipId },
      },
    });
    const toUnset = overlapping
      .filter((m) => rangesOverlap(m.effectiveFrom, m.effectiveTo, effectiveFrom, effectiveTo))
      .map((m) => m.id);
    if (toUnset.length > 0) {
      await prisma.teamMembership.updateMany({
        where: { id: { in: toUnset } },
        data: { isPrimary: false },
      });
    }
  }

  const updated = await prisma.teamMembership.update({
    where: { id: membershipId },
    data,
  });

  log.info({ membershipId, teamId }, 'Membership updated');
  return { membership: updated };
}

// ── Remove membership ──

export async function removeMembership(
  membershipId: string,
  teamId: string,
  workspaceId: string,
) {
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
  });
  if (!team) return { error: 'Team not found' as const };

  const deleted = await prisma.teamMembership.deleteMany({
    where: { id: membershipId, teamId },
  });

  if (deleted.count === 0) return { error: 'Membership not found' as const };

  log.info({ membershipId, teamId }, 'Membership removed');
  return { success: true };
}

// ── Activity-derived repositories (point-in-time attribution) ──

export async function getTeamRepositories(
  teamId: string,
  workspaceId: string,
  dateRange?: { from?: Date; to?: Date },
) {
  // Get team with memberships + contributor aliases
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
    include: {
      memberships: {
        select: {
          contributorId: true,
          effectiveFrom: true,
          effectiveTo: true,
          contributor: {
            select: {
              aliases: { select: { email: true } },
            },
          },
        },
      },
    },
  });
  if (!team) return null;

  if (team.memberships.length === 0) {
    return { repositories: [] };
  }

  // Filter memberships that overlap with the requested date range
  const activeMemberships = team.memberships.filter((m) => {
    if (dateRange?.from && m.effectiveTo && m.effectiveTo < dateRange.from) return false;
    if (dateRange?.to && m.effectiveFrom > dateRange.to) return false;
    return true;
  });

  if (activeMemberships.length === 0) {
    return { repositories: [] };
  }

  // Build per-email attribution windows.
  // Each email gets the tightest window: intersection of (membership range) and (query range).
  // A single email may appear in multiple memberships — take the union of windows.
  const emailWindows = new Map<string, { from: Date; to: Date | null }[]>();

  for (const m of activeMemberships) {
    const winFrom = dateRange?.from && dateRange.from > m.effectiveFrom
      ? dateRange.from
      : m.effectiveFrom;
    const winTo = m.effectiveTo
      ? (dateRange?.to && dateRange.to < m.effectiveTo ? dateRange.to : m.effectiveTo)
      : (dateRange?.to ?? null);

    for (const alias of m.contributor.aliases) {
      const existing = emailWindows.get(alias.email) ?? [];
      existing.push({ from: winFrom, to: winTo });
      emailWindows.set(alias.email, existing);
    }
  }

  const allEmails = Array.from(emailWindows.keys());
  if (allEmails.length === 0) {
    return { repositories: [] };
  }

  // Fetch qualifying commits — broad email+owner filter, then refine in-memory
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return { repositories: [] };

  const broadWhere: Prisma.CommitAnalysisWhereInput = {
    authorEmail: { in: allEmails },
    order: { userId: workspace.ownerId },
  };
  // Apply the overall date range bounds to narrow the DB query
  if (dateRange?.from) {
    broadWhere.authorDate = { gte: dateRange.from };
  }
  if (dateRange?.to) {
    broadWhere.authorDate = { ...broadWhere.authorDate as any, lte: dateRange.to };
  }

  const commits = await prisma.commitAnalysis.findMany({
    where: broadWhere,
    select: {
      repository: true,
      authorEmail: true,
      authorDate: true,
      commitHash: true,
    },
  });

  // Point-in-time filter: keep only commits whose authorDate falls inside
  // at least one attribution window for that email.
  const qualifying = commits.filter((c) => {
    if (!c.authorDate) return false;
    const windows = emailWindows.get(c.authorEmail);
    if (!windows) return false;
    return windows.some((w) => {
      if (c.authorDate! < w.from) return false;
      if (w.to && c.authorDate! > w.to) return false;
      return true;
    });
  });

  // Deduplicate by commitHash per repository
  const seen = new Set<string>();
  const unique = qualifying.filter((c) => {
    const key = `${c.repository}:${c.commitHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Aggregate by repository
  const repoAgg = new Map<string, { commitCount: number; emails: Set<string>; lastDate: Date | null }>();
  for (const c of unique) {
    const agg = repoAgg.get(c.repository) ?? { commitCount: 0, emails: new Set(), lastDate: null };
    agg.commitCount++;
    agg.emails.add(c.authorEmail);
    if (c.authorDate && (!agg.lastDate || c.authorDate > agg.lastDate)) {
      agg.lastDate = c.authorDate;
    }
    repoAgg.set(c.repository, agg);
  }

  // Match against canonical Repository records
  const repoNames = Array.from(repoAgg.keys());
  const canonicalRepos = await prisma.repository.findMany({
    where: { workspaceId, fullName: { in: repoNames } },
  });
  const repoLookup = new Map(canonicalRepos.map((r) => [r.fullName, r]));

  const repositories = Array.from(repoAgg.entries())
    .sort((a, b) => b[1].commitCount - a[1].commitCount)
    .map(([fullName, agg]) => {
      const canonical = repoLookup.get(fullName);
      return {
        repositoryId: canonical?.id ?? null,
        fullName,
        language: canonical?.language ?? null,
        isPrivate: canonical?.isPrivate ?? false,
        activeCommitCount: agg.commitCount,
        activeContributorCount: agg.emails.size,
        lastActivityAt: agg.lastDate,
      };
    });

  return { repositories };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/lib/services/team-service.ts
git commit -m "feat: add team service with CRUD, membership, and activity-derived repos"
```

---

### Task 4: Team Service Tests

**Files:**
- Create: `packages/server/src/lib/services/team-service.test.ts`

- [ ] **Step 1: Write team service unit tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPrisma = vi.hoisted(() => ({
  team: {
    count: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  teamMembership: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  contributor: {
    findFirst: vi.fn(),
  },
  contributorAlias: {
    findMany: vi.fn(),
  },
  workspace: {
    findUnique: vi.fn(),
  },
  commitAnalysis: {
    findMany: vi.fn(),
    groupBy: vi.fn(),
  },
  repository: {
    findMany: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

import {
  listTeams,
  createTeam,
  getTeamDetail,
  updateTeam,
  deleteTeam,
  addMember,
  updateMembership,
  removeMembership,
  getTeamRepositories,
} from './team-service';

describe('team-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listTeams', () => {
    it('returns enriched TeamSummaryRows matching contract shape', async () => {
      const now = new Date();
      const commitDate = new Date('2025-09-15');
      // First count call: search-filtered total; second: workspace-wide summary
      mockPrisma.team.count.mockResolvedValue(1);
      mockPrisma.team.findMany.mockResolvedValue([
        {
          id: 't1', name: 'Frontend', description: null,
          createdAt: now, updatedAt: now,
          memberships: [
            { contributorId: 'c1', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'alice@co.com' }] } },
            { contributorId: 'c2', effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2025-06-01'), contributor: { aliases: [{ email: 'bob@co.com' }] } },
          ],
        },
      ]);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([
        { authorEmail: 'alice@co.com', repository: 'org/frontend', authorDate: commitDate },
        { authorEmail: 'alice@co.com', repository: 'org/shared', authorDate: new Date('2025-08-01') },
      ]);
      // Summary queries: activeTeamIds, memberedContributors
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([{ teamId: 't1' }])             // activeTeamIds
        .mockResolvedValueOnce([{ contributorId: 'c1' }, { contributorId: 'c2' }]); // memberedContributors

      const result = await listTeams('ws-1', { page: 1, pageSize: 20, sort: 'name', sortOrder: 'asc' });

      expect(result.teams).toHaveLength(1);
      expect(result.teams[0].teamId).toBe('t1');
      expect(result.teams[0].memberCount).toBe(2); // unique contributors (c1, c2)
      expect(result.teams[0].activeContributorCount).toBe(1); // c2 expired
      expect(result.teams[0].activeRepositoryCount).toBe(2);
      expect(result.teams[0].lastActivityAt).toEqual(commitDate);
      expect(result.teams[0].healthStatus).toBeNull(); // Slice 3 placeholder
      // Server-computed summary
      expect(result.summary.teamCount).toBe(1);
      expect(result.summary.activeTeamCount).toBe(1);
      expect(result.summary.memberedContributorCount).toBe(2);
    });

    it('applies search filter', async () => {
      mockPrisma.team.count.mockResolvedValue(0);
      mockPrisma.team.findMany.mockResolvedValue([]);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([])   // activeTeamIds
        .mockResolvedValueOnce([]);  // memberedContributors

      await listTeams('ws-1', { page: 1, pageSize: 20, sort: 'name', sortOrder: 'asc', search: 'front' });

      const where = mockPrisma.team.count.mock.calls[0][0].where;
      expect(where.OR).toBeDefined();
      expect(where.OR[0].name.contains).toBe('front');
    });

    it('sorts by lastActivityAt globally, not per-page', async () => {
      const now = new Date();
      // Three teams — DB returns all of them when sort is a derived field (no skip/take)
      mockPrisma.team.count.mockResolvedValue(3);
      mockPrisma.team.findMany.mockResolvedValue([
        { id: 't1', name: 'Alpha', description: null, createdAt: now, updatedAt: now,
          memberships: [{ contributorId: 'c1', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'a@co.com' }] } }] },
        { id: 't2', name: 'Beta', description: null, createdAt: now, updatedAt: now,
          memberships: [{ contributorId: 'c2', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'b@co.com' }] } }] },
        { id: 't3', name: 'Gamma', description: null, createdAt: now, updatedAt: now,
          memberships: [{ contributorId: 'c3', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'c@co.com' }] } }] },
      ]);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([
        { authorEmail: 'a@co.com', repository: 'org/r1', authorDate: new Date('2025-03-01') },
        { authorEmail: 'b@co.com', repository: 'org/r2', authorDate: new Date('2025-09-01') }, // most recent
        { authorEmail: 'c@co.com', repository: 'org/r3', authorDate: new Date('2025-06-01') },
      ]);
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([{ teamId: 't1' }, { teamId: 't2' }, { teamId: 't3' }])
        .mockResolvedValueOnce([{ contributorId: 'c1' }, { contributorId: 'c2' }, { contributorId: 'c3' }]);

      // Request page 1, pageSize 2, sorted by lastActivityAt desc
      const result = await listTeams('ws-1', { page: 1, pageSize: 2, sort: 'lastActivityAt', sortOrder: 'desc' });

      // Global sort: Beta (Sep) > Gamma (Jun) > Alpha (Mar). Page 1 size 2 = Beta, Gamma.
      expect(result.teams).toHaveLength(2);
      expect(result.teams[0].teamId).toBe('t2'); // Beta — most recent
      expect(result.teams[1].teamId).toBe('t3'); // Gamma
      // Pagination reflects total, not page size
      expect(result.pagination.total).toBe(3);
      expect(result.pagination.totalPages).toBe(2);
    });

    it('sorts by memberCount using distinct contributors, not raw membership rows', async () => {
      const now = new Date();
      mockPrisma.team.count.mockResolvedValue(2);
      mockPrisma.team.findMany.mockResolvedValue([
        { id: 't1', name: 'Alpha', description: null, createdAt: now, updatedAt: now,
          memberships: [
            // Same contributor with re-entry: 2 rows, but 1 unique contributor
            { contributorId: 'c1', effectiveFrom: new Date('2024-01-01'), effectiveTo: new Date('2024-12-31'), contributor: { aliases: [{ email: 'a@co.com' }] } },
            { contributorId: 'c1', effectiveFrom: new Date('2025-06-01'), effectiveTo: null, contributor: { aliases: [{ email: 'a@co.com' }] } },
          ] },
        { id: 't2', name: 'Beta', description: null, createdAt: now, updatedAt: now,
          memberships: [
            // Two distinct contributors: 2 rows, 2 unique
            { contributorId: 'c2', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'b@co.com' }] } },
            { contributorId: 'c3', effectiveFrom: new Date('2025-01-01'), effectiveTo: null, contributor: { aliases: [{ email: 'c@co.com' }] } },
          ] },
      ]);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([]);
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([{ teamId: 't1' }, { teamId: 't2' }])
        .mockResolvedValueOnce([{ contributorId: 'c1' }, { contributorId: 'c2' }, { contributorId: 'c3' }]);

      const result = await listTeams('ws-1', { page: 1, pageSize: 20, sort: 'memberCount', sortOrder: 'desc' });

      // Beta has 2 unique contributors, Alpha has 1 (despite 2 membership rows)
      expect(result.teams[0].teamId).toBe('t2');
      expect(result.teams[0].memberCount).toBe(2);
      expect(result.teams[1].teamId).toBe('t1');
      expect(result.teams[1].memberCount).toBe(1); // NOT 2 (raw row count)
    });
  });

  describe('createTeam', () => {
    it('creates a team in the workspace', async () => {
      const created = { id: 't1', workspaceId: 'ws-1', name: 'Frontend', description: null };
      mockPrisma.team.create.mockResolvedValue(created);

      const result = await createTeam('ws-1', { name: 'Frontend' });

      expect(result).toEqual(created);
      expect(mockPrisma.team.create).toHaveBeenCalledWith({
        data: { workspaceId: 'ws-1', name: 'Frontend', description: undefined },
      });
    });
  });

  describe('getTeamDetail', () => {
    it('returns null for non-existent team', async () => {
      mockPrisma.team.findFirst.mockResolvedValue(null);

      const result = await getTeamDetail('t-999', 'ws-1');
      expect(result).toBeNull();
    });

    it('returns team with contributors, scopeInfo, and summaryMetrics', async () => {
      // getTeamDetail calls getTeamRepositories internally — mock both findFirst calls
      const teamData = {
        id: 't1',
        name: 'Frontend',
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        memberships: [
          {
            id: 'm1',
            contributorId: 'c1',
            effectiveFrom: new Date('2025-01-01'),
            effectiveTo: null,
            isPrimary: true,
            role: 'Lead',
            contributor: {
              id: 'c1',
              displayName: 'Alice',
              primaryEmail: 'alice@co.com',
              classification: 'INTERNAL',
              isExcluded: false,
              aliases: [{ email: 'alice@co.com' }],
            },
          },
        ],
      };
      // First call: getTeamDetail, second call: getTeamRepositories
      mockPrisma.team.findFirst
        .mockResolvedValueOnce(teamData)
        .mockResolvedValueOnce(teamData);
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([]);
      mockPrisma.repository.findMany.mockResolvedValue([]);

      const result = await getTeamDetail('t1', 'ws-1');

      expect(result!.contributors).toHaveLength(1);
      expect(result!.contributors[0].displayName).toBe('Alice');
      expect(result!.contributors[0].isPrimary).toBe(true);
      expect(result!.scopeInfo).toBeDefined();
      expect(result!.scopeInfo.source).toBe('local');
      expect(result!.summaryMetrics).toBeDefined();
      expect(result!.summaryMetrics.memberCount).toBe(1);
      expect(result!.summaryMetrics.activeContributorCount).toBe(1);
      expect(result!.repositories).toBeDefined();
    });
  });

  describe('addMember', () => {
    it('returns error if team not found', async () => {
      mockPrisma.team.findFirst.mockResolvedValue(null);

      const result = await addMember('t-999', 'ws-1', { contributorId: 'c1' });
      expect(result).toEqual({ error: 'Team not found' });
    });

    it('returns error if contributor not found', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.contributor.findFirst.mockResolvedValue(null);

      const result = await addMember('t1', 'ws-1', { contributorId: 'c-999' });
      expect(result).toEqual({ error: 'Contributor not found' });
    });

    it('rejects overlapping membership in the same team', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.contributor.findFirst.mockResolvedValue({ id: 'c1' });
      // Existing membership: 2025-01-01 to 2025-12-31
      mockPrisma.teamMembership.findMany.mockResolvedValue([
        { id: 'm-existing', teamId: 't1', contributorId: 'c1', effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2025-12-31') },
      ]);

      const result = await addMember('t1', 'ws-1', {
        contributorId: 'c1',
        effectiveFrom: new Date('2025-06-01'), // overlaps with existing
      });

      expect(result).toEqual({ error: 'Membership overlaps with an existing membership in this team' });
      expect(mockPrisma.teamMembership.create).not.toHaveBeenCalled();
    });

    it('allows non-overlapping membership in the same team (re-entry)', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.contributor.findFirst.mockResolvedValue({ id: 'c1' });
      // Existing membership ended 2025-06-30
      mockPrisma.teamMembership.findMany.mockResolvedValue([
        { id: 'm-old', teamId: 't1', contributorId: 'c1', effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2025-06-30') },
      ]);
      mockPrisma.teamMembership.create.mockResolvedValue({
        id: 'm-new', teamId: 't1', contributorId: 'c1', isPrimary: false,
        contributor: { id: 'c1', displayName: 'Alice', primaryEmail: 'alice@co.com' },
      });

      const result = await addMember('t1', 'ws-1', {
        contributorId: 'c1',
        effectiveFrom: new Date('2026-01-01'), // no overlap
      });

      expect(result).toHaveProperty('membership');
    });

    it('only unsets overlapping primary memberships when adding as primary', async () => {
      const from2025 = new Date('2025-01-01');
      const from2026 = new Date('2026-01-01');

      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.contributor.findFirst.mockResolvedValue({ id: 'c1' });
      // First findMany call: same-team overlap check — no overlap in THIS team
      // Second findMany call: isPrimary check across ALL teams
      mockPrisma.teamMembership.findMany
        .mockResolvedValueOnce([]) // no same-team overlapping memberships
        .mockResolvedValueOnce([   // primary memberships across all teams
          { id: 'm-old', contributorId: 'c1', effectiveFrom: new Date('2024-01-01'), effectiveTo: new Date('2024-12-31'), isPrimary: true },
          { id: 'm-current', contributorId: 'c1', effectiveFrom: from2025, effectiveTo: null, isPrimary: true },
        ]);
      mockPrisma.teamMembership.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.teamMembership.create.mockResolvedValue({
        id: 'm-new', teamId: 't1', contributorId: 'c1', isPrimary: true,
        contributor: { id: 'c1', displayName: 'Alice', primaryEmail: 'alice@co.com' },
      });

      await addMember('t1', 'ws-1', {
        contributorId: 'c1',
        isPrimary: true,
        effectiveFrom: from2026,
      });

      // Should only unset m-current (overlaps with 2026+), not m-old (ended 2024-12-31)
      expect(mockPrisma.teamMembership.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['m-current'] } },
        data: { isPrimary: false },
      });
    });
  });

  describe('updateMembership', () => {
    it('rejects date change that would overlap with sibling membership', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      // Existing membership being updated: 2025-01-01 to 2025-06-30
      mockPrisma.teamMembership.findFirst.mockResolvedValue({
        id: 'm1', teamId: 't1', contributorId: 'c1',
        effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2025-06-30'),
      });
      // Sibling membership: 2025-07-01 to 2025-12-31
      mockPrisma.teamMembership.findMany.mockResolvedValue([
        { id: 'm2', teamId: 't1', contributorId: 'c1', effectiveFrom: new Date('2025-07-01'), effectiveTo: new Date('2025-12-31') },
      ]);

      const result = await updateMembership('m1', 't1', 'ws-1', {
        effectiveTo: new Date('2025-09-01'), // extends into m2's range
      });

      expect(result).toEqual({ error: 'Updated dates would overlap with another membership in this team' });
      expect(mockPrisma.teamMembership.update).not.toHaveBeenCalled();
    });

    it('accepts date change when ranges do not overlap (re-entry gap preserved)', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.teamMembership.findFirst.mockResolvedValue({
        id: 'm1', teamId: 't1', contributorId: 'c1',
        effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2025-06-30'),
      });
      // Sibling membership: 2026-01-01 onwards — no overlap with m1's dates
      mockPrisma.teamMembership.findMany.mockResolvedValue([
        { id: 'm2', teamId: 't1', contributorId: 'c1', effectiveFrom: new Date('2026-01-01'), effectiveTo: null },
      ]);
      mockPrisma.teamMembership.update.mockResolvedValue({ id: 'm1' });

      const result = await updateMembership('m1', 't1', 'ws-1', {
        effectiveTo: new Date('2025-12-31'), // still before m2
      });

      expect(result).toHaveProperty('membership');
      expect(mockPrisma.teamMembership.update).toHaveBeenCalled();
    });

    it('unsets overlapping isPrimary when promoting to primary', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.teamMembership.findFirst.mockResolvedValue({
        id: 'm1', teamId: 't1', contributorId: 'c1',
        effectiveFrom: new Date('2025-01-01'), effectiveTo: null, isPrimary: false,
      });
      // No siblings in same team (no date overlap check needed when dates unchanged)
      // But there is an existing primary in another team that overlaps
      mockPrisma.teamMembership.findMany.mockResolvedValueOnce([
        { id: 'm-other', contributorId: 'c1', effectiveFrom: new Date('2024-06-01'), effectiveTo: null, isPrimary: true },
      ]);
      mockPrisma.teamMembership.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.teamMembership.update.mockResolvedValue({ id: 'm1', isPrimary: true });

      await updateMembership('m1', 't1', 'ws-1', { isPrimary: true });

      expect(mockPrisma.teamMembership.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['m-other'] } },
        data: { isPrimary: false },
      });
    });
  });

  describe('removeMembership', () => {
    it('returns error if team not in workspace', async () => {
      mockPrisma.team.findFirst.mockResolvedValue(null);

      const result = await removeMembership('m1', 't1', 'ws-1');
      expect(result).toEqual({ error: 'Team not found' });
    });

    it('returns error if membership not found', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1' });
      mockPrisma.teamMembership.deleteMany.mockResolvedValue({ count: 0 });

      const result = await removeMembership('m-999', 't1', 'ws-1');
      expect(result).toEqual({ error: 'Membership not found' });
    });
  });

  describe('getTeamRepositories', () => {
    it('returns empty array when team has no members', async () => {
      mockPrisma.team.findFirst.mockResolvedValue({ id: 't1', memberships: [] });

      const result = await getTeamRepositories('t1', 'ws-1');
      expect(result!.repositories).toEqual([]);
    });

    it('returns null when team not found', async () => {
      mockPrisma.team.findFirst.mockResolvedValue(null);

      const result = await getTeamRepositories('t-999', 'ws-1');
      expect(result).toBeNull();
    });

    it('excludes commits outside membership effective dates (point-in-time)', async () => {
      const memberFrom = new Date('2025-06-01');
      const memberTo = new Date('2025-12-31');

      mockPrisma.team.findFirst.mockResolvedValue({
        id: 't1',
        memberships: [{
          contributorId: 'c1',
          effectiveFrom: memberFrom,
          effectiveTo: memberTo,
          contributor: { aliases: [{ email: 'alice@co.com' }] },
        }],
      });
      mockPrisma.workspace.findUnique.mockResolvedValue({ id: 'ws-1', ownerId: 'u1' });

      // Three commits: before membership, during, and after
      mockPrisma.commitAnalysis.findMany.mockResolvedValue([
        { repository: 'org/repo', authorEmail: 'alice@co.com', authorDate: new Date('2025-03-01'), commitHash: 'aaa' },
        { repository: 'org/repo', authorEmail: 'alice@co.com', authorDate: new Date('2025-07-15'), commitHash: 'bbb' },
        { repository: 'org/repo', authorEmail: 'alice@co.com', authorDate: new Date('2026-02-01'), commitHash: 'ccc' },
      ]);
      mockPrisma.repository.findMany.mockResolvedValue([]);

      const result = await getTeamRepositories('t1', 'ws-1');

      // Only the mid-membership commit should qualify
      expect(result!.repositories).toHaveLength(1);
      expect(result!.repositories[0].activeCommitCount).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run:
```powershell
cd packages/server
pnpm test -- src/lib/services/team-service.test.ts
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/lib/services/team-service.test.ts
git commit -m "test: add team service unit tests"
```

---

### Task 5: Teams List + Create API Routes

**Files:**
- Create: `packages/server/src/app/api/v2/teams/route.ts`

- [ ] **Step 1: Implement GET (list) and POST (create) routes**

```typescript
import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { teamListQuerySchema, createTeamBodySchema } from '@/lib/schemas/team';
import { listTeams, createTeam } from '@/lib/services/team-service';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = teamListQuerySchema.safeParse(params);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const result = await listTeams(workspace.id, parsed.data);
  return apiResponse(result);
}

export async function POST(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const body = await parseBody(request, createTeamBodySchema);
  if (isErrorResponse(body)) return body;

  try {
    const team = await createTeam(workspace.id, body);
    return apiResponse(team, 201);
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return apiError('A team with this name already exists', 409);
    }
    throw err;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/app/api/v2/teams/route.ts
git commit -m "feat: add GET/POST /api/v2/teams routes"
```

---

### Task 6: Team Detail + Update + Delete API Routes

**Files:**
- Create: `packages/server/src/app/api/v2/teams/[id]/route.ts`

- [ ] **Step 1: Implement GET, PATCH, DELETE routes**

```typescript
import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { updateTeamBodySchema, teamRepositoriesQuerySchema } from '@/lib/schemas/team';
import { getTeamDetail, updateTeam, deleteTeam } from '@/lib/services/team-service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  // Optional scope date range from query params (Slice 3 local scope)
  const qp = Object.fromEntries(request.nextUrl.searchParams);
  const scopeParsed = teamRepositoriesQuerySchema.safeParse(qp);
  const scopeRange = scopeParsed.success ? scopeParsed.data : undefined;

  const detail = await getTeamDetail(id, workspace.id, scopeRange);
  if (!detail) {
    return apiError('Team not found', 404);
  }

  return apiResponse(detail);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const body = await parseBody(request, updateTeamBodySchema);
  if (isErrorResponse(body)) return body;

  try {
    const result = await updateTeam(id, workspace.id, body);
    if (result.count === 0) {
      return apiError('Team not found', 404);
    }
    return apiResponse({ success: true });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return apiError('A team with this name already exists', 409);
    }
    throw err;
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const result = await deleteTeam(id, workspace.id);
  if (result.count === 0) {
    return apiError('Team not found', 404);
  }

  return apiResponse({ success: true });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/app/api/v2/teams/[id]/route.ts
git commit -m "feat: add GET/PATCH/DELETE /api/v2/teams/[id] routes"
```

---

### Task 7: Membership Management API Routes

**Files:**
- Create: `packages/server/src/app/api/v2/teams/[id]/members/route.ts`
- Create: `packages/server/src/app/api/v2/teams/[id]/members/[membershipId]/route.ts`

- [ ] **Step 1: Implement POST /api/v2/teams/[id]/members**

```typescript
import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { addMemberBodySchema } from '@/lib/schemas/team';
import { addMember } from '@/lib/services/team-service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const body = await parseBody(request, addMemberBodySchema);
  if (isErrorResponse(body)) return body;

  const result = await addMember(id, workspace.id, body);

  if ('error' in result) {
    const status = result.error.includes('overlap') ? 409 : 404;
    return apiError(result.error, status);
  }

  return apiResponse(result.membership, 201);
}
```

- [ ] **Step 2: Implement PATCH/DELETE /api/v2/teams/[id]/members/[membershipId]**

```typescript
import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { updateMemberBodySchema } from '@/lib/schemas/team';
import { updateMembership, removeMembership } from '@/lib/services/team-service';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; membershipId: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id, membershipId } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const body = await parseBody(request, updateMemberBodySchema);
  if (isErrorResponse(body)) return body;

  const result = await updateMembership(membershipId, id, workspace.id, body);

  if ('error' in result) {
    const status = result.error.includes('overlap') ? 409 : 404;
    return apiError(result.error, status);
  }

  return apiResponse(result.membership);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; membershipId: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id, membershipId } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const result = await removeMembership(membershipId, id, workspace.id);

  if ('error' in result) {
    return apiError(result.error, 404);
  }

  return apiResponse({ success: true });
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/app/api/v2/teams/[id]/members/
git commit -m "feat: add membership management API routes (add/update/remove)"
```

---

### Task 8: Activity-Derived Repositories API Route

**Files:**
- Create: `packages/server/src/app/api/v2/teams/[id]/repositories/route.ts`

- [ ] **Step 1: Implement GET /api/v2/teams/[id]/repositories**

```typescript
import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { teamRepositoriesQuerySchema } from '@/lib/schemas/team';
import { getTeamRepositories } from '@/lib/services/team-service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const qp = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = teamRepositoriesQuerySchema.safeParse(qp);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const result = await getTeamRepositories(id, workspace.id, parsed.data);
  if (!result) {
    return apiError('Team not found', 404);
  }

  return apiResponse(result);
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/app/api/v2/teams/[id]/repositories/route.ts
git commit -m "feat: add GET /api/v2/teams/[id]/repositories — activity-derived repos"
```

---

### Task 9: Navigation, Proxy, and i18n

**Files:**
- Modify: `packages/server/src/components/layout/sidebar.tsx`
- Modify: `packages/server/src/proxy.ts`
- Modify: `packages/server/messages/en.json`
- Modify: `packages/server/messages/ru.json`

- [ ] **Step 1: Add Teams to sidebar navigation**

In `sidebar.tsx`, add `UsersRound` to the lucide-react import (this icon represents a team/group, distinct from `Users` already used for People):

```typescript
import { UsersRound } from 'lucide-react';
```

In the `navigation` array, add after the repositories entry:

```typescript
  { nameKey: 'teams', href: '/teams', icon: UsersRound },
```

- [ ] **Step 2: Add `/teams` to proxy PROTECTED_PREFIXES**

In `proxy.ts`, add `'/teams'` to the `PROTECTED_PREFIXES` array:

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
  '/repositories',
  '/teams',
];
```

- [ ] **Step 3: Add English translations**

Add to `messages/en.json` — add `"teams"` key to `layout.sidebar`:

```json
"teams": "Teams"
```

Add these top-level namespaces (after `"repositories"` and `"repositoryDetail"` blocks):

```json
"teams": {
  "title": "Teams",
  "summary": {
    "total": "Teams",
    "active": "Active Teams",
    "members": "Members"
  },
  "filters": {
    "searchPlaceholder": "Search teams..."
  },
  "table": {
    "name": "Team",
    "members": "Members",
    "repositories": "Repositories",
    "lastActivity": "Last Activity",
    "created": "Created"
  },
  "empty": {
    "title": "No teams yet",
    "description": "Create your first team to start organizing contributors."
  },
  "filteredEmpty": {
    "title": "No teams match your search",
    "reset": "Reset filters"
  },
  "error": {
    "title": "Failed to load teams",
    "retry": "Retry"
  },
  "create": {
    "title": "Create Team",
    "name": "Team name",
    "namePlaceholder": "e.g. Frontend Platform",
    "description": "Description (optional)",
    "descriptionPlaceholder": "What does this team work on?",
    "submit": "Create",
    "success": "Team created",
    "error": "Failed to create team",
    "duplicate": "A team with this name already exists"
  }
},
"teamDetail": {
  "backToList": "Back to Teams",
  "tabs": {
    "overview": "Overview",
    "members": "Members",
    "repositories": "Repositories"
  },
  "kpi": {
    "members": "Members",
    "repositories": "Repositories",
    "lastActivity": "Last Activity"
  },
  "members": {
    "title": "Team Members",
    "name": "Name",
    "email": "Email",
    "role": "Role",
    "primaryTeam": "Primary",
    "effectiveFrom": "From",
    "effectiveTo": "To",
    "actions": "Actions",
    "active": "Active",
    "add": "Add Member",
    "remove": "Remove",
    "edit": "Edit",
    "empty": "No members in this team",
    "removeConfirm": "Remove this member from the team?"
  },
  "repositories": {
    "title": "Active Repositories",
    "description": "Repositories where team members have committed in the selected period.",
    "name": "Repository",
    "commits": "Commits",
    "contributors": "Contributors",
    "lastActivity": "Last Activity",
    "empty": "No repository activity found for this team",
    "dateRange": "Date Range",
    "from": "From",
    "to": "To",
    "apply": "Apply"
  },
  "addMember": {
    "title": "Add Team Member",
    "contributor": "Contributor",
    "contributorPlaceholder": "Search contributors...",
    "effectiveFrom": "Effective from",
    "effectiveTo": "Effective to (optional)",
    "isPrimary": "Set as primary team",
    "role": "Role (optional)",
    "rolePlaceholder": "e.g. Tech Lead",
    "submit": "Add",
    "success": "Member added",
    "error": "Failed to add member",
    "alreadyMember": "This contributor is already a member"
  },
  "editMember": {
    "title": "Edit Membership",
    "submit": "Save",
    "success": "Membership updated",
    "error": "Failed to update membership"
  },
  "error": {
    "title": "Failed to load team",
    "notFound": "Team not found",
    "retry": "Retry"
  },
  "settings": {
    "edit": "Edit Team",
    "delete": "Delete Team",
    "deleteConfirm": "Are you sure? This will remove the team and all memberships.",
    "deleteSuccess": "Team deleted",
    "deleteError": "Failed to delete team",
    "editSuccess": "Team updated",
    "editError": "Failed to update team"
  }
}
```

- [ ] **Step 4: Add Russian translations**

Add to `messages/ru.json` — add `"teams"` key to `layout.sidebar`:

```json
"teams": "Команды"
```

Add these top-level namespaces:

```json
"teams": {
  "title": "Команды",
  "summary": {
    "total": "Команды",
    "active": "Активные команды",
    "members": "Участники"
  },
  "filters": {
    "searchPlaceholder": "Поиск команд..."
  },
  "table": {
    "name": "Команда",
    "members": "Участники",
    "repositories": "Репозитории",
    "lastActivity": "Последняя активность",
    "created": "Создана"
  },
  "empty": {
    "title": "Команд пока нет",
    "description": "Создайте первую команду для организации контрибьюторов."
  },
  "filteredEmpty": {
    "title": "Команд по запросу не найдено",
    "reset": "Сбросить фильтры"
  },
  "error": {
    "title": "Не удалось загрузить команды",
    "retry": "Повторить"
  },
  "create": {
    "title": "Создать команду",
    "name": "Название команды",
    "namePlaceholder": "Напр. Frontend Platform",
    "description": "Описание (необязательно)",
    "descriptionPlaceholder": "Чем занимается команда?",
    "submit": "Создать",
    "success": "Команда создана",
    "error": "Не удалось создать команду",
    "duplicate": "Команда с таким названием уже существует"
  }
},
"teamDetail": {
  "backToList": "Назад к командам",
  "tabs": {
    "overview": "Обзор",
    "members": "Участники",
    "repositories": "Репозитории"
  },
  "kpi": {
    "members": "Участники",
    "repositories": "Репозитории",
    "lastActivity": "Последняя активность"
  },
  "members": {
    "title": "Участники команды",
    "name": "Имя",
    "email": "Email",
    "role": "Роль",
    "primaryTeam": "Основная",
    "effectiveFrom": "С",
    "effectiveTo": "По",
    "actions": "Действия",
    "active": "Активен",
    "add": "Добавить участника",
    "remove": "Удалить",
    "edit": "Редактировать",
    "empty": "В команде пока нет участников",
    "removeConfirm": "Удалить участника из команды?"
  },
  "repositories": {
    "title": "Активные репозитории",
    "description": "Репозитории, в которых участники команды делали коммиты в выбранном периоде.",
    "name": "Репозиторий",
    "commits": "Коммиты",
    "contributors": "Контрибьюторы",
    "lastActivity": "Последняя активность",
    "empty": "Активности по репозиториям не найдено",
    "dateRange": "Период",
    "from": "С",
    "to": "По",
    "apply": "Применить"
  },
  "addMember": {
    "title": "Добавить участника",
    "contributor": "Контрибьютор",
    "contributorPlaceholder": "Поиск контрибьюторов...",
    "effectiveFrom": "Дата начала",
    "effectiveTo": "Дата окончания (необязательно)",
    "isPrimary": "Основная команда",
    "role": "Роль (необязательно)",
    "rolePlaceholder": "Напр. Tech Lead",
    "submit": "Добавить",
    "success": "Участник добавлен",
    "error": "Не удалось добавить участника",
    "alreadyMember": "Контрибьютор уже является участником"
  },
  "editMember": {
    "title": "Редактировать членство",
    "submit": "Сохранить",
    "success": "Членство обновлено",
    "error": "Не удалось обновить членство"
  },
  "error": {
    "title": "Не удалось загрузить команду",
    "notFound": "Команда не найдена",
    "retry": "Повторить"
  },
  "settings": {
    "edit": "Редактировать команду",
    "delete": "Удалить команду",
    "deleteConfirm": "Вы уверены? Команда и все членства будут удалены.",
    "deleteSuccess": "Команда удалена",
    "deleteError": "Не удалось удалить команду",
    "editSuccess": "Команда обновлена",
    "editError": "Не удалось обновить команду"
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/components/layout/sidebar.tsx packages/server/src/proxy.ts packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "feat: add Teams to navigation, proxy protection, and i18n translations"
```

---

### Task 10: Teams List Page

**Files:**
- Create: `packages/server/src/app/[locale]/(dashboard)/teams/page.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/teams/components/team-summary-strip.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/teams/components/team-table.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/teams/components/create-team-dialog.tsx`

- [ ] **Step 1: Create team summary strip component**

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { UsersRound, Users, FolderGit2 } from 'lucide-react';

interface TeamSummaryStripProps {
  teamCount: number;
  activeTeamCount: number;
  memberedContributorCount: number;
}

export function TeamSummaryStrip({ teamCount, activeTeamCount, memberedContributorCount }: TeamSummaryStripProps) {
  const t = useTranslations('teams.summary');

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <UsersRound className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{teamCount}</p>
            <p className="text-sm text-muted-foreground">{t('total')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <UsersRound className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{activeTeamCount}</p>
            <p className="text-sm text-muted-foreground">{t('active')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Users className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{memberedContributorCount}</p>
            <p className="text-sm text-muted-foreground">{t('members')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Create team table component**

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { ArrowUpDown } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface TeamRow {
  teamId: string;
  name: string;
  description: string | null;
  memberCount: number;
  activeRepositoryCount: number;
  lastActivityAt: string | null;
  healthStatus: string | null;
  createdAt: string;
}

interface TeamTableProps {
  teams: TeamRow[];
  sort: string;
  sortOrder: string;
  onSortChange: (field: string) => void;
}

export function TeamTable({ teams, sort, sortOrder, onSortChange }: TeamTableProps) {
  const t = useTranslations('teams.table');

  const SortHeader = ({ field, children }: { field: string; children: React.ReactNode }) => (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 font-medium"
      onClick={() => onSortChange(field)}
    >
      {children}
      <ArrowUpDown className="ml-1 h-3.5 w-3.5" />
      {sort === field && (
        <span className="ml-0.5 text-xs">{sortOrder === 'asc' ? '\u2191' : '\u2193'}</span>
      )}
    </Button>
  );

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <SortHeader field="name">{t('name')}</SortHeader>
          </TableHead>
          <TableHead>
            <SortHeader field="memberCount">{t('members')}</SortHeader>
          </TableHead>
          <TableHead>
            <SortHeader field="activeRepositoryCount">{t('repositories')}</SortHeader>
          </TableHead>
          <TableHead>
            <SortHeader field="lastActivityAt">{t('lastActivity')}</SortHeader>
          </TableHead>
          <TableHead>
            <SortHeader field="createdAt">{t('created')}</SortHeader>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {teams.map((team) => (
          <TableRow key={team.teamId}>
            <TableCell>
              <Link
                href={`/teams/${team.teamId}`}
                className="font-medium hover:underline"
              >
                {team.name}
              </Link>
              {team.description && (
                <p className="text-sm text-muted-foreground truncate max-w-md">
                  {team.description}
                </p>
              )}
            </TableCell>
            <TableCell>{team.memberCount}</TableCell>
            <TableCell>{team.activeRepositoryCount}</TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {team.lastActivityAt
                ? formatDistanceToNow(new Date(team.lastActivityAt), { addSuffix: true })
                : '-'}
            </TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {formatDistanceToNow(new Date(team.createdAt), { addSuffix: true })}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 3: Create the create-team dialog component**

```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { Plus } from 'lucide-react';

export function CreateTeamDialog() {
  const t = useTranslations('teams.create');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/v2/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || undefined }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to create team');
      }
      return json.data;
    },
    onSuccess: () => {
      toast({ description: t('success') });
      queryClient.invalidateQueries({ queryKey: ['teams'] });
      setOpen(false);
      setName('');
      setDescription('');
    },
    onError: (err: Error) => {
      toast({
        variant: 'destructive',
        description: err.message.includes('already exists') ? t('duplicate') : t('error'),
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" />
          {t('title')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="team-name">{t('name')}</Label>
            <Input
              id="team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="team-desc">{t('description')}</Label>
            <Textarea
              id="team-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('descriptionPlaceholder')}
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || mutation.isPending}>
              {t('submit')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Create teams list page**

```tsx
'use client';

import { Suspense, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useRouter, usePathname } from '@/i18n/navigation';
import { useQuery } from '@tanstack/react-query';
import { TeamSummaryStrip } from './components/team-summary-strip';
import { TeamTable } from './components/team-table';
import { CreateTeamDialog } from './components/create-team-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

export default function TeamsPageWrapper() {
  return (
    <Suspense fallback={<div className="space-y-6 p-6"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>}>
      <TeamsPage />
    </Suspense>
  );
}

function TeamsPage() {
  const t = useTranslations('teams');
  const tCommon = useTranslations('common');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const page = Number(searchParams.get('page') || '1');
  const pageSize = Number(searchParams.get('pageSize') || '20');
  const sort = searchParams.get('sort') || 'name';
  const sortOrder = searchParams.get('sortOrder') || 'asc';
  const search = searchParams.get('search') || '';

  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === '' || value === 'all') {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      router.replace(`${pathname}?${params.toString()}`);
    },
    [searchParams, router, pathname],
  );

  const queryParams = new URLSearchParams();
  queryParams.set('page', String(page));
  queryParams.set('pageSize', String(pageSize));
  queryParams.set('sort', sort);
  queryParams.set('sortOrder', sortOrder);
  if (search) queryParams.set('search', search);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['teams', queryParams.toString()],
    queryFn: async () => {
      const res = await fetch(`/api/v2/teams?${queryParams.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
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

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-48" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <p className="text-destructive">{t('error.title')}</p>
        <Button onClick={() => refetch()}>{t('error.retry')}</Button>
      </div>
    );
  }

  if (!data?.teams?.length && !search) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <h2 className="text-xl font-semibold">{t('empty.title')}</h2>
        <p className="text-muted-foreground">{t('empty.description')}</p>
        <CreateTeamDialog />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <CreateTeamDialog />
      </div>

      <TeamSummaryStrip
        teamCount={data?.summary?.teamCount ?? 0}
        activeTeamCount={data?.summary?.activeTeamCount ?? 0}
        memberedContributorCount={data?.summary?.memberedContributorCount ?? 0}
      />

      <Input
        placeholder={t('filters.searchPlaceholder')}
        value={search}
        onChange={(e) => updateParams({ search: e.target.value, page: '1' })}
        className="max-w-sm"
      />

      {data?.teams?.length ? (
        <>
          <TeamTable
            teams={data.teams}
            sort={sort}
            sortOrder={sortOrder}
            onSortChange={handleSortChange}
          />

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {tCommon('totalCount', { count: data.pagination.total })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => updateParams({ page: String(page - 1) })}
              >
                {tCommon('previous')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.pagination.totalPages}
                onClick={() => updateParams({ page: String(page + 1) })}
              >
                {tCommon('next')}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="text-center py-8">
          <p className="text-muted-foreground">{t('filteredEmpty.title')}</p>
          <Button
            variant="link"
            onClick={() => updateParams({ search: '', page: '1' })}
          >
            {t('filteredEmpty.reset')}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/\[locale\]/\(dashboard\)/teams/
git commit -m "feat: add Teams list page with summary strip, table, and create dialog"
```

---

### Task 11: Team Detail Page

**Files:**
- Create: `packages/server/src/app/[locale]/(dashboard)/teams/[id]/page.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/teams/[id]/components/team-header.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/teams/[id]/components/team-kpi-summary.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/teams/[id]/components/team-contributors.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/teams/[id]/components/team-repositories.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/teams/[id]/components/add-member-dialog.tsx`
- Create: `packages/server/src/app/[locale]/(dashboard)/teams/[id]/components/edit-membership-dialog.tsx`

- [ ] **Step 1: Create team header component**

```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/hooks/use-toast';
import { MoreVertical, Pencil, Trash2 } from 'lucide-react';

interface TeamHeaderProps {
  team: {
    id: string;
    name: string;
    description: string | null;
  };
}

export function TeamHeader({ team }: TeamHeaderProps) {
  const t = useTranslations('teamDetail.settings');
  const { toast } = useToast();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? '');

  const updateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/teams/${team.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || null }),
      });
      if (!res.ok) throw new Error('Update failed');
    },
    onSuccess: () => {
      toast({ description: t('editSuccess') });
      queryClient.invalidateQueries({ queryKey: ['team', team.id] });
      setEditing(false);
    },
    onError: () => {
      toast({ variant: 'destructive', description: t('editError') });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/v2/teams/${team.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
    },
    onSuccess: () => {
      toast({ description: t('deleteSuccess') });
      router.push('/teams');
    },
    onError: () => {
      toast({ variant: 'destructive', description: t('deleteError') });
    },
  });

  if (editing) {
    return (
      <div className="space-y-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        <div className="flex gap-2">
          <Button size="sm" onClick={() => updateMutation.mutate()} disabled={!name.trim()}>
            Save
          </Button>
          <Button size="sm" variant="outline" onClick={() => { setEditing(false); setName(team.name); setDescription(team.description ?? ''); }}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between">
      <div>
        <h1 className="text-2xl font-bold">{team.name}</h1>
        {team.description && (
          <p className="text-muted-foreground mt-1">{team.description}</p>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setEditing(true)}>
            <Pencil className="mr-2 h-4 w-4" />
            {t('edit')}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive"
            onClick={() => {
              if (confirm(t('deleteConfirm'))) {
                deleteMutation.mutate();
              }
            }}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

- [ ] **Step 2: Create team KPI summary component**

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Users, FolderGit2, Clock } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface TeamKpiSummaryProps {
  memberCount: number;
  repositoryCount: number;
  lastActivityAt: string | null;
}

export function TeamKpiSummary({ memberCount, repositoryCount, lastActivityAt }: TeamKpiSummaryProps) {
  const t = useTranslations('teamDetail.kpi');

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <Users className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{memberCount}</p>
            <p className="text-sm text-muted-foreground">{t('members')}</p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex items-center gap-3 p-4">
          <FolderGit2 className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-2xl font-bold">{repositoryCount}</p>
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
                : '-'}
            </p>
            <p className="text-sm text-muted-foreground">{t('lastActivity')}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Create team contributors component**

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { Trash2, Pencil, Star } from 'lucide-react';
import { format } from 'date-fns';

interface Membership {
  membershipId: string;
  contributorId: string;
  displayName: string;
  primaryEmail: string;
  classification: string;
  isExcluded: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  isPrimary: boolean;
  role: string | null;
}

interface TeamContributorsProps {
  teamId: string;
  contributors: Membership[];
  onEditMember: (member: Membership) => void;
}

export function TeamContributors({ teamId, contributors, onEditMember }: TeamContributorsProps) {
  const t = useTranslations('teamDetail.members');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const removeMutation = useMutation({
    mutationFn: async (membershipId: string) => {
      const res = await fetch(`/api/v2/teams/${teamId}/members/${membershipId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Remove failed');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team', teamId] });
    },
    onError: () => {
      toast({ variant: 'destructive', description: 'Failed to remove member' });
    },
  });

  if (contributors.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">{t('empty')}</p>
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('name')}</TableHead>
          <TableHead>{t('role')}</TableHead>
          <TableHead>{t('effectiveFrom')}</TableHead>
          <TableHead>{t('effectiveTo')}</TableHead>
          <TableHead>{t('actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {contributors.map((m) => (
          <TableRow key={m.membershipId}>
            <TableCell>
              <div className="flex items-center gap-2">
                <Link
                  href={`/people/${m.contributorId}`}
                  className="font-medium hover:underline"
                >
                  {m.displayName}
                </Link>
                {m.isPrimary && (
                  <Star className="h-3.5 w-3.5 text-yellow-500 fill-yellow-500" />
                )}
                <Badge variant="outline" className="text-xs">
                  {m.classification}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{m.primaryEmail}</p>
            </TableCell>
            <TableCell className="text-sm">{m.role || '-'}</TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {format(new Date(m.effectiveFrom), 'MMM d, yyyy')}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {m.effectiveTo ? format(new Date(m.effectiveTo), 'MMM d, yyyy') : t('active')}
            </TableCell>
            <TableCell>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" onClick={() => onEditMember(m)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    if (confirm(t('removeConfirm'))) {
                      removeMutation.mutate(m.membershipId);
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 4: Create team repositories component**

```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDistanceToNow } from 'date-fns';

interface TeamRepositoriesProps {
  teamId: string;
}

export function TeamRepositories({ teamId }: TeamRepositoriesProps) {
  const t = useTranslations('teamDetail.repositories');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [appliedFrom, setAppliedFrom] = useState('');
  const [appliedTo, setAppliedTo] = useState('');

  const queryParams = new URLSearchParams();
  if (appliedFrom) queryParams.set('from', appliedFrom);
  if (appliedTo) queryParams.set('to', appliedTo);

  const { data, isLoading } = useQuery({
    queryKey: ['team-repositories', teamId, appliedFrom, appliedTo],
    queryFn: async () => {
      const res = await fetch(`/api/v2/teams/${teamId}/repositories?${queryParams.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-4">
        <div className="space-y-1">
          <Label className="text-xs">{t('from')}</Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('to')}</Label>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-40"
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setAppliedFrom(from);
            setAppliedTo(to);
          }}
        >
          {t('apply')}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : !data?.repositories?.length ? (
        <div className="text-center py-8">
          <p className="text-muted-foreground">{t('empty')}</p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('commits')}</TableHead>
              <TableHead>{t('contributors')}</TableHead>
              <TableHead>{t('lastActivity')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.repositories.map((repo: any) => (
              <TableRow key={repo.fullName}>
                <TableCell>
                  {repo.repositoryId ? (
                    <Link
                      href={`/repositories/${repo.repositoryId}`}
                      className="font-medium hover:underline"
                    >
                      {repo.fullName}
                    </Link>
                  ) : (
                    <span className="font-medium">{repo.fullName}</span>
                  )}
                </TableCell>
                <TableCell>{repo.activeCommitCount}</TableCell>
                <TableCell>{repo.activeContributorCount}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {repo.lastActivityAt
                    ? formatDistanceToNow(new Date(repo.lastActivityAt), { addSuffix: true })
                    : '-'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Create add-member dialog component**

```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { Plus } from 'lucide-react';

interface AddMemberDialogProps {
  teamId: string;
  existingContributorIds: string[];
}

export function AddMemberDialog({ teamId, existingContributorIds }: AddMemberDialogProps) {
  const t = useTranslations('teamDetail.addMember');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [role, setRole] = useState('');

  const { data: contributorsData } = useQuery({
    queryKey: ['contributors-search', search],
    queryFn: async () => {
      const params = new URLSearchParams({ pageSize: '20' });
      if (search) params.set('search', search);
      const res = await fetch(`/api/v2/contributors?${params.toString()}`);
      const json = await res.json();
      if (!res.ok || !json.success) return { contributors: [] };
      return json.data;
    },
    enabled: open,
  });

  const availableContributors = (contributorsData?.contributors ?? []).filter(
    (c: any) => !existingContributorIds.includes(c.id),
  );

  const mutation = useMutation({
    mutationFn: async () => {
      const body: any = { contributorId: selectedId, isPrimary };
      if (effectiveFrom) body.effectiveFrom = effectiveFrom;
      if (effectiveTo) body.effectiveTo = effectiveTo;
      if (role) body.role = role;

      const res = await fetch(`/api/v2/teams/${teamId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Failed');
      return json.data;
    },
    onSuccess: () => {
      toast({ description: t('success') });
      queryClient.invalidateQueries({ queryKey: ['team', teamId] });
      resetAndClose();
    },
    onError: (err: Error) => {
      toast({
        variant: 'destructive',
        description: err.message.includes('Unique constraint') ? t('alreadyMember') : t('error'),
      });
    },
  });

  function resetAndClose() {
    setOpen(false);
    setSearch('');
    setSelectedId('');
    setEffectiveFrom('');
    setEffectiveTo('');
    setIsPrimary(false);
    setRole('');
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) resetAndClose(); else setOpen(true); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1">
          <Plus className="h-4 w-4" />
          {t('title')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t('contributor')}</Label>
            <Input
              placeholder={t('contributorPlaceholder')}
              value={search}
              onChange={(e) => { setSearch(e.target.value); setSelectedId(''); }}
            />
            {search && availableContributors.length > 0 && !selectedId && (
              <div className="border rounded-md max-h-40 overflow-y-auto">
                {availableContributors.map((c: any) => (
                  <button
                    key={c.id}
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-accent text-sm"
                    onClick={() => { setSelectedId(c.id); setSearch(c.displayName); }}
                  >
                    <span className="font-medium">{c.displayName}</span>
                    <span className="text-muted-foreground ml-2">{c.primaryEmail}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('effectiveFrom')}</Label>
              <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{t('effectiveTo')}</Label>
              <Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('role')}</Label>
            <Input placeholder={t('rolePlaceholder')} value={role} onChange={(e) => setRole(e.target.value)} />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id="is-primary" checked={isPrimary} onCheckedChange={(v) => setIsPrimary(v === true)} />
            <Label htmlFor="is-primary">{t('isPrimary')}</Label>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={resetAndClose}>Cancel</Button>
            <Button onClick={() => mutation.mutate()} disabled={!selectedId || mutation.isPending}>
              {t('submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: Create edit-membership dialog component**

```tsx
'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';

interface Membership {
  membershipId: string;
  displayName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isPrimary: boolean;
  role: string | null;
}

interface EditMembershipDialogProps {
  teamId: string;
  membership: Membership | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditMembershipDialog({ teamId, membership, open, onOpenChange }: EditMembershipDialogProps) {
  const t = useTranslations('teamDetail.editMember');
  const tAdd = useTranslations('teamDetail.addMember');
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [role, setRole] = useState('');

  useEffect(() => {
    if (membership) {
      setEffectiveFrom(format(new Date(membership.effectiveFrom), 'yyyy-MM-dd'));
      setEffectiveTo(membership.effectiveTo ? format(new Date(membership.effectiveTo), 'yyyy-MM-dd') : '');
      setIsPrimary(membership.isPrimary);
      setRole(membership.role ?? '');
    }
  }, [membership]);

  const mutation = useMutation({
    mutationFn: async () => {
      const body: any = { isPrimary };
      if (effectiveFrom) body.effectiveFrom = effectiveFrom;
      body.effectiveTo = effectiveTo || null;
      body.role = role || null;

      const res = await fetch(`/api/v2/teams/${teamId}/members/${membership!.membershipId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Update failed');
    },
    onSuccess: () => {
      toast({ description: t('success') });
      queryClient.invalidateQueries({ queryKey: ['team', teamId] });
      onOpenChange(false);
    },
    onError: () => {
      toast({ variant: 'destructive', description: t('error') });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}: {membership?.displayName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{tAdd('effectiveFrom')}</Label>
              <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{tAdd('effectiveTo')}</Label>
              <Input type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>{tAdd('role')}</Label>
            <Input placeholder={tAdd('rolePlaceholder')} value={role} onChange={(e) => setRole(e.target.value)} />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id="edit-primary" checked={isPrimary} onCheckedChange={(v) => setIsPrimary(v === true)} />
            <Label htmlFor="edit-primary">{tAdd('isPrimary')}</Label>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
              {t('submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 7: Create team detail page**

```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft } from 'lucide-react';
import { TeamHeader } from './components/team-header';
import { TeamKpiSummary } from './components/team-kpi-summary';
import { TeamContributors } from './components/team-contributors';
import { TeamRepositories } from './components/team-repositories';
import { AddMemberDialog } from './components/add-member-dialog';
import { EditMembershipDialog } from './components/edit-membership-dialog';

export default function TeamDetailPage() {
  const t = useTranslations('teamDetail');
  const { id } = useParams<{ id: string }>();
  const [editingMember, setEditingMember] = useState<any>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['team', id],
    queryFn: async () => {
      const res = await fetch(`/api/v2/teams/${id}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || 'Request failed');
      return json.data;
    },
  });

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
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center p-12 space-y-4">
        <p className="text-destructive">{t('error.title')}</p>
        <Button onClick={() => refetch()}>{t('error.retry')}</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <Link
        href="/teams"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        {t('backToList')}
      </Link>

      <TeamHeader team={data.team} />

      <TeamKpiSummary
        memberCount={data.summaryMetrics.memberCount}
        repositoryCount={data.summaryMetrics.activeRepositoryCount}
        lastActivityAt={data.summaryMetrics.lastActivityAt}
      />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{t('members.title')}</h2>
          <AddMemberDialog
            teamId={id}
            existingContributorIds={data.contributors.map((c: any) => c.contributorId)}
          />
        </div>
        <TeamContributors
          teamId={id}
          contributors={data.contributors}
          onEditMember={setEditingMember}
        />
      </div>

      <div className="space-y-4">
        <h2 className="text-lg font-semibold">{t('repositories.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('repositories.description')}</p>
        <TeamRepositories teamId={id} />
      </div>

      <EditMembershipDialog
        teamId={id}
        membership={editingMember}
        open={!!editingMember}
        onOpenChange={(open) => { if (!open) setEditingMember(null); }}
      />
    </div>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/app/\[locale\]/\(dashboard\)/teams/\[id\]/
git commit -m "feat: add Team detail page with header, KPI, members, repos, and dialogs"
```

---

### Task 12: Run Tests and Verify

- [ ] **Step 1: Run service tests**

Run:
```powershell
cd packages/server
pnpm test -- src/lib/services/team-service.test.ts
```

Expected: All tests pass.

- [ ] **Step 2: Run linter**

Run:
```powershell
cd packages/server
pnpm lint
```

Expected: No new lint errors in team files.

- [ ] **Step 3: Run build**

Run:
```powershell
cd packages/server
pnpm build
```

Expected: Build succeeds. No type errors.

- [ ] **Step 4: Fix any issues found, then final commit**

```bash
git add -A
git commit -m "fix: resolve lint/type issues in team pivot implementation"
```

---

## Acceptance Criteria Mapping

| Criterion | Task |
|-----------|------|
| Team and TeamMembership in schema | Task 1 |
| Minimal setup path (create team, add/remove members, effective dates, primary) | Tasks 5-7, 10-11 |
| Teams list shows one row per canonical team | Tasks 5, 10 |
| Team detail addressed by team identity (not order/repo) | Tasks 6, 11 |
| Team detail shows canonical contributors | Tasks 3, 6, 11 |
| Team detail shows activity-derived repositories | Tasks 3, 8, 11 |
| No Order/job IDs in team routes | Tasks 5-8 (all routes are workspace-scoped) |
| Works without SavedView/global context/PR model | Tasks 10-11 (local query params for date range) |
| Legacy flows keep working | Read-only context; no legacy files modified |
