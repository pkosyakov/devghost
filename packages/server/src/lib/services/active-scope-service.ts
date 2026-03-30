import { prisma } from '@/lib/db';
import { parseDateOnlyToUtcStart, toDateOnlyString } from '@/lib/active-scope';
import { buildSavedViewReadableWhere } from '@/lib/saved-view-access';
import { getTeamRepositories } from '@/lib/services/team-service';
import type { ActiveScopeQuery } from '@/lib/schemas/scope';

export interface ResolvedActiveScope {
  workspaceId: string;
  scopeKind: 'all_teams' | 'team' | 'saved_view';
  scopeId: string | null;
  dateRange: {
    start: string | null;
    end: string | null;
  };
  secondaryFilters: {
    repositoryIds: string[];
    contributorIds: string[];
  };
  teamIds: string[];
  activeSavedViewId: string | null;
}

function dateRangeToWindow(range: ResolvedActiveScope['dateRange']) {
  const from = parseDateOnlyToUtcStart(range.start);
  const to = parseDateOnlyToUtcStart(range.end);
  return { from, to };
}

function overlapWhere(range: ResolvedActiveScope['dateRange']) {
  const from = parseDateOnlyToUtcStart(range.start);
  const to = parseDateOnlyToUtcStart(range.end);

  const clauses: Record<string, unknown>[] = [];
  if (to) {
    clauses.push({ effectiveFrom: { lte: to } });
  }
  if (from) {
    clauses.push({
      OR: [
        { effectiveTo: null },
        { effectiveTo: { gt: from } },
      ],
    });
  }

  return clauses.length > 0 ? { AND: clauses } : {};
}

export async function resolveActiveScope(
  workspaceId: string,
  rawScope: ActiveScopeQuery,
  options?: { routeTeamId?: string | null; actorUserId?: string | null },
): Promise<ResolvedActiveScope> {
  const routeTeamId = options?.routeTeamId ?? null;
  const actorUserId = options?.actorUserId ?? null;

  if (routeTeamId) {
    return {
      workspaceId,
      scopeKind: 'team',
      scopeId: routeTeamId,
      dateRange: {
        start: rawScope.from ?? null,
        end: rawScope.to ?? null,
      },
      secondaryFilters: {
        repositoryIds: rawScope.repositoryIds ?? [],
        contributorIds: rawScope.contributorIds ?? [],
      },
      teamIds: [routeTeamId],
      activeSavedViewId: rawScope.scopeKind === 'saved_view' ? rawScope.scopeId ?? null : null,
    };
  }

  if (rawScope.scopeKind === 'saved_view' && rawScope.scopeId) {
    const savedView = await prisma.savedView.findFirst({
      where: {
        id: rawScope.scopeId,
        ...(actorUserId
          ? buildSavedViewReadableWhere(workspaceId, actorUserId)
          : { workspaceId }),
        isArchived: false,
      },
      select: {
        scopeDefinition: true,
        filterDefinition: true,
      },
    });

    if (savedView) {
      const scopeDefinition = (savedView.scopeDefinition ?? {}) as {
        teamIds?: string[];
        dateRange?: { start?: string | null; end?: string | null };
      };
      const filterDefinition = (savedView.filterDefinition ?? {}) as {
        repositoryIds?: string[];
        contributorIds?: string[];
      };

      return {
        workspaceId,
        scopeKind: 'saved_view',
        scopeId: rawScope.scopeId,
        dateRange: {
          start: rawScope.from ?? scopeDefinition.dateRange?.start ?? null,
          end: rawScope.to ?? scopeDefinition.dateRange?.end ?? null,
        },
        secondaryFilters: {
          repositoryIds: rawScope.repositoryIds?.length
            ? rawScope.repositoryIds
            : (filterDefinition.repositoryIds ?? []),
          contributorIds: rawScope.contributorIds?.length
            ? rawScope.contributorIds
            : (filterDefinition.contributorIds ?? []),
        },
        teamIds: scopeDefinition.teamIds ?? [],
        activeSavedViewId: rawScope.scopeId,
      };
    }
  }

  if (rawScope.scopeKind === 'team' && rawScope.scopeId) {
    return {
      workspaceId,
      scopeKind: 'team',
      scopeId: rawScope.scopeId,
      dateRange: {
        start: rawScope.from ?? null,
        end: rawScope.to ?? null,
      },
      secondaryFilters: {
        repositoryIds: rawScope.repositoryIds ?? [],
        contributorIds: rawScope.contributorIds ?? [],
      },
      teamIds: [rawScope.scopeId],
      activeSavedViewId: null,
    };
  }

  return {
    workspaceId,
    scopeKind: 'all_teams',
    scopeId: null,
    dateRange: {
      start: rawScope.from ?? null,
      end: rawScope.to ?? null,
    },
    secondaryFilters: {
      repositoryIds: rawScope.repositoryIds ?? [],
      contributorIds: rawScope.contributorIds ?? [],
    },
    teamIds: [],
    activeSavedViewId: null,
  };
}

export async function getContributorIdsForScope(scope: ResolvedActiveScope): Promise<string[] | null> {
  let contributorIds: string[] | null = null;

  if (scope.teamIds.length > 0) {
    const memberships = await prisma.teamMembership.findMany({
      where: {
        teamId: { in: scope.teamIds },
        ...overlapWhere(scope.dateRange),
      },
      select: { contributorId: true },
      distinct: ['contributorId'],
    });
    contributorIds = memberships.map((membership) => membership.contributorId);
  }

  if (scope.secondaryFilters.contributorIds.length > 0) {
    contributorIds = contributorIds
      ? contributorIds.filter((id) => scope.secondaryFilters.contributorIds.includes(id))
      : scope.secondaryFilters.contributorIds;
  }

  return contributorIds;
}

export async function getContributorEmailsForScope(scope: ResolvedActiveScope): Promise<string[] | null> {
  const contributorIds = await getContributorIdsForScope(scope);
  if (!contributorIds || contributorIds.length === 0) {
    return contributorIds;
  }

  const aliases = await prisma.contributorAlias.findMany({
    where: {
      workspaceId: scope.workspaceId,
      contributorId: { in: contributorIds },
    },
    select: { email: true },
    distinct: ['email'],
  });

  return aliases.map((alias) => alias.email);
}

export async function getRepositoryNamesForScope(scope: ResolvedActiveScope): Promise<string[] | null> {
  let repositoryNames: string[] | null = null;

  if (scope.teamIds.length > 0) {
    const results = await Promise.all(
      scope.teamIds.map((teamId) => getTeamRepositories(teamId, scope.workspaceId, dateRangeToWindow(scope.dateRange))),
    );
    repositoryNames = Array.from(
      new Set(
        results.flatMap((result) => result?.repositories.map((repository) => repository.fullName) ?? []),
      ),
    );
  }

  if (scope.secondaryFilters.repositoryIds.length > 0) {
    const repositories = await prisma.repository.findMany({
      where: {
        workspaceId: scope.workspaceId,
        id: { in: scope.secondaryFilters.repositoryIds },
      },
      select: { fullName: true },
    });
    const explicitNames = repositories.map((repository) => repository.fullName);
    repositoryNames = repositoryNames
      ? repositoryNames.filter((name) => explicitNames.includes(name))
      : explicitNames;
  }

  return repositoryNames;
}

export async function getScopeChromeState(scope: ResolvedActiveScope, actorUserId: string) {
  const [teams, savedViews] = await Promise.all([
    prisma.team.findMany({
      where: { workspaceId: scope.workspaceId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.savedView.findMany({
      where: {
        ...buildSavedViewReadableWhere(scope.workspaceId, actorUserId),
        isArchived: false,
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        visibility: true,
        scopeDefinition: true,
        filterDefinition: true,
      },
    }),
  ]);

  return {
    resolvedScope: {
      ...scope,
      scopeLabel:
        scope.scopeKind === 'team'
          ? teams.find((team) => team.id === scope.scopeId)?.name ?? null
          : scope.scopeKind === 'saved_view'
            ? savedViews.find((view) => view.id === scope.scopeId)?.name ?? null
            : null,
    },
    teams,
    savedViews: savedViews.map((savedView) => ({
      id: savedView.id,
      name: savedView.name,
      visibility: savedView.visibility,
      teamIds: ((savedView.scopeDefinition as { teamIds?: string[] } | null)?.teamIds) ?? [],
      repositoryIds: ((savedView.filterDefinition as { repositoryIds?: string[] } | null)?.repositoryIds) ?? [],
      contributorIds: ((savedView.filterDefinition as { contributorIds?: string[] } | null)?.contributorIds) ?? [],
    })),
  };
}

export function scopeDateRangeToDates(scope: ResolvedActiveScope['dateRange']) {
  return {
    from: parseDateOnlyToUtcStart(scope.start ?? null),
    to: parseDateOnlyToUtcStart(scope.end ?? null),
  };
}

export function serializeResolvedScope(scope: ResolvedActiveScope) {
  return {
    scopeKind: scope.scopeKind,
    scopeId: scope.scopeId,
    dateRange: {
      start: scope.dateRange.start,
      end: scope.dateRange.end,
    },
    secondaryFilters: scope.secondaryFilters,
    teamIds: scope.teamIds,
    activeSavedViewId: scope.activeSavedViewId,
  };
}

export function describeScope(scope: ResolvedActiveScope) {
  return {
    scopeKind: scope.scopeKind,
    scopeId: scope.scopeId,
    teamIds: scope.teamIds,
    dateRange: {
      start: scope.dateRange.start,
      end: scope.dateRange.end,
      startDate: toDateOnlyString(scope.dateRange.start),
      endDate: toDateOnlyString(scope.dateRange.end),
    },
    secondaryFilters: scope.secondaryFilters,
    activeSavedViewId: scope.activeSavedViewId,
  };
}
