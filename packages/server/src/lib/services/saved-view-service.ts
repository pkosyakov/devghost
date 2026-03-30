import { prisma } from '@/lib/db';
import {
  deriveSavedViewScopeKind,
  isScopeDirtyAgainstSavedView,
  resolvedScopeToSavedViewDefinitions,
} from '@/lib/active-scope';
import { buildSavedViewReadableWhere, buildSavedViewWritableWhere } from '@/lib/saved-view-access';
import type { ActiveScopeQuery, SavedViewFilterDefinition, SavedViewScopeDefinition } from '@/lib/schemas/scope';
import type {
  CreateSavedViewBody,
  CreateSavedViewFromScopeBody,
  SavedViewListQuery,
} from '@/lib/schemas/saved-view';
import { resolveActiveScope } from '@/lib/services/active-scope-service';

type UpdateSavedViewInput = {
  name?: string;
  visibility?: 'PRIVATE' | 'WORKSPACE';
  scopeDefinition?: {
    teamIds?: string[];
    dateRange?: {
      start?: string | null;
      end?: string | null;
    };
  };
  filterDefinition?: {
    repositoryIds?: string[];
    contributorIds?: string[];
  };
};

function parseScopeDefinition(value: unknown): SavedViewScopeDefinition {
  const input = (value ?? {}) as Partial<SavedViewScopeDefinition>;
  return {
    teamIds: Array.isArray(input.teamIds) ? input.teamIds : [],
    dateRange: {
      start: input.dateRange?.start ?? null,
      end: input.dateRange?.end ?? null,
    },
  };
}

function parseFilterDefinition(value: unknown): SavedViewFilterDefinition {
  const input = (value ?? {}) as Partial<SavedViewFilterDefinition>;
  return {
    repositoryIds: Array.isArray(input.repositoryIds) ? input.repositoryIds : [],
    contributorIds: Array.isArray(input.contributorIds) ? input.contributorIds : [],
  };
}

async function buildSavedViewRow(savedView: {
  id: string;
  name: string;
  visibility: 'PRIVATE' | 'WORKSPACE';
  isArchived: boolean;
  scopeDefinition: unknown;
  filterDefinition: unknown;
  updatedAt: Date;
  ownerUser: { id: string; name: string | null; email: string } | null;
}) {
  const scopeDefinition = parseScopeDefinition(savedView.scopeDefinition);
  const filterDefinition = parseFilterDefinition(savedView.filterDefinition);

  return {
    savedViewId: savedView.id,
    name: savedView.name,
    visibility: savedView.visibility,
    isArchived: savedView.isArchived,
    scopeKind: deriveSavedViewScopeKind(scopeDefinition, filterDefinition),
    dateRange: scopeDefinition.dateRange,
    repositoryIds: filterDefinition.repositoryIds,
    contributorIds: filterDefinition.contributorIds,
    teamCount: scopeDefinition.teamIds.length,
    repositoryCount: filterDefinition.repositoryIds.length,
    contributorCount: filterDefinition.contributorIds.length,
    owner: savedView.ownerUser
      ? {
          id: savedView.ownerUser.id,
          displayName: savedView.ownerUser.name ?? savedView.ownerUser.email,
          email: savedView.ownerUser.email,
        }
      : null,
    updatedAt: savedView.updatedAt,
  };
}

export async function listSavedViews(
  workspaceId: string,
  actorUserId: string,
  query: SavedViewListQuery,
) {
  const where = {
    ...buildSavedViewReadableWhere(workspaceId, actorUserId),
    ...(query.includeArchived ? {} : { isArchived: false }),
    ...(query.search
      ? { name: { contains: query.search, mode: 'insensitive' as const } }
      : {}),
  };

  const [total, items] = await Promise.all([
    prisma.savedView.count({ where }),
    prisma.savedView.findMany({
      where,
      orderBy: { [query.sort]: query.sortOrder },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        ownerUser: {
          select: { id: true, name: true, email: true },
        },
      },
    }),
  ]);

  const rows = await Promise.all(items.map(buildSavedViewRow));

  return {
    savedViews: rows,
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    },
  };
}

export async function createSavedView(
  workspaceId: string,
  ownerUserId: string,
  body: CreateSavedViewBody,
) {
  return prisma.savedView.create({
    data: {
      workspaceId,
      ownerUserId,
      name: body.name,
      visibility: body.visibility,
      scopeDefinition: body.scopeDefinition,
      filterDefinition: body.filterDefinition,
    },
  });
}

export async function createSavedViewFromActiveScope(
  workspaceId: string,
  ownerUserId: string,
  body: CreateSavedViewFromScopeBody,
) {
  const resolvedScope = await resolveActiveScope(workspaceId, body.activeScope, {
    actorUserId: ownerUserId,
  });
  const definitions = resolvedScopeToSavedViewDefinitions(resolvedScope);
  return prisma.savedView.create({
    data: {
      workspaceId,
      ownerUserId,
      name: body.name,
      visibility: body.visibility,
      scopeDefinition: definitions.scopeDefinition,
      filterDefinition: definitions.filterDefinition,
    },
  });
}

export async function getSavedViewDetail(
  savedViewId: string,
  workspaceId: string,
  actorUserId: string,
  activeScope?: ActiveScopeQuery | null,
) {
  const savedView = await prisma.savedView.findFirst({
    where: {
      id: savedViewId,
      ...buildSavedViewReadableWhere(workspaceId, actorUserId),
    },
    include: {
      ownerUser: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  if (!savedView) return null;

  const scopeDefinition = parseScopeDefinition(savedView.scopeDefinition);
  const filterDefinition = parseFilterDefinition(savedView.filterDefinition);

  const [teams, repositories, contributors] = await Promise.all([
    scopeDefinition.teamIds.length > 0
      ? prisma.team.findMany({
          where: { workspaceId, id: { in: scopeDefinition.teamIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    filterDefinition.repositoryIds.length > 0
      ? prisma.repository.findMany({
          where: { workspaceId, id: { in: filterDefinition.repositoryIds } },
          select: { id: true, fullName: true },
        })
      : Promise.resolve([]),
    filterDefinition.contributorIds.length > 0
      ? prisma.contributor.findMany({
          where: { workspaceId, id: { in: filterDefinition.contributorIds } },
          select: { id: true, displayName: true, primaryEmail: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    savedView: {
      id: savedView.id,
      name: savedView.name,
      visibility: savedView.visibility,
      isArchived: savedView.isArchived,
      archivedAt: savedView.archivedAt,
      createdAt: savedView.createdAt,
      updatedAt: savedView.updatedAt,
      owner: savedView.ownerUser
        ? {
            id: savedView.ownerUser.id,
            displayName: savedView.ownerUser.name ?? savedView.ownerUser.email,
            email: savedView.ownerUser.email,
          }
        : null,
    },
    resolvedScope: {
      scopeKind: deriveSavedViewScopeKind(scopeDefinition, filterDefinition),
      teamIds: scopeDefinition.teamIds,
      dateRange: scopeDefinition.dateRange,
      repositoryIds: filterDefinition.repositoryIds,
      contributorIds: filterDefinition.contributorIds,
      teams,
      repositories,
      contributors,
    },
    visibility: savedView.visibility,
    shareMetadata: null,
    linkedSchedules: [],
    linkedDashboards: [],
    saveViewState: activeScope
      ? await (async () => {
          const resolvedActiveScope = await resolveActiveScope(workspaceId, activeScope, {
            actorUserId,
          });
          return {
            isDirty: isScopeDirtyAgainstSavedView(
              activeScope,
              scopeDefinition,
              filterDefinition,
              resolvedActiveScope.teamIds,
            ),
          };
        })()
      : null,
  };
}

export async function updateSavedView(
  savedViewId: string,
  workspaceId: string,
  actorUserId: string,
  body: UpdateSavedViewInput,
) {
  const scopeDefinition = body.scopeDefinition !== undefined
    ? parseScopeDefinition(body.scopeDefinition)
    : undefined;
  const filterDefinition = body.filterDefinition !== undefined
    ? parseFilterDefinition(body.filterDefinition)
    : undefined;

  return prisma.savedView.updateMany({
    where: { id: savedViewId, ...buildSavedViewWritableWhere(workspaceId, actorUserId) },
    data: {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
      ...(scopeDefinition !== undefined ? { scopeDefinition } : {}),
      ...(filterDefinition !== undefined ? { filterDefinition } : {}),
    },
  });
}

export async function archiveSavedView(savedViewId: string, workspaceId: string, actorUserId: string) {
  return prisma.savedView.updateMany({
    where: { id: savedViewId, ...buildSavedViewWritableWhere(workspaceId, actorUserId) },
    data: { isArchived: true, archivedAt: new Date() },
  });
}

export async function restoreSavedView(savedViewId: string, workspaceId: string, actorUserId: string) {
  return prisma.savedView.updateMany({
    where: { id: savedViewId, ...buildSavedViewWritableWhere(workspaceId, actorUserId) },
    data: { isArchived: false, archivedAt: null },
  });
}

