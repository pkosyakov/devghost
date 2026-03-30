import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { teamListQuerySchema, createTeamBodySchema } from '@/lib/schemas/team';
import { listTeams, createTeam } from '@/lib/services/team-service';
import { resolveActiveScope, scopeDateRangeToDates } from '@/lib/services/active-scope-service';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = teamListQuerySchema.safeParse(params);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const parsedScope = activeScopeQuerySchema.safeParse(params);
  if (!parsedScope.success) {
    return apiError(parsedScope.error.errors[0].message, 400);
  }

  const resolvedScope = await resolveActiveScope(workspace.id, parsedScope.data, {
    actorUserId: session.user.id,
  });
  const result = await listTeams(workspace.id, {
    ...parsed.data,
    teamIds: resolvedScope.teamIds.length > 0 ? resolvedScope.teamIds : undefined,
    dateRange: scopeDateRangeToDates(resolvedScope.dateRange),
  });
  return apiResponse(result);
}

export async function POST(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const parsed = await parseBody(request, createTeamBodySchema);
  if (!parsed.success) return parsed.error;

  try {
    const team = await createTeam(workspace.id, parsed.data);
    return apiResponse(team, 201);
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return apiError('A team with this name already exists', 409);
    }
    throw err;
  }
}
