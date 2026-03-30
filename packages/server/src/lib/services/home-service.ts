import { prisma } from '@/lib/db';
import { isScopeDirtyAgainstSavedView } from '@/lib/active-scope';
import { buildSavedViewReadableWhere } from '@/lib/saved-view-access';
import {
  getContributorEmailsForScope,
  getRepositoryNamesForScope,
  resolveActiveScope,
  serializeResolvedScope,
} from '@/lib/services/active-scope-service';
import { listTeams } from '@/lib/services/team-service';
import type { ActiveScopeQuery } from '@/lib/schemas/scope';

export async function getHomeDetail(
  workspaceId: string,
  actorUserId: string,
  rawScope: ActiveScopeQuery,
) {
  const scope = await resolveActiveScope(workspaceId, rawScope, { actorUserId });
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ownerId: true },
  });

  if (!workspace) {
    return null;
  }

  const [scopedEmails, scopedRepositoryNames, workspaceTeamCount, workspaceRepoCount, workspaceContributorCount, savedViewCount] = await Promise.all([
    getContributorEmailsForScope(scope),
    getRepositoryNamesForScope(scope),
    prisma.team.count({ where: { workspaceId } }),
    prisma.repository.count({ where: { workspaceId } }),
    prisma.contributor.count({ where: { workspaceId } }),
    prisma.savedView.count({
      where: {
        ...buildSavedViewReadableWhere(workspaceId, actorUserId),
        isArchived: false,
      },
    }),
  ]);

  // Stage 3: at least one team exists
  // Stage 1: repos AND contributors are visible (journey doc requires both)
  // Stage 0: anything else (no data, or repos without resolved contributors)
  const workspaceStage: 'empty' | 'first_data' | 'operational' =
    workspaceTeamCount > 0 ? 'operational' :
    (workspaceRepoCount > 0 && workspaceContributorCount > 0) ? 'first_data' :
    'empty';

  const authorDateWhere: { gte?: Date; lte?: Date } = {};
  if (scope.dateRange.start) {
    authorDateWhere.gte = new Date(`${scope.dateRange.start}T00:00:00.000Z`);
  }
  if (scope.dateRange.end) {
    const endOfDay = new Date(`${scope.dateRange.end}T00:00:00.000Z`);
    endOfDay.setUTCHours(23, 59, 59, 999);
    authorDateWhere.lte = endOfDay;
  }

  const commitWhere: Record<string, unknown> = {
    order: { userId: workspace.ownerId },
  };
  if (scopedEmails) {
    commitWhere.authorEmail = { in: scopedEmails };
  }
  if (scopedRepositoryNames) {
    commitWhere.repository = { in: scopedRepositoryNames };
  }
  if (Object.keys(authorDateWhere).length > 0) {
    commitWhere.authorDate = authorDateWhere;
  }

  const commits = await prisma.commitAnalysis.findMany({
    where: commitWhere,
    select: {
      commitHash: true,
      repository: true,
      authorEmail: true,
      authorDate: true,
      effortHours: true,
    },
  });

  const commitKeys = new Set<string>();
  const uniqueCommits = commits.filter((commit) => {
    const key = `${commit.repository}:${commit.commitHash}`;
    if (commitKeys.has(key)) return false;
    commitKeys.add(key);
    return true;
  });

  const uniqueEmails = Array.from(new Set(uniqueCommits.map((commit) => commit.authorEmail)));
  const aliases = uniqueEmails.length > 0
    ? await prisma.contributorAlias.findMany({
        where: {
          workspaceId,
          email: { in: uniqueEmails },
        },
        select: {
          email: true,
          contributorId: true,
          contributor: {
            select: {
              id: true,
              displayName: true,
              primaryEmail: true,
              classification: true,
            },
          },
        },
      })
    : [];
  const aliasByEmail = new Map(aliases.map((alias) => [alias.email, alias]));

  const repositoryRows = scopedRepositoryNames
    ? await prisma.repository.findMany({
        where: {
          workspaceId,
          fullName: { in: scopedRepositoryNames },
        },
      })
    : await prisma.repository.findMany({ where: { workspaceId } });
  const repositoryByFullName = new Map(repositoryRows.map((repository) => [repository.fullName, repository]));

  const contributorAgg = new Map<string, {
    id: string | null;
    displayName: string;
    primaryEmail: string;
    classification: string | null;
    commitCount: number;
    repositoryNames: Set<string>;
    lastActivityAt: Date | null;
  }>();

  const repositoryAgg = new Map<string, {
    repositoryId: string | null;
    fullName: string;
    commitCount: number;
    contributorKeys: Set<string>;
    lastActivityAt: Date | null;
    freshnessStatus: 'fresh' | 'stale' | 'never';
    lastUpdatedAt: Date | null;
  }>();

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  for (const commit of uniqueCommits) {
    const alias = aliasByEmail.get(commit.authorEmail);
    const contributorKey = alias?.contributorId ?? `unresolved:${commit.authorEmail}`;
    const contributorLabel = alias?.contributor?.displayName ?? commit.authorEmail;
    const contributor = contributorAgg.get(contributorKey) ?? {
      id: alias?.contributorId ?? null,
      displayName: contributorLabel,
      primaryEmail: alias?.contributor?.primaryEmail ?? commit.authorEmail,
      classification: alias?.contributor?.classification ?? null,
      commitCount: 0,
      repositoryNames: new Set<string>(),
      lastActivityAt: null,
    };
    contributor.commitCount += 1;
    contributor.repositoryNames.add(commit.repository);
    if (commit.authorDate && (!contributor.lastActivityAt || commit.authorDate > contributor.lastActivityAt)) {
      contributor.lastActivityAt = commit.authorDate;
    }
    contributorAgg.set(contributorKey, contributor);

    const canonicalRepository = repositoryByFullName.get(commit.repository);
    let freshnessStatus: 'fresh' | 'stale' | 'never' = 'never';
    if (canonicalRepository?.lastAnalyzedAt) {
      freshnessStatus = canonicalRepository.lastAnalyzedAt >= thirtyDaysAgo ? 'fresh' : 'stale';
    }

    const repository = repositoryAgg.get(commit.repository) ?? {
      repositoryId: canonicalRepository?.id ?? null,
      fullName: commit.repository,
      commitCount: 0,
      contributorKeys: new Set<string>(),
      lastActivityAt: null,
      freshnessStatus,
      lastUpdatedAt: canonicalRepository?.lastAnalyzedAt ?? null,
    };
    repository.commitCount += 1;
    repository.contributorKeys.add(contributorKey);
    if (commit.authorDate && (!repository.lastActivityAt || commit.authorDate > repository.lastActivityAt)) {
      repository.lastActivityAt = commit.authorDate;
    }
    repositoryAgg.set(commit.repository, repository);
  }

  const teamsResult = scope.teamIds.length === 1 && scope.scopeKind === 'team'
    ? { teams: [], pagination: null, summary: null }
    : await listTeams(workspaceId, {
        page: 1,
        pageSize: 5,
        sort: 'lastActivityAt',
        sortOrder: 'desc',
        teamIds: scope.teamIds.length > 0 ? scope.teamIds : undefined,
        dateRange: {
          from: scope.dateRange.start ? new Date(`${scope.dateRange.start}T00:00:00.000Z`) : undefined,
          to: scope.dateRange.end ? new Date(`${scope.dateRange.end}T00:00:00.000Z`) : undefined,
        },
      });

  const visibleRepositories = repositoryRows.filter((repository) =>
    scopedRepositoryNames ? scopedRepositoryNames.includes(repository.fullName) : true,
  );
  const freshnessSummary = visibleRepositories.reduce(
    (acc, repository) => {
      if (!repository.lastAnalyzedAt) {
        acc.never += 1;
      } else if (repository.lastAnalyzedAt >= thirtyDaysAgo) {
        acc.fresh += 1;
      } else {
        acc.stale += 1;
      }
      return acc;
    },
    { fresh: 0, stale: 0, never: 0 },
  );

  let saveViewState: {
    activeSavedViewId: string | null;
    isDirty: boolean;
    canSaveCurrentScope: boolean;
  } = {
    activeSavedViewId: scope.activeSavedViewId,
    isDirty: false,
    canSaveCurrentScope: true,
  };

  if (scope.activeSavedViewId) {
    const savedView = await prisma.savedView.findFirst({
      where: { id: scope.activeSavedViewId, ...buildSavedViewReadableWhere(workspaceId, actorUserId) },
      select: { scopeDefinition: true, filterDefinition: true },
    });

    if (savedView) {
      saveViewState = {
        activeSavedViewId: scope.activeSavedViewId,
        isDirty: isScopeDirtyAgainstSavedView(
          rawScope,
          {
            teamIds: ((savedView.scopeDefinition as { teamIds?: string[] } | null)?.teamIds) ?? [],
            dateRange: {
              start: ((savedView.scopeDefinition as { dateRange?: { start?: string | null; end?: string | null } } | null)?.dateRange?.start) ?? null,
              end: ((savedView.scopeDefinition as { dateRange?: { start?: string | null; end?: string | null } } | null)?.dateRange?.end) ?? null,
            },
          },
          {
            repositoryIds: ((savedView.filterDefinition as { repositoryIds?: string[] } | null)?.repositoryIds) ?? [],
            contributorIds: ((savedView.filterDefinition as { contributorIds?: string[] } | null)?.contributorIds) ?? [],
          },
          scope.teamIds,
        ),
        canSaveCurrentScope: true,
      };
    }
  }

  return {
    workspaceStage,
    resolvedScope: serializeResolvedScope(scope),
    summaryMetrics: {
      activeTeamCount: teamsResult.summary?.activeTeamCount ?? scope.teamIds.length,
      activeContributorCount: contributorAgg.size,
      activeRepositoryCount: repositoryAgg.size,
      totalCommits: uniqueCommits.length,
    },
    topTeams: teamsResult.teams ?? [],
    topContributors: Array.from(contributorAgg.values())
      .sort((a, b) => b.commitCount - a.commitCount || (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0))
      .slice(0, 5)
      .map((contributor) => ({
        contributorId: contributor.id,
        displayName: contributor.displayName,
        primaryEmail: contributor.primaryEmail,
        classification: contributor.classification,
        commitCount: contributor.commitCount,
        activeRepositoryCount: contributor.repositoryNames.size,
        lastActivityAt: contributor.lastActivityAt,
      })),
    topRepositories: Array.from(repositoryAgg.values())
      .sort((a, b) => b.commitCount - a.commitCount || (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0))
      .slice(0, 5)
      .map((repository) => ({
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        commitCount: repository.commitCount,
        activeContributorCount: repository.contributorKeys.size,
        lastActivityAt: repository.lastActivityAt,
        freshnessStatus: repository.freshnessStatus,
        lastUpdatedAt: repository.lastUpdatedAt,
      })),
    freshnessSummary,
    saveViewState,
    onboarding: {
      needsFirstSavedView: workspaceTeamCount > 0 && savedViewCount === 0,
      savedViewCount,
    },
  };
}
