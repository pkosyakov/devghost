import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { updateTeamBodySchema, teamRepositoriesQuerySchema } from '@/lib/schemas/team';
import { getTeamDetail, updateTeam, deleteTeam } from '@/lib/services/team-service';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  // Optional scope date range from query params (Slice 3 local scope)
  const qp = Object.fromEntries(request.nextUrl.searchParams);
  const scopeParsed = teamRepositoriesQuerySchema.safeParse(qp);
  const scopeRange = scopeParsed.success ? scopeParsed.data : undefined;

  const detail = await getTeamDetail(id, workspace.id, scopeRange);
  if (!detail) {
    return apiError('Team not found', 404);
  }

  return apiResponse(detail);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const body = await parseBody(request, updateTeamBodySchema);
  if (isErrorResponse(body)) return body;

  try {
    const result = await updateTeam(id, workspace.id, body);
    if (result.count === 0) {
      return apiError('Team not found', 404);
    }
    return apiResponse({ success: true });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return apiError('A team with this name already exists', 409);
    }
    throw err;
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const result = await deleteTeam(id, workspace.id);
  if (result.count === 0) {
    return apiError('Team not found', 404);
  }

  return apiResponse({ success: true });
}
