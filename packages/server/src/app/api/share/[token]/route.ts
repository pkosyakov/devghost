import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { computeRepoMetrics } from '@/lib/services/publication-metrics';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'share' });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await params;

    const publication = await prisma.repoPublication.findUnique({
      where: { shareToken: token },
      include: {
        publishedBy: { select: { name: true } },
      },
    });

    if (!publication || !publication.isActive) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }

    // Increment view count (fire-and-forget)
    prisma.repoPublication.update({
      where: { id: publication.id },
      data: { viewCount: { increment: 1 } },
    }).catch((err) => { log.debug({ err }, 'View count increment failed'); });

    const visibleDevs = publication.visibleDevelopers as string[] | null;
    const metrics = await computeRepoMetrics(
      publication.orderId,
      `${publication.owner}/${publication.repo}`,
      visibleDevs,
    );

    return NextResponse.json({
      success: true,
      data: {
        publication: {
          id: publication.id,
          owner: publication.owner,
          repo: publication.repo,
          slug: publication.slug,
          title: publication.title || `${publication.owner}/${publication.repo}`,
          description: publication.description,
          viewCount: publication.viewCount,
          publishedBy: publication.publishedBy.name,
          createdAt: publication.createdAt,
        },
        metrics,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Failed to fetch shared publication');
    return NextResponse.json(
      { success: false, error: 'Failed to fetch shared publication' },
      { status: 500 },
    );
  }
}
