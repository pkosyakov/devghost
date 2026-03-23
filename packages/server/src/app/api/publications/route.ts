import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiResponse, apiError, parseBody } from '@/lib/api-utils';
import { createId } from '@paralleldrive/cuid2';
import { logger } from '@/lib/logger';
import { createPublicationSchema } from '@/lib/schemas';

const log = logger.child({ module: 'publications' });

export async function GET(request: NextRequest) {
  try {
    const session = await requireUserSession();
    if (isErrorResponse(session)) return session;

    const publications = await prisma.repoPublication.findMany({
      where: { publishedById: session.user.id },
      orderBy: { createdAt: 'desc' },
      include: { order: { select: { name: true, status: true } } },
    });

    return apiResponse(publications);
  } catch (error) {
    log.error({ err: error }, 'Failed to fetch publications');
    return apiError('Failed to fetch publications', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await requireUserSession();
    if (isErrorResponse(session)) return session;

    const parsed = await parseBody(request, createPublicationSchema);
    if (!parsed.success) return parsed.error;
    const { orderId, repository, visibleDevelopers } = parsed.data;

    // Verify order ownership and status
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId: session.user.id, status: 'COMPLETED' },
    });

    if (!order) {
      return apiError('Order not found or not completed', 404);
    }

    const [owner, repo] = repository.split('/');

    // Verify repo exists in order (selectedRepos uses snake_case: full_name, owner is object { login })
    const repos = order.selectedRepos as Array<Record<string, unknown>>;
    const repoExists = repos.some(r => {
      const fullName = (r.fullName ?? r.full_name) as string | undefined;
      const ownerLogin = (r.owner as any)?.login as string | undefined;
      return fullName === repository || `${ownerLogin}/${r.name}` === repository;
    });
    if (!repoExists) {
      return apiError('Repository not found in this order', 400);
    }

    const slug = `${owner}/${repo}`;

    // Guard against duplicate publication for the same repo
    const existing = await prisma.repoPublication.findUnique({ where: { slug } });
    if (existing) {
      return apiError('Publication already exists for this repository', 409);
    }

    const shareToken = createId();

    const publication = await prisma.repoPublication.create({
      data: {
        owner,
        repo,
        slug,
        orderId,
        publishedById: session.user.id,
        publishType: 'USER',
        shareToken,
        visibleDevelopers: visibleDevelopers ?? undefined,
      },
    });

    log.info({ publicationId: publication.id, slug }, 'Publication created');

    return apiResponse(publication, 201);
  } catch (error) {
    log.error({ err: error }, 'Failed to create publication');
    return apiError('Failed to create publication', 500);
  }
}
