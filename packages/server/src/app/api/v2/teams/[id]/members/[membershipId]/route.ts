import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { updateMemberBodySchema } from '@/lib/schemas/team';
import { updateMembership, removeMembership } from '@/lib/services/team-service';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; membershipId: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id, membershipId } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const body = await parseBody(request, updateMemberBodySchema);
  if (isErrorResponse(body)) return body;

  const result = await updateMembership(membershipId, id, workspace.id, body);

  if ('error' in result) {
    const status = result.error.includes('overlap') ? 409 : 404;
    return apiError(result.error, status);
  }

  return apiResponse(result.membership);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; membershipId: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id, membershipId } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const result = await removeMembership(membershipId, id, workspace.id);

  if ('error' in result) {
    return apiError(result.error, 404);
  }

  return apiResponse({ success: true });
}
