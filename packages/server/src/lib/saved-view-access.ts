import type { Prisma } from '@prisma/client';

export function buildSavedViewReadableWhere(
  workspaceId: string,
  actorUserId: string,
): Prisma.SavedViewWhereInput {
  return {
    workspaceId,
    OR: [
      { visibility: 'WORKSPACE' },
      { ownerUserId: actorUserId },
    ],
  };
}

export function buildSavedViewWritableWhere(
  workspaceId: string,
  actorUserId: string,
): Prisma.SavedViewWhereInput {
  return {
    workspaceId,
    ownerUserId: actorUserId,
  };
}
