import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { ensureWorkspaceForUser } from '@/lib/services/workspace-service';
import { resolveEffectiveUser, isEffectiveUserError } from '@/lib/view-as';
import { paginationQuerySchema } from '@/lib/schemas/contributor';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { id } = await params;
  const effective = await resolveEffectiveUser(session, request.nextUrl.searchParams);
  if (isEffectiveUserError(effective)) return effective;
  const workspace = await ensureWorkspaceForUser(effective.effectiveUserId);

  // Verify contributor belongs to workspace
  const contributor = await prisma.contributor.findFirst({
    where: { id, workspaceId: workspace.id },
    include: { aliases: { select: { email: true } } },
  });

  if (!contributor) {
    return apiError('Contributor not found', 404);
  }

  const queryParams = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = paginationQuerySchema.safeParse(queryParams);
  if (!parsed.success) {
    return apiError(parsed.error.errors[0].message, 400);
  }

  const { page, pageSize } = parsed.data;
  const aliasEmails = contributor.aliases.map((a) => a.email);

  const [commits, total] = await Promise.all([
    prisma.commitAnalysis.findMany({
      where: {
        order: { userId: effective.effectiveUserId },
        authorEmail: { in: aliasEmails },
      },
      select: {
        commitHash: true,
        commitMessage: true,
        repository: true,
        authorDate: true,
        effortHours: true,
      },
      orderBy: { authorDate: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.commitAnalysis.count({
      where: {
        order: { userId: effective.effectiveUserId },
        authorEmail: { in: aliasEmails },
      },
    }),
  ]);

  return apiResponse({
    commits: commits.map((c) => ({
      sha: c.commitHash,
      message: c.commitMessage,
      repo: c.repository,
      authoredAt: c.authorDate,
      effortHours: c.effortHours != null ? Number(c.effortHours) : null,
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  });
}
