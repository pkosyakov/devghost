import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { computeRepoMetrics } from '@/lib/services/publication-metrics';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'explore-detail' });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ owner: string; repo: string }> }
) {
  try {
    const { owner, repo } = await params;
    const slug = `${owner}/${repo}`;

    const publication = await prisma.repoPublication.findUnique({
      where: { slug },
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

    // Compute per-repo metrics
    const visibleDevs = publication.visibleDevelopers as string[] | null;
    const metrics = await computeRepoMetrics(
      publication.orderId,
      `${owner}/${repo}`,
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
          title: publication.title || `${owner}/${repo}`,
          description: publication.description,
          isFeatured: publication.isFeatured,
          viewCount: publication.viewCount,
          publishedBy: publication.publishedBy.name,
          createdAt: publication.createdAt,
        },
        metrics,
      },
    });
  } catch (error) {
    log.error({ err: error }, 'Failed to fetch repo detail');
    return NextResponse.json(
      { success: false, error: 'Failed to fetch repo detail' },
      { status: 500 },
    );
  }
}
