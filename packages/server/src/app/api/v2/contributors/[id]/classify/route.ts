import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveEffectiveUser, isEffectiveUserError } from '@/lib/view-as';
import { classifyContributorBodySchema } from '@/lib/schemas/contributor';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);

  const contributor = await prisma.contributor.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!contributor) return apiError('Contributor not found', 404);

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid request body', 400);
  const parsed = classifyContributorBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const updated = await prisma.contributor.update({
    where: { id },
    data: { classification: parsed.data.classification },
    include: { aliases: true },
  });

  await prisma.curationAuditLog.create({
    data: {
      workspaceId: workspace.id,
      contributorId: id,
      action: 'CLASSIFY',
      payload: {
        previousClassification: contributor.classification,
        newClassification: parsed.data.classification,
        ...(effective.isViewingAs && { viewAsUserId: effective.effectiveUserId }),
      },
      performedByUserId: session.user.id,
    },
  });

  return apiResponse({ contributor: updated });
}
