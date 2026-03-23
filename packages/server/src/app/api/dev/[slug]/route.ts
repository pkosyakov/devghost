import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { logger } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;

    const profile = await prisma.developerProfile.findUnique({
      where: { slug },
      include: {
        user: { select: { email: true, name: true, githubUsername: true } },
      },
    });

    if (!profile || !profile.isActive) {
      return NextResponse.json(
        { success: false, error: 'Not found' },
        { status: 404 },
      );
    }

    // Increment view count (fire-and-forget)
    prisma.developerProfile
      .update({
        where: { id: profile.id },
        data: { viewCount: { increment: 1 } },
      })
      .catch((err) => {
        logger.debug({ err, profileId: profile.id }, 'Failed to increment viewCount');
      });

    return NextResponse.json({
      success: true,
      data: {
        slug: profile.slug,
        displayName: profile.displayName,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        githubUsername: profile.user.githubUsername,
        viewCount: profile.viewCount,
        createdAt: profile.createdAt,
      },
    });
  } catch (err) {
    logger.error({ err }, 'GET /api/dev/[slug] failed');
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
