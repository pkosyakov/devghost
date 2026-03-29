import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { mergeBodySchema } from '@/lib/schemas/contributor';

export async function POST(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const workspace = await ensureWorkspaceForUser(session.user.id);

  const body = await request.json();
  const parsed = mergeBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const { fromContributorId, toContributorId } = parsed.data;

  // Validate both belong to workspace
  const [from, to] = await Promise.all([
    prisma.contributor.findFirst({ where: { id: fromContributorId, workspaceId: workspace.id } }),
    prisma.contributor.findFirst({ where: { id: toContributorId, workspaceId: workspace.id } }),
  ]);

  if (!from) return apiError('Source contributor not found', 404);
  if (!to) return apiError('Target contributor not found', 404);

  // Transactional merge
  const result = await prisma.$transaction(async (tx: any) => {
    // Move all aliases from source to target
    await tx.contributorAlias.updateMany({
      where: { contributorId: fromContributorId },
      data: {
        contributorId: toContributorId,
        resolveStatus: 'MANUAL',
        mergeReason: 'manual',
      },
    });

    // Audit log
    await tx.curationAuditLog.create({
      data: {
        workspaceId: workspace.id,
        contributorId: toContributorId,
        action: 'MERGE',
        payload: {
          fromContributorId,
          toContributorId,
          fromDisplayName: from.displayName,
          fromEmail: from.primaryEmail,
        },
        performedByUserId: session.user.id,
      },
    });

    // Delete source contributor
    await tx.contributor.delete({ where: { id: fromContributorId } });

    // Return updated target
    return tx.contributor.findFirst({
      where: { id: toContributorId },
      include: { aliases: true },
    });
  });

  return apiResponse({ contributor: result });
}
