import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { getTeamRepositories } from '@/lib/services/team-service';
import { resolveActiveScope, scopeDateRangeToDates } from '@/lib/services/active-scope-service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const qp = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = activeScopeQuerySchema.safeParse(qp);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const resolvedScope = await resolveActiveScope(workspace.id, parsed.data, {
    routeTeamId: id,
    actorUserId: session.user.id,
  });
  const result = await getTeamRepositories(id, workspace.id, scopeDateRangeToDates(resolvedScope.dateRange));
  if (!result) {
    return apiError('Team not found', 404);
  }

  return apiResponse(result);
}
