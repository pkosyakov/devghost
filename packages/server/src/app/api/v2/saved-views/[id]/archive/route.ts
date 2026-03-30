import { apiError, apiResponse, isErrorResponse, requireUserSession } from '@/lib/api-utils';
import { archiveSavedView } from '@/lib/services/saved-view-service';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_: Request, context: RouteContext) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);
  const { id } = await context.params;

  const result = await archiveSavedView(id, workspace.id, session.user.id);
  if (result.count === 0) {
    return apiError('Saved view not found', 404);
  }

  return apiResponse({ success: true });
}
