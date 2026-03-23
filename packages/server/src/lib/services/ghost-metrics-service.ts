/**
 * Ghost Metrics Service
 *
 * Calculates and persists Ghost % metrics per developer in an order.
 * Uses effort spreading algorithm for realistic workDays calculation.
 * Ghost % = (avg daily effort / GHOST_NORM) * 100, adjusted by share.
 */

import prisma from '@/lib/db';
import { analysisLogger } from '@/lib/logger';
import { getInScopeCommits, type ScopeConfig } from '@/lib/services/scope-filter';
import {
  calcGhostPercentRaw,
  calcGhostPercent,
  calcAutoShare,
  spreadEffort,
  MIN_WORK_DAYS_FOR_GHOST,
} from '@devghost/shared';
import type { GhostMetric, SpreadCommit } from '@devghost/shared';

const log = analysisLogger.child({ service: 'ghost-metrics' });

export class GhostMetricsService {
  /**
   * Calculate and save Ghost % metrics for all developers in an order.
   * Uses effort spreading to determine realistic workDays and detect overhead.
   */
  async calculateAndSave(
    orderId: string,
    userId: string,
    periodType: 'ALL_TIME' = 'ALL_TIME',
  ): Promise<GhostMetric[]> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
    });
    if (!order) throw new Error(`Order not found: ${orderId}`);

    const scopeConfig: ScopeConfig = {
      analysisPeriodMode: order.analysisPeriodMode,
      analysisYears: order.analysisYears,
      analysisStartDate: order.analysisStartDate,
      analysisEndDate: order.analysisEndDate,
      analysisCommitLimit: order.analysisCommitLimit,
    };
    const commitAnalyses = await getInScopeCommits(orderId, scopeConfig);

    // Group commits by developer email
    const byDev = new Map<string, { commits: SpreadCommit[]; name: string; commitCount: number }>();
    for (const commit of commitAnalyses) {
      const email = commit.authorEmail;
      if (!byDev.has(email)) {
        byDev.set(email, { commits: [], name: commit.authorName, commitCount: 0 });
      }
      const dev = byDev.get(email)!;
      dev.commits.push({
        sha: commit.commitHash,
        authorDate: new Date(commit.authorDate),
        effortHours: Number(commit.effortHours ?? 0),
      });
      dev.commitCount++;
    }

    // Get developer settings (share, excluded)
    const settings = await prisma.developerSettings.findMany({
      where: { orderId },
    });
    const settingsMap = new Map(settings.map(s => [s.developerEmail, s]));

    // Total commits in scope (for auto-share within order)
    const totalCommitsInOrder = commitAnalyses.length;

    const metrics: GhostMetric[] = [];

    for (const [email, data] of byDev) {
      const devSettings = settingsMap.get(email);
      if (devSettings?.isExcluded) continue;

      // Run effort spreading algorithm
      const spreadResult = spreadEffort(data.commits);

      const totalEffort = data.commits.reduce((sum, c) => sum + c.effortHours, 0);
      const workDays = spreadResult.dayMap.size; // Spread-based work days
      const avgDaily = workDays > 0 ? totalEffort / workDays : 0;
      const hasEnoughData = workDays >= MIN_WORK_DAYS_FOR_GHOST;
      const overheadHours = spreadResult.totalOverhead;

      log.info(
        { orderId, email, totalEffort, workDays, overheadHours, commitCount: data.commitCount },
        'Spread effort computed',
      );

      // Share: default manual 100%, auto only if explicitly set
      let share = 1.0;
      let shareAuto = false;
      if (devSettings && devSettings.shareAutoCalculated) {
        share = calcAutoShare(data.commitCount, totalCommitsInOrder);
        shareAuto = true;
      } else if (devSettings && !devSettings.shareAutoCalculated) {
        share = Number(devSettings.share);
        shareAuto = false;
      }

      const ghostRaw = calcGhostPercentRaw(totalEffort, workDays);
      const ghost = calcGhostPercent(totalEffort, workDays, share);

      const devName = data.name || email;
      const metric: GhostMetric = {
        developerId: email,
        developerName: devName,
        developerEmail: email,
        periodType,
        totalEffortHours: totalEffort,
        actualWorkDays: workDays,
        avgDailyEffort: avgDaily,
        ghostPercentRaw: ghostRaw,
        ghostPercent: ghost,
        share,
        shareAutoCalculated: shareAuto,
        commitCount: data.commitCount,
        hasEnoughData,
        overheadHours,
      };
      metrics.push(metric);

      // ---- Write DailyEffort rows ----
      // Note: old rows are cleared upfront in analysis-worker (step 6) before metrics recalculation
      if (spreadResult.dailyEffortRows.length > 0) {
        await prisma.dailyEffort.createMany({
          data: spreadResult.dailyEffortRows.map(row => ({
            orderId,
            developerEmail: email,
            date: new Date(row.date + 'T00:00:00.000Z'),
            effortHours: row.effortHours,
            sourceCommitHash: row.sourceCommitHash,
            sourceCommitDate: row.sourceCommitDate,
          })),
        });

        log.debug(
          { orderId, email, rowsWritten: spreadResult.dailyEffortRows.length },
          'DailyEffort rows written',
        );
      }

      // ---- Save/update OrderMetric ----
      const existing = await prisma.orderMetric.findFirst({
        where: {
          orderId,
          developerEmail: email,
          periodType,
          year: null,
          month: null,
        },
      });

      const metricData = {
        totalEffortHours: totalEffort,
        workDays: workDays,
        avgDailyEffort: avgDaily,
        ghostPercentRaw: ghostRaw,
        ghostPercent: ghost,
        share,
        shareAutoCalculated: shareAuto,
        commitCount: data.commitCount,
        calculatedAt: new Date(),
      };

      if (existing) {
        await prisma.orderMetric.update({
          where: { id: existing.id },
          data: metricData,
        });
      } else {
        await prisma.orderMetric.create({
          data: {
            orderId,
            developerEmail: email,
            developerName: devName,
            periodType,
            year: null,
            month: null,
            ...metricData,
          },
        });
      }
    }

    return metrics;
  }

}

// ==================== Singleton ====================

let serviceInstance: GhostMetricsService | null = null;

export function getGhostMetricsService(): GhostMetricsService {
  if (!serviceInstance) {
    serviceInstance = new GhostMetricsService();
  }
  return serviceInstance;
}
