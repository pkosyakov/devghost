import { NextRequest } from 'next/server';
import { apiError, apiResponse, isErrorResponse, parseBody, requireUserSession } from '@/lib/api-utils';
import { activeScopeQuerySchema } from '@/lib/schemas/scope';
import { updateSavedViewBodySchema } from '@/lib/schemas/saved-view';
import { getSavedViewDetail, updateSavedView } from '@/lib/services/saved-view-service';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveEffectiveUser, isEffectiveUserError } from '@/lib/view-as';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);
  const { id } = await context.params;

  const activeScopeParse = activeScopeQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  const activeScope = activeScopeParse.success ? activeScopeParse.data : null;

  const detail = await getSavedViewDetail(id, workspace.id, effective.effectiveUserId, activeScope);
  if (!detail) {
    return apiError('Saved view not found', 404);
  }

  return apiResponse(detail);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);
  const { id } = await context.params;

  const parsed = await parseBody(request, updateSavedViewBodySchema);
  if (!parsed.success) return parsed.error;

  const result = await updateSavedView(id, workspace.id, effective.effectiveUserId, parsed.data);
  if (result.count === 0) {
    return apiError('Saved view not found', 404);
  }

  const detail = await getSavedViewDetail(id, workspace.id, effective.effectiveUserId);
  return apiResponse(detail);
}
