import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireUserSession, isErrorResponse } from '@/lib/api-utils';
import { MIN_WORK_DAYS_FOR_GHOST } from '@devghost/shared';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const { searchParams } = new URL(request.url);
  const period = searchParams.get('period') ?? 'ALL_TIME';

  const validPeriods = ['ALL_TIME', 'YEAR', 'QUARTER', 'MONTH'] as const;
  if (!validPeriods.includes(period as any)) {
    return apiError('Invalid period', 400);
  }

  const metricsWhere: Prisma.OrderMetricWhereInput = {
    orderId: id,
    periodType: period as any,
    ...(session.user.role === 'ADMIN' ? {} : { order: { userId: session.user.id } }),
  };

  const orderMetrics = await prisma.orderMetric.findMany({
    where: metricsWhere,
  });

  if (orderMetrics.length === 0) return apiResponse([]);

  // Fetch all DailyEffort rows for this order (select only needed fields)
  // Aggregate in JS by (email, year, month) to match each OrderMetric row
  const dailyEfforts = await prisma.dailyEffort.findMany({
    where: { orderId: id },
    select: { developerEmail: true, date: true, effortHours: true },
  });

  // Build placed effort lookup: key = "email" | "email|year" | "email|year|month"
  const placedMap = new Map<string, number>();
  for (const de of dailyEfforts) {
    const d = new Date(de.date);
    const email = de.developerEmail;
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    const effort = Number(de.effortHours ?? 0);

    // Always accumulate ALL_TIME key
    const allKey = email;
    placedMap.set(allKey, (placedMap.get(allKey) ?? 0) + effort);

    // Year key
    const yearKey = `${email}|${y}`;
    placedMap.set(yearKey, (placedMap.get(yearKey) ?? 0) + effort);

    // Month key
    const monthKey = `${email}|${y}|${m}`;
    placedMap.set(monthKey, (placedMap.get(monthKey) ?? 0) + effort);

    // Quarter key (Q1=months 1-3, Q2=4-6, Q3=7-9, Q4=10-12)
    const q = Math.ceil(m / 3);
    const quarterKey = `${email}|${y}|Q${q}`;
    placedMap.set(quarterKey, (placedMap.get(quarterKey) ?? 0) + effort);
  }

  // Transform to GhostMetric-compatible format
  const metrics = orderMetrics.map(m => {
    const totalEffort = Number(m.totalEffortHours ?? 0);

    // Build lookup key matching this metric's period
    const placedEffort = getPlacedEffort(placedMap, period, m.developerEmail, m.year, m.month);
    const overheadHours = Math.max(0, Math.round((totalEffort - placedEffort) * 100) / 100);

    return {
      developerId: m.developerEmail,
      developerName: m.developerName,
      developerEmail: m.developerEmail,
      periodType: m.periodType,
      totalEffortHours: totalEffort,
      actualWorkDays: m.workDays ?? 0,
      avgDailyEffort: Number(m.avgDailyEffort ?? 0),
      ghostPercentRaw: m.ghostPercentRaw != null ? Number(m.ghostPercentRaw) : null,
      ghostPercent: m.ghostPercent != null ? Number(m.ghostPercent) : null,
      share: Number(m.share ?? 1),
      shareAutoCalculated: m.shareAutoCalculated,
      commitCount: m.commitCount,
      hasEnoughData: (m.workDays ?? 0) >= MIN_WORK_DAYS_FOR_GHOST,
      fteWorkDays: m.fteWorkDays ?? 0,
      fteAvgDailyEffort: Number(m.fteAvgDailyEffort ?? 0),
      fteGhostPercentRaw: m.fteGhostPercentRaw != null ? Number(m.fteGhostPercentRaw) : null,
      fteGhostPercent: m.fteGhostPercent != null ? Number(m.fteGhostPercent) : null,
      overheadHours,
    };
  });

  return apiResponse(metrics);
}

/** Look up placed effort for a specific metric row's period bucket. */
function getPlacedEffort(
  placedMap: Map<string, number>,
  period: string,
  email: string,
  year: number | null,
  month: number | null,
): number {
  if (period === 'ALL_TIME') {
    return placedMap.get(email) ?? 0;
  }
  if (period === 'YEAR' && year != null) {
    return placedMap.get(`${email}|${year}`) ?? 0;
  }
  if (period === 'MONTH' && year != null && month != null) {
    return placedMap.get(`${email}|${year}|${month}`) ?? 0;
  }
  if (period === 'QUARTER' && year != null && month != null) {
    const q = Math.ceil(month / 3);
    return placedMap.get(`${email}|${year}|Q${q}`) ?? 0;
  }
  return 0;
}
