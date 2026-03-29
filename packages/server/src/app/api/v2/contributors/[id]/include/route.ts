import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const workspace = await ensureWorkspaceForUser(session.user.id);

  const contributor = await prisma.contributor.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!contributor) return apiError('Contributor not found', 404);

  const updated = await prisma.contributor.update({
    where: { id },
    data: { isExcluded: false, excludedAt: null },
    include: { aliases: true },
  });

  await prisma.curationAuditLog.create({
    data: {
      workspaceId: workspace.id,
      contributorId: id,
      action: 'INCLUDE',
      payload: {},
      performedByUserId: session.user.id,
    },
  });

  return apiResponse({ contributor: updated });
}
