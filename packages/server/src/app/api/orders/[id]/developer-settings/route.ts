/**
 * Developer Settings API — DevGhost
 * GET: Fetch all developer settings for an order
 * PATCH: Update share/excluded for a developer
 */

import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import {
  apiResponse,
  apiError,
  parseBody,
  getOrderWithAuth,
  orderAuthError,
} from '@/lib/api-utils';
import { developerSettingsSchema } from '@/lib/schemas';
import { calcGhostPercent, calcAutoShare } from '@devghost/shared';
import { logger } from '@/lib/logger';

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/orders/[id]/developer-settings
export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    const { id: orderId } = await context.params;

    const authResult = await getOrderWithAuth(orderId, {
      select: { id: true },
    });
    if (!authResult.success) {
      return orderAuthError(authResult);
    }

    const settings = await prisma.developerSettings.findMany({
      where: { orderId },
      select: {
        id: true,
        developerEmail: true,
        share: true,
        isExcluded: true,
        shareAutoCalculated: true,
        updatedAt: true,
      },
    });

    const normalized = settings.map((s) => ({
      ...s,
      share: Number(s.share),
    }));

    return apiResponse(normalized);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching developer settings');
    return apiError('Failed to fetch developer settings', 500);
  }
}

// PATCH /api/orders/[id]/developer-settings
// Body: { developerEmail, share?, isExcluded?, shareAutoCalculated? }
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id: orderId } = await context.params;

    const authResult = await getOrderWithAuth<{ id: string; userId: string }>(orderId, {
      select: { id: true, userId: true },
    });
    if (!authResult.success) {
      return orderAuthError(authResult);
    }

    const parsed = await parseBody(request, developerSettingsSchema);
    if (!parsed.success) return parsed.error;
    const { developerEmail, share, isExcluded, shareAutoCalculated } = parsed.data;

    const result = await prisma.developerSettings.upsert({
      where: {
        orderId_developerEmail: {
          orderId,
          developerEmail,
        },
      },
      create: {
        orderId,
        developerEmail,
        share: share ?? 1.0,
        isExcluded: isExcluded ?? false,
        shareAutoCalculated: shareAutoCalculated ?? true,
      },
      update: {
        ...(share !== undefined && { share }),
        ...(isExcluded !== undefined && { isExcluded }),
        ...(shareAutoCalculated !== undefined && { shareAutoCalculated }),
      },
    });

    // Lightweight recalculation: update only this developer's OrderMetric rows
    // instead of running full calculateAndSave for all developers
    const metrics = await prisma.orderMetric.findMany({
      where: { orderId, developerEmail },
    });

    if (metrics.length > 0) {
      // Determine new share value
      let newShare: number;
      const wantAuto = shareAutoCalculated ?? result.shareAutoCalculated;

      if (wantAuto) {
        // Auto share = this developer's commits / total commits in order
        const totalCommits = await prisma.orderMetric.aggregate({
          where: { orderId, periodType: 'ALL_TIME' },
          _sum: { commitCount: true },
        });
        const devMetric = metrics.find(m => m.periodType === 'ALL_TIME');
        const devCommits = devMetric?.commitCount ?? 0;
        const total = totalCommits._sum.commitCount ?? devCommits;
        newShare = calcAutoShare(devCommits, total);
      } else {
        newShare = share ?? Number(result.share);
      }

      // Update all period buckets for this developer
      for (const m of metrics) {
        const totalEffort = Number(m.totalEffortHours);
        const workDays = m.workDays ?? 0;
        const fteDays = m.fteWorkDays ?? 0;

        const ghostPercent = calcGhostPercent(totalEffort, workDays, newShare);
        const fteGhostPercent = calcGhostPercent(totalEffort, fteDays, newShare);

        await prisma.orderMetric.update({
          where: { id: m.id },
          data: {
            share: newShare,
            shareAutoCalculated: wantAuto,
            ghostPercent,
            fteGhostPercent,
            calculatedAt: new Date(),
          },
        });
      }
    }

    return apiResponse({
      ...result,
      share: Number(result.share),
    });
  } catch (error) {
    logger.error({ err: error }, 'Error updating developer settings');
    return apiError('Failed to update developer settings', 500);
  }
}
