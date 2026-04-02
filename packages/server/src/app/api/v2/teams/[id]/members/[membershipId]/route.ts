import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveEffectiveUser, isEffectiveUserError } from '@/lib/view-as';
import { updateMemberBodySchema } from '@/lib/schemas/team';
import { updateMembership, removeMembership } from '@/lib/services/team-service';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; membershipId: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id, membershipId } = await params;
  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);

  const parsed = await parseBody(request, updateMemberBodySchema);
  if (!parsed.success) return parsed.error;

  const result = await updateMembership(membershipId, id, workspace.id, parsed.data);

  if ('error' in result && result.error) {
    const status = result.error.includes('overlap') ? 409 : 404;
    return apiError(result.error, status);
  }

  return apiResponse('membership' in result ? result.membership : result);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; membershipId: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id, membershipId } = await params;
  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);

  const result = await removeMembership(membershipId, id, workspace.id);

  if ('error' in result && result.error) {
    return apiError(result.error, 404);
  }

  return apiResponse({ success: true });
}
