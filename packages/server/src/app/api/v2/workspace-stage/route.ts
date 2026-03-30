import { apiResponse, isErrorResponse, requireUserSession } from '@/lib/api-utils';
import { prisma } from '@/lib/db';
import { buildSavedViewReadableWhere } from '@/lib/saved-view-access';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';

export async function GET() {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);
  const workspaceId = workspace.id;

  const [teamCount, repoCount, contributorCount, savedViewCount] = await Promise.all([
    prisma.team.count({ where: { workspaceId } }),
    prisma.repository.count({ where: { workspaceId } }),
    prisma.contributor.count({ where: { workspaceId } }),
    prisma.savedView.count({
      where: {
        ...buildSavedViewReadableWhere(workspaceId, session.user.id),
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
