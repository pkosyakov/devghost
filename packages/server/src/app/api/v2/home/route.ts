import { NextRequest } from 'next/server';
import { apiError, apiResponse, isErrorResponse, requireUserSession } from '@/lib/api-utils';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { getHomeDetail } from '@/lib/services/home-service';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const parsed = activeScopeQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const detail = await getHomeDetail(workspace.id, session.user.id, parsed.data);
  if (!detail) {
    return apiError('Workspace not found', 404);
  }

  return apiResponse(detail);
}
