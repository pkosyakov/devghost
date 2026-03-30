import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { updateTeamBodySchema } from '@/lib/schemas/team';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { getTeamDetail, updateTeam, deleteTeam } from '@/lib/services/team-service';
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
  const scopeParsed = activeScopeQuerySchema.safeParse(qp);
  if (!scopeParsed.success) {
    return apiError(scopeParsed.error.errors[0].message, 400);
  }
  const scopeRange = await resolveActiveScope(workspace.id, scopeParsed.data, {
    routeTeamId: id,
    actorUserId: session.user.id,
  });

  const detail = await getTeamDetail(id, workspace.id, scopeDateRangeToDates(scopeRange.dateRange));
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

  const parsed = await parseBody(request, updateTeamBodySchema);
  if (!parsed.success) return parsed.error;

  try {
    const result = await updateTeam(id, workspace.id, parsed.data);
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
