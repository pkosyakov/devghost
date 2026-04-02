import { NextRequest } from 'next/server';
import { apiError, apiResponse, isErrorResponse, requireUserSession } from '@/lib/api-utils';
import { restoreSavedView } from '@/lib/services/saved-view-service';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveEffectiveUser, isEffectiveUserError } from '@/lib/view-as';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);
  const { id } = await context.params;

  const result = await restoreSavedView(id, workspace.id, effective.effectiveUserId);
  if (result.count === 0) {
    return apiError('Saved view not found', 404);
  }

  return apiResponse({ success: true });
}
