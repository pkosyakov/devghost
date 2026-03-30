import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveAliasBodySchema } from '@/lib/schemas/contributor';

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

  // Only allow resolving UNRESOLVED or SUGGESTED aliases
  if (alias.resolveStatus !== 'UNRESOLVED' && alias.resolveStatus !== 'SUGGESTED') {
    return apiError('Only UNRESOLVED or SUGGESTED aliases can be resolved', 400);
  }

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid request body', 400);
  const parsed = resolveAliasBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  // Validate target contributor belongs to workspace
  const contributor = await prisma.contributor.findFirst({
    where: { id: parsed.data.contributorId, workspaceId: workspace.id },
  });
  if (!contributor) return apiError('Target contributor not found', 404);

  // If alias is already attached to a contributor, ensure the source won't be orphaned
  if (alias.contributorId && alias.contributorId !== parsed.data.contributorId) {
    const sourceAliasCount = await prisma.contributorAlias.count({
      where: { contributorId: alias.contributorId, id: { not: aliasId } },
    });
    if (sourceAliasCount === 0) {
      return apiError('Cannot move the last alias from a contributor — unmerge or delete the contributor instead', 400);
    }
  }

  const updated = await prisma.contributorAlias.update({
    where: { id: aliasId },
    data: {
      contributorId: parsed.data.contributorId,
      resolveStatus: 'MANUAL',
      mergeReason: 'manual',
      confidence: 1.0,
    },
  });

  await prisma.curationAuditLog.create({
    data: {
      workspaceId: workspace.id,
      contributorId: parsed.data.contributorId,
      aliasId,
      action: 'MERGE',
      payload: {
        target: 'alias_resolve',
        aliasEmail: alias.email,
        previousContributorId: alias.contributorId,
      },
      performedByUserId: session.user.id,
    },
  });

  const updatedContributor = await prisma.contributor.findFirst({
    where: { id: parsed.data.contributorId },
    include: { aliases: true },
  });

  return apiResponse({ alias: updated, contributor: updatedContributor });
}
