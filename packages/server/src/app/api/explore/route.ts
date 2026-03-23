import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'explore' });

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const rawPage = Number(searchParams.get('page'));
    const page = Math.max(1, Number.isFinite(rawPage) ? rawPage : 1);
    const rawPageSize = Number(searchParams.get('pageSize'));
    const pageSize = Math.min(50, Math.max(1, Number.isFinite(rawPageSize) ? rawPageSize : 20));
    const search = searchParams.get('search') || '';
    const featured = searchParams.get('featured') === 'true';

    const where = {
      isActive: true,
      ...(featured && { isFeatured: true }),
      ...(search && {
        OR: [
          { slug: { contains: search, mode: 'insensitive' as const } },
          { title: { contains: search, mode: 'insensitive' as const } },
          { description: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [items, total] = await Promise.all([
      prisma.repoPublication.findMany({
        where,
        orderBy: [{ isFeatured: 'desc' }, { sortOrder: 'asc' }, { viewCount: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          owner: true,
          repo: true,
          slug: true,
          publishType: true,
          isFeatured: true,
          title: true,
          description: true,
          viewCount: true,
          createdAt: true,
        },
      }),
      prisma.repoPublication.count({ where }),
    ]);

    return NextResponse.json({
      success: true,
      data: { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    log.error({ err: error }, 'Failed to fetch explore catalog');
    return NextResponse.json(
      { success: false, error: 'Failed to fetch explore catalog' },
      { status: 500 },
    );
  }
}
