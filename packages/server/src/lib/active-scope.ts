import type { ActiveScopeQuery, SavedViewFilterDefinition, SavedViewScopeDefinition } from '@/lib/schemas/scope';

export const ACTIVE_SCOPE_QUERY_KEYS = [
  'scopeKind',
  'scopeId',
  'from',
  'to',
  'repositoryIds',
  'contributorIds',
  'viewAs',
] as const;

type SearchParamsLike = {
  get(name: string): string | null;
};

export function pickActiveScopeParams(searchParams: SearchParamsLike): URLSearchParams {
  const next = new URLSearchParams();

  for (const key of ACTIVE_SCOPE_QUERY_KEYS) {
    const value = searchParams.get(key);
    if (value) {
      next.set(key, value);
    }
  }

  return next;
}

export function buildHrefWithActiveScope(pathname: string, searchParams: SearchParamsLike): string {
  const scopeParams = pickActiveScopeParams(searchParams);
  const serialized = scopeParams.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
}

export function toDateOnlyString(date: Date | string | null | undefined): string | null {
  if (!date) return null;

  if (typeof date === 'string') {
    return date.slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}

export function parseDateOnlyToUtcStart(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  return new Date(`${value}T00:00:00.000Z`);
}

export function scopeQueryToSavedViewDefinitions(activeScope: ActiveScopeQuery): {
  scopeDefinition: SavedViewScopeDefinition;
  filterDefinition: SavedViewFilterDefinition;
} {
  const teamIds = activeScope.scopeKind === 'team' && activeScope.scopeId
    ? [activeScope.scopeId]
    : [];

  return {
    scopeDefinition: {
      teamIds,
      dateRange: {
        start: activeScope.from ?? null,
        end: activeScope.to ?? null,
      },
    },
    filterDefinition: {
      repositoryIds: activeScope.repositoryIds ?? [],
      contributorIds: activeScope.contributorIds ?? [],
    },
  };
}

export function resolvedScopeToSavedViewDefinitions(input: {
  teamIds: string[];
  dateRange: {
    start: string | null;
    end: string | null;
  };
  secondaryFilters: {
    repositoryIds: string[];
    contributorIds: string[];
  };
}): {
  scopeDefinition: SavedViewScopeDefinition;
  filterDefinition: SavedViewFilterDefinition;
} {
  return {
    scopeDefinition: {
      teamIds: input.teamIds,
      dateRange: {
        start: input.dateRange.start,
        end: input.dateRange.end,
      },
    },
    filterDefinition: {
      repositoryIds: input.secondaryFilters.repositoryIds,
      contributorIds: input.secondaryFilters.contributorIds,
    },
  };
}

export function deriveSavedViewScopeKind(
  scopeDefinition: SavedViewScopeDefinition,
  filterDefinition: SavedViewFilterDefinition,
): 'all_teams' | 'team' | 'custom' {
  if (
    scopeDefinition.teamIds.length === 0 &&
    filterDefinition.repositoryIds.length === 0 &&
    filterDefinition.contributorIds.length === 0
  ) {
    return 'all_teams';
  }

  if (
    scopeDefinition.teamIds.length === 1 &&
    filterDefinition.repositoryIds.length === 0 &&
    filterDefinition.contributorIds.length === 0
  ) {
    return 'team';
  }

  return 'custom';
}

export function isScopeDirtyAgainstSavedView(
  activeScope: ActiveScopeQuery,
  scopeDefinition: SavedViewScopeDefinition,
  filterDefinition: SavedViewFilterDefinition,
  resolvedTeamIds?: string[],
): boolean {
  const normalized = resolvedTeamIds
    ? {
        scopeDefinition: {
          teamIds: resolvedTeamIds,
          dateRange: {
            start: activeScope.from ?? null,
            end: activeScope.to ?? null,
          },
        },
        filterDefinition: {
          repositoryIds: activeScope.repositoryIds ?? [],
          contributorIds: activeScope.contributorIds ?? [],
        },
      }
    : scopeQueryToSavedViewDefinitions(activeScope);

  return JSON.stringify(normalized.scopeDefinition) !== JSON.stringify(scopeDefinition)
    || JSON.stringify(normalized.filterDefinition) !== JSON.stringify(filterDefinition);
}
