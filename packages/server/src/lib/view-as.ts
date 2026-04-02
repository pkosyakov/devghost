import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { apiError } from '@/lib/api-utils';
import type { UserSession } from '@/lib/api-utils';

export interface EffectiveUser {
  /** The userId whose workspace should be queried. */
  effectiveUserId: string;
  /** True when the admin is viewing as another user. */
  isViewingAs: boolean;
  /** When viewing as, contains the target user's display info. */
  viewAsUser?: { id: string; email: string; name: string | null };
}

/**
 * Resolves the effective userId from a `viewAs` query parameter.
 *
 * - No `viewAs` param → returns session user's own id.
 * - `viewAs` present + ADMIN role → validates target user, returns their id.
 * - `viewAs` present + non-ADMIN → 403.
 */
export async function resolveEffectiveUser(
  session: UserSession,
  searchParams: URLSearchParams,
): Promise<EffectiveUser | NextResponse> {
  const viewAsUserId = searchParams.get('viewAs');

  if (!viewAsUserId) {
    return { effectiveUserId: session.user.id, isViewingAs: false };
  }

  if (session.user.role !== 'ADMIN') {
    return apiError('Forbidden: viewAs requires ADMIN role', 403);
  }

  // Admin viewing their own workspace — skip DB lookup
  if (viewAsUserId === session.user.id) {
    return { effectiveUserId: session.user.id, isViewingAs: false };
  }

  const targetUser = await prisma.user.findUnique({
    where: { id: viewAsUserId },
    select: { id: true, email: true, name: true, isBlocked: true },
  });

  if (!targetUser) {
    return apiError('Target user not found', 404);
  }

  if (targetUser.isBlocked) {
    return apiError('Target user is blocked', 403);
  }

  // Verify the target user has a workspace — don't auto-create via ensureWorkspaceForUser
  const workspace = await prisma.workspace.findUnique({
    where: { ownerId: viewAsUserId },
    select: { id: true },
  });
  if (!workspace) {
    return apiError('Target user has no workspace yet', 404);
  }

  return {
    effectiveUserId: targetUser.id,
    isViewingAs: true,
    viewAsUser: { id: targetUser.id, email: targetUser.email, name: targetUser.name },
  };
}

/**
 * Type guard: true when resolveEffectiveUser returned an error response.
 */
export function isEffectiveUserError(
  result: EffectiveUser | NextResponse,
): result is NextResponse {
  return result instanceof NextResponse;
}
