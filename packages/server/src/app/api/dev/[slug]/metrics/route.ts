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
      include: { user: { select: { email: true } } },
    });

    if (!profile || !profile.isActive) {
      return NextResponse.json(
        { success: false, error: 'Not found' },
        { status: 404 },
      );
    }

    // Build order filter
    const includedIds = profile.includedOrderIds as string[] | null;
    const orderWhere = includedIds
      ? { id: { in: includedIds }, status: 'COMPLETED' as const }
      : { userId: profile.userId, status: 'COMPLETED' as const };

    const orders = await prisma.order.findMany({
      where: orderWhere,
      select: { id: true, name: true, selectedRepos: true },
    });

    // Get metrics for this developer across selected orders
    const metrics = await prisma.orderMetric.findMany({
      where: {
        orderId: { in: orders.map((o) => o.id) },
        developerEmail: profile.user.email,
        periodType: 'ALL_TIME',
      },
      select: {
        orderId: true,
        commitCount: true,
        workDays: true,
        totalEffortHours: true,
        avgDailyEffort: true,
        ghostPercent: true,
        share: true,
      },
    });

    // Map order names
    const orderMap = new Map(orders.map((o) => [o.id, o]));
    const enriched = metrics.map((m) => ({
      ...m,
      totalEffortHours: Number(m.totalEffortHours),
      avgDailyEffort: Number(m.avgDailyEffort),
      ghostPercent: m.ghostPercent ? Number(m.ghostPercent) : null,
      share: Number(m.share),
      orderName: orderMap.get(m.orderId)?.name || 'Unknown',
      repos:
        (orderMap.get(m.orderId)?.selectedRepos as any[])?.map(
          (r) =>
            r.fullName ||
            r.full_name ||
            `${(r.owner as any)?.login}/${r.name}`,
        ) || [],
    }));

    // Aggregate summary
    const summary = {
      totalOrders: metrics.length,
      totalCommits: metrics.reduce((s, m) => s + m.commitCount, 0),
      totalWorkDays: metrics.reduce((s, m) => s + m.workDays, 0),
      totalEffortHours: metrics.reduce(
        (s, m) => s + Number(m.totalEffortHours || 0),
        0,
      ),
      avgGhostPercent:
        metrics.length > 0
          ? metrics.reduce((s, m) => s + Number(m.ghostPercent || 0), 0) /
            metrics.length
          : null,
    };

    return NextResponse.json({
      success: true,
      data: { summary, orders: enriched },
    });
  } catch (err) {
    logger.error({ err }, 'GET /api/dev/[slug]/metrics failed');
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
