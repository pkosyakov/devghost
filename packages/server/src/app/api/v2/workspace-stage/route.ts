import { NextRequest } from 'next/server';
import { apiResponse, isErrorResponse, requireUserSession } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { buildSavedViewReadableWhere } from '@/lib/saved-view-access';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveEffectiveUser, isEffectiveUserError } from '@/lib/view-as';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);
  const workspaceId = workspace.id;

  const [teamCount, repoCount, contributorCount, savedViewCount] = await Promise.all([
    prisma.team.count({ where: { workspaceId } }),
    prisma.repository.count({ where: { workspaceId } }),
    prisma.contributor.count({ where: { workspaceId } }),
    prisma.savedView.count({
      where: {
        ...buildSavedViewReadableWhere(workspaceId, effective.effectiveUserId),
        isArchived: false,
      },
    }),
  ]);

  const workspaceStage: 'empty' | 'first_data' | 'operational' =
    teamCount > 0 ? 'operational' :
    (repoCount > 0 && contributorCount > 0) ? 'first_data' :
    'empty';

  return apiResponse({
    workspaceStage,
    onboarding: {
      needsFirstSavedView: teamCount > 0 && savedViewCount === 0,
      savedViewCount,
    },
  });
}
