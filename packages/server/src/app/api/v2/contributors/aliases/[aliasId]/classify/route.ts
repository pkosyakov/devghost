import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { classifyAliasBodySchema } from '@/lib/schemas/contributor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ aliasId: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { aliasId } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const alias = await prisma.contributorAlias.findFirst({
    where: { id: aliasId, workspaceId: workspace.id },
  });
  if (!alias) return apiError('Alias not found', 404);

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid request body', 400);
  const parsed = classifyAliasBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const updated = await prisma.contributorAlias.update({
    where: { id: aliasId },
    data: { classificationHint: parsed.data.classificationHint },
  });

  await prisma.curationAuditLog.create({
    data: {
      workspaceId: workspace.id,
      contributorId: alias.contributorId,
      aliasId,
      action: 'CLASSIFY',
      payload: {
        target: 'alias',
        previousHint: alias.classificationHint,
        newHint: parsed.data.classificationHint,
      },
      performedByUserId: session.user.id,
    },
  });

  return apiResponse({ alias: updated });
}
