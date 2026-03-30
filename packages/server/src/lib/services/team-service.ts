import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { Prisma } from '@prisma/client';

const log = logger.child({ service: 'team' });

// ── Helpers ──

/** Check whether two date ranges overlap. Open-ended (null) effectiveTo = still active.
 *  effectiveTo is treated as exclusive (the person is no longer a member ON that date),
 *  so aTo === bFrom means the ranges are adjacent, not overlapping. */
function rangesOverlap(
  aFrom: Date, aTo: Date | null,
  bFrom: Date, bTo: Date | null,
): boolean {
  if (aTo && aTo <= bFrom) return false;
  if (bTo && bTo <= aFrom) return false;
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

  // Fetch commit activity aggregated by (authorEmail, repository) to avoid
  // unbounded row fetch. Uses groupBy to return O(unique_email_repo_pairs)
  // instead of O(total_commits). Includes min/max dates for point-in-time
  // attribution against membership windows.
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  // email → repo → { minDate, maxDate }
  const commitsByEmailRepo = new Map<string, Map<string, { minDate: Date; maxDate: Date }>>();

  if (workspace && allEmails.size > 0) {
    const grouped = await prisma.commitAnalysis.groupBy({
      by: ['authorEmail', 'repository'],
      where: {
        authorEmail: { in: Array.from(allEmails) },
        order: { userId: workspace.ownerId },
      },
      _min: { authorDate: true },
      _max: { authorDate: true },
    });

    for (const g of grouped) {
      if (!g._min.authorDate || !g._max.authorDate) continue;
      let repoMap = commitsByEmailRepo.get(g.authorEmail);
      if (!repoMap) {
        repoMap = new Map();
        commitsByEmailRepo.set(g.authorEmail, repoMap);
      }
      repoMap.set(g.repository, { minDate: g._min.authorDate, maxDate: g._max.authorDate });
    }
  }

  // Build enriched rows
  const now = new Date();
  const rows = teams.map((t) => {
    const activeMemberships = t.memberships.filter(
      (m) => m.effectiveFrom <= now && (!m.effectiveTo || m.effectiveTo > now),
    );
    const activeContributorIds = new Set(activeMemberships.map((m) => m.contributorId));

    // Derive repos and lastActivity — apply point-in-time attribution by checking
    // whether the commit date range for (email, repo) overlaps with the membership window.
    const teamRepos = new Set<string>();
    let lastActivityAt: Date | null = null;
    for (const m of t.memberships) {
      for (const a of m.contributor.aliases) {
        const repoMap = commitsByEmailRepo.get(a.email);
        if (!repoMap) continue;
        for (const [repo, dates] of repoMap) {
          // Skip if membership starts after the latest commit in this repo
          if (m.effectiveFrom > dates.maxDate) continue;
          // Skip if membership ended before the earliest commit (exclusive effectiveTo)
          if (m.effectiveTo && m.effectiveTo <= dates.minDate) continue;
          teamRepos.add(repo);
          if (dates.maxDate && (!lastActivityAt || dates.maxDate > lastActivityAt)) {
            lastActivityAt = dates.maxDate;
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
      where: { team: { workspaceId }, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
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
              aliases: { select: { email: true } },
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

  // summaryMetrics — reuse pre-loaded memberships to avoid redundant queries
  const membershipsForRepos = team.memberships.map((m) => ({
    contributorId: m.contributorId,
    effectiveFrom: m.effectiveFrom,
    effectiveTo: m.effectiveTo,
    contributor: { aliases: m.contributor.aliases },
  }));
  const repositories = await computeTeamRepositories(
    workspaceId, membershipsForRepos, scopeRange,
  );

  const now = new Date();
  const activeContributorIds = new Set(
    team.memberships
      .filter((m) => m.effectiveFrom <= now && (!m.effectiveTo || m.effectiveTo > now))
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

  // All checks + write inside a single transaction to prevent TOCTOU races
  // on both the overlap invariant and the isPrimary uniqueness constraint.
  const result = await prisma.$transaction(async (tx) => {
    // Reject overlapping memberships for same contributor in same team.
    const existingInTeam = await tx.teamMembership.findMany({
      where: { teamId, contributorId: data.contributorId },
    });
    const hasOverlap = existingInTeam.some((m) =>
      rangesOverlap(m.effectiveFrom, m.effectiveTo, newFrom, newTo),
    );
    if (hasOverlap) {
      return { error: 'Membership overlaps with an existing membership in this team' as const };
    }

    if (data.isPrimary) {
      const overlapping = await tx.teamMembership.findMany({
        where: { contributorId: data.contributorId, isPrimary: true },
      });
      const toUnset = overlapping
        .filter((m) => rangesOverlap(m.effectiveFrom, m.effectiveTo, newFrom, newTo))
        .map((m) => m.id);
      if (toUnset.length > 0) {
        await tx.teamMembership.updateMany({
          where: { id: { in: toUnset } },
          data: { isPrimary: false },
        });
      }
    }

    const membership = await tx.teamMembership.create({
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
    return { membership };
  });

  if ('error' in result) return result;
  const { membership } = result;

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

  // All checks + write inside a single transaction to prevent TOCTOU races
  // on both the overlap invariant and the isPrimary uniqueness constraint.
  const result = await prisma.$transaction(async (tx) => {
    const membership = await tx.teamMembership.findFirst({
      where: { id: membershipId, teamId },
    });
    if (!membership) return { error: 'Membership not found' as const };

    const effectiveFrom = data.effectiveFrom ?? membership.effectiveFrom;
    const effectiveTo = data.effectiveTo !== undefined ? data.effectiveTo : membership.effectiveTo;

    // If dates are changing, check for overlap with other memberships in the same team
    if (data.effectiveFrom !== undefined || data.effectiveTo !== undefined) {
      const siblings = await tx.teamMembership.findMany({
        where: { teamId, contributorId: membership.contributorId, id: { not: membershipId } },
      });
      const hasOverlap = siblings.some((m) =>
        rangesOverlap(m.effectiveFrom, m.effectiveTo, effectiveFrom, effectiveTo),
      );
      if (hasOverlap) {
        return { error: 'Updated dates would overlap with another membership in this team' as const };
      }
    }

    if (data.isPrimary) {
      const overlapping = await tx.teamMembership.findMany({
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
        await tx.teamMembership.updateMany({
          where: { id: { in: toUnset } },
          data: { isPrimary: false },
        });
      }
    }

    return { membership: await tx.teamMembership.update({ where: { id: membershipId }, data }) };
  });

  if ('error' in result) return result;
  log.info({ membershipId, teamId }, 'Membership updated');
  return result;
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

// ── Internal helper: compute activity-derived repos from pre-loaded memberships ──

type MembershipForRepos = {
  contributorId: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  contributor: { aliases: { email: string }[] };
};

type RepoRow = {
  repositoryId: string | null;
  fullName: string;
  language: string | null;
  isPrivate: boolean;
  activeCommitCount: number;
  activeContributorCount: number;
  lastActivityAt: Date | null;
};

async function computeTeamRepositories(
  workspaceId: string,
  memberships: MembershipForRepos[],
  dateRange?: { from?: Date; to?: Date },
): Promise<RepoRow[]> {
  if (memberships.length === 0) return [];

  // Filter memberships that overlap with the requested date range
  const activeMemberships = memberships.filter((m) => {
    if (dateRange?.from && m.effectiveTo && m.effectiveTo <= dateRange.from) return false;
    if (dateRange?.to && m.effectiveFrom > dateRange.to) return false;
    return true;
  });

  if (activeMemberships.length === 0) return [];

  // Build per-email attribution windows.
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
  if (allEmails.length === 0) return [];

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) return [];

  const dateFilter: Prisma.DateTimeFilter = {};
  if (dateRange?.from) dateFilter.gte = dateRange.from;
  if (dateRange?.to) dateFilter.lte = dateRange.to;

  const broadWhere: Prisma.CommitAnalysisWhereInput = {
    authorEmail: { in: allEmails },
    order: { userId: workspace.ownerId },
    ...(Object.keys(dateFilter).length > 0 ? { authorDate: dateFilter } : {}),
  };

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
      if (w.to && c.authorDate! >= w.to) return false;
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
  const canonicalRepos = repoNames.length > 0
    ? await prisma.repository.findMany({
        where: { workspaceId, fullName: { in: repoNames } },
      })
    : [];
  const repoLookup = new Map(canonicalRepos.map((r) => [r.fullName, r]));

  return Array.from(repoAgg.entries())
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
}

// ── Activity-derived repositories (point-in-time attribution) ──

export async function getTeamRepositories(
  teamId: string,
  workspaceId: string,
  dateRange?: { from?: Date; to?: Date },
) {
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

  const repositories = await computeTeamRepositories(workspaceId, team.memberships, dateRange);
  return { repositories };
}
