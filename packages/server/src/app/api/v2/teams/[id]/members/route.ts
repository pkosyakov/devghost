import { NextRequest } from 'next/server';
import { apiResponse, apiError, requireUserSession, isErrorResponse, parseBody } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { addMemberBodySchema } from '@/lib/schemas/team';
import { addMember } from '@/lib/services/team-service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const parsed = await parseBody(request, addMemberBodySchema);
  if (!parsed.success) return parsed.error;

  const result = await addMember(id, workspace.id, parsed.data);

  if ('error' in result && result.error) {
    const status = result.error.includes('overlap') ? 409 : 404;
    return apiError(result.error, status);
  }

  return apiResponse('membership' in result ? result.membership : result, 201);
}
