import { NextRequest } from 'next/server';
import { apiError, apiResponse, isErrorResponse, requireUserSession } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveEffectiveUser, isEffectiveUserError } from '@/lib/view-as';
import {
  createSavedView,
  createSavedViewFromActiveScope,
  listSavedViews,
} from '@/lib/services/saved-view-service';
import {
  createSavedViewBodySchema,
  createSavedViewFromScopeBodySchema,
  savedViewListQuerySchema,
} from '@/lib/schemas/saved-view';

export async function GET(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);

  const parsed = savedViewListQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const result = await listSavedViews(workspace.id, effective.effectiveUserId, parsed.data);
  return apiResponse(result);
}

export async function POST(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);

  const body = await request.json().catch(() => null);
  if (!body) {
    return apiError('Invalid JSON body', 400);
  }

  const parsedFromScope = createSavedViewFromScopeBodySchema.safeParse(body);
  if (parsedFromScope.success) {
    const savedView = await createSavedViewFromActiveScope(
      workspace.id,
      effective.effectiveUserId,
      parsedFromScope.data,
    );
    return apiResponse(savedView, 201);
  }

  const parsed = createSavedViewBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const savedView = await createSavedView(workspace.id, effective.effectiveUserId, parsed.data);
  return apiResponse(savedView, 201);
}


