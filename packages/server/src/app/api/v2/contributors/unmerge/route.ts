import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveEffectiveUser, isEffectiveUserError } from '@/lib/view-as';
import { unmergeBodySchema } from '@/lib/schemas/contributor';

export async function POST(request: NextRequest) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);

  const body = await request.json().catch(() => null);
  if (!body) return apiError('Invalid request body', 400);
  const parsed = unmergeBodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const { contributorId, aliasIds } = parsed.data;

  // Validate contributor belongs to workspace
  const contributor = await prisma.contributor.findFirst({
    where: { id: contributorId, workspaceId: workspace.id },
    include: { aliases: true },
  });

  if (!contributor) return apiError('Contributor not found', 404);

  // Validate all aliasIds belong to this contributor
  const aliasIdsSet = new Set(aliasIds);
  const ownedAliases = contributor.aliases.filter((a) => aliasIdsSet.has(a.id));
  if (ownedAliases.length !== aliasIds.length) {
    return apiError('Some aliases do not belong to this contributor', 400);
  }

  // Must leave at least one alias on the original
  const remainingCount = contributor.aliases.length - aliasIds.length;
  if (remainingCount < 1) {
    return apiError('Cannot extract all aliases — original contributor must keep at least one', 400);
  }

  // Transactional unmerge
  let result;
  try {
    result = await prisma.$transaction(async (tx: any) => {
      // Pick display info from first extracted alias
      const primaryAlias = ownedAliases[0];

      // Check for primaryEmail collision before creating
      const existingWithEmail = await tx.contributor.findFirst({
        where: { workspaceId: workspace.id, primaryEmail: primaryAlias.email },
      });
      if (existingWithEmail) {
        throw new Error(`CONFLICT:A contributor with email ${primaryAlias.email} already exists`);
      }

      // Create new contributor from extracted aliases
      const newContributor = await tx.contributor.create({
        data: {
          workspaceId: workspace.id,
          displayName: primaryAlias.username || primaryAlias.email,
          primaryEmail: primaryAlias.email,
        },
      });

      // Move aliases to new contributor
      await tx.contributorAlias.updateMany({
        where: { id: { in: aliasIds } },
        data: {
          contributorId: newContributor.id,
          resolveStatus: 'MANUAL',
          mergeReason: 'manual',
        },
      });

      // Audit log
      await tx.curationAuditLog.create({
        data: {
          workspaceId: workspace.id,
          contributorId,
          action: 'UNMERGE',
          payload: {
            newContributorId: newContributor.id,
            extractedAliasIds: aliasIds,
            ...(effective.isViewingAs && { viewAsUserId: effective.effectiveUserId }),
          },
          performedByUserId: session.user.id,
        },
      });

      const [original, created] = await Promise.all([
        tx.contributor.findFirst({
          where: { id: contributorId },
          include: { aliases: true },
        }),
        tx.contributor.findFirst({
          where: { id: newContributor.id },
          include: { aliases: true },
        }),
      ]);

      return { original, newContributor: created };
    });
  } catch (err: any) {
    if (err?.message?.startsWith('CONFLICT:')) {
      return apiError(err.message.replace('CONFLICT:', ''), 409);
    }
    throw err;
  }

  return apiResponse(result);
}
