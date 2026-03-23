import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireAdmin, isErrorResponse, apiResponse, apiError, parseBody } from '@/lib/api-utils';
import { logger } from '@/lib/logger';
import { adminCreatePublicationSchema } from '@/lib/schemas';

const log = logger.child({ module: 'admin/publications' });

export async function GET(request: NextRequest) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const { searchParams } = new URL(request.url);

  const rawPage = parseInt(searchParams.get('page') ?? '', 10);
  const rawPageSize = parseInt(searchParams.get('pageSize') ?? '', 10);
  const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1);
  const pageSize = Math.min(50, Math.max(1, Number.isFinite(rawPageSize) ? rawPageSize : 20));
  const search = searchParams.get('search') || '';
  const type = searchParams.get('type') || '';

  const where: Record<string, unknown> = {};

  if (type) {
    where.publishType = type;
  }

  if (search) {
    where.OR = [
      { slug: { contains: search, mode: 'insensitive' as const } },
      { title: { contains: search, mode: 'insensitive' as const } },
    ];
  }

  try {
    const [items, total] = await Promise.all([
      prisma.repoPublication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          publishedBy: { select: { name: true, email: true } },
          order: { select: { name: true, status: true } },
        },
      }),
      prisma.repoPublication.count({ where }),
    ]);

    return apiResponse({
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    log.error({ err }, 'Failed to fetch publications');
    return apiError('Failed to fetch publications', 500);
  }
}

export async function POST(request: NextRequest) {
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  try {
    const parsed = await parseBody(request, adminCreatePublicationSchema);
    if (!parsed.success) return parsed.error;
    const { orderId, repository, title, description, isFeatured } = parsed.data;

    // Admin: no ownership filter, just check order exists and is completed
    const order = await prisma.order.findFirst({
      where: { id: orderId, status: 'COMPLETED' },
    });

    if (!order) {
      return apiError('Order not found or not completed', 404);
    }

    const [owner, repo] = repository.split('/');

    // Verify repo exists in order's selectedRepos
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

    // Duplicate slug check
    const existing = await prisma.repoPublication.findUnique({ where: { slug } });
    if (existing) {
      return apiError('Publication already exists for this repository', 409);
    }

    const publication = await prisma.repoPublication.create({
      data: {
        owner,
        repo,
        slug,
        orderId,
        publishedById: session.user.id,
        publishType: 'ADMIN',
        title,
        description,
        isFeatured: isFeatured ?? false,
      },
    });

    log.info({ publicationId: publication.id, slug }, 'Admin publication created');

    return apiResponse(publication, 201);
  } catch (err) {
    log.error({ err }, 'Failed to create publication');
    return apiError('Failed to create publication', 500);
  }
}
