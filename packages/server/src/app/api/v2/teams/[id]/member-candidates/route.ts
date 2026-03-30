import { NextRequest } from 'next/server';
import { apiError, apiResponse, isErrorResponse, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { teamMemberCandidatesQuerySchema } from '@/lib/schemas/team';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { resolveActiveScope, scopeDateRangeToDates } from '@/lib/services/active-scope-service';
import { getTeamMemberCandidates } from '@/lib/services/team-service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);
  const query = Object.fromEntries(request.nextUrl.searchParams.entries());

  const parsedQuery = teamMemberCandidatesQuerySchema.safeParse(query);
  if (!parsedQuery.success) {
    return apiError(parsedQuery.error.errors[0].message, 400);
  }

  const parsedScope = activeScopeQuerySchema.safeParse(query);
  if (!parsedScope.success) {
    return apiError(parsedScope.error.errors[0].message, 400);
  }

  const resolvedScope = await resolveActiveScope(workspace.id, parsedScope.data, {
    routeTeamId: id,
    actorUserId: session.user.id,
  });

  const result = await getTeamMemberCandidates(id, workspace.id, {
    search: parsedQuery.data.search,
    repository: parsedQuery.data.repository,
    classification: parsedQuery.data.classification,
    sort: parsedQuery.data.sort,
    dateRange: scopeDateRangeToDates(resolvedScope.dateRange),
  });

  if (!result) {
    return apiError('Team not found', 404);
  }

  return apiResponse(result);
}
