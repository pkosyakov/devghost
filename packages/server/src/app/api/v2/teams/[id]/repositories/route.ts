import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { teamRepositoriesQuerySchema } from '@/lib/schemas/team';
import { getTeamRepositories } from '@/lib/services/team-service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const qp = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = teamRepositoriesQuerySchema.safeParse(qp);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const result = await getTeamRepositories(id, workspace.id, parsed.data);
  if (!result) {
    return apiError('Team not found', 404);
  }

  return apiResponse(result);
}
