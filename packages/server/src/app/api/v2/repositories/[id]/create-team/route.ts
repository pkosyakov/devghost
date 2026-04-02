import { NextRequest } from 'next/server';
import {
  apiResponse,
  apiError,
  requireUserSession,
  isErrorResponse,
  parseBody,
} from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveEffectiveUser, isEffectiveUserError } from '@/lib/view-as';
import { createTeamFromRepository } from '@/lib/services/team-service';
import { createTeamFromRepositoryBodySchema } from '@/lib/schemas/team';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);
  const { id: repositoryId } = await params;

  const parsed = await parseBody(request, createTeamFromRepositoryBodySchema);
  if (!parsed.success) return parsed.error;

  const payload = {
    ...parsed.data,
    contributorIds: parsed.data.contributorIds ?? [],
  };

  const result = await createTeamFromRepository(workspace.id, repositoryId, payload);
  if ('error' in result) {
    const errorMessage = result.error ?? 'Failed to create team from repository';
    if (errorMessage === 'Repository not found') return apiError(errorMessage, 404);
    if (errorMessage === 'Workspace not found') return apiError(errorMessage, 404);
    if (errorMessage === 'A team with this name already exists') return apiError(errorMessage, 409);
    if (errorMessage === 'One or more contributors are not associated with this repository') {
      return apiError(errorMessage, 400);
    }
    return apiError(errorMessage, 400);
  }

  return apiResponse(result.team, 201);
}
