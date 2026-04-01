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
  computeFteDays,
  MIN_WORK_DAYS_FOR_GHOST,
} from '@devghost/shared';
import type { GhostMetric, SpreadCommit } from '@devghost/shared';

const log = analysisLogger.child({ service: 'ghost-metrics' });

type PeriodType = 'ALL_TIME';

interface InScopeCommitRow {
  commitHash: string;
  authorEmail: string;
  authorName: string;
  authorDate: Date;
  effortHours: unknown;
}

interface DeveloperWorkset {
  email: string;
  name: string;
  commitCount: number;
  commits: SpreadCommit[];
}

export interface GhostMetricsBatchOptions {
  periodType?: PeriodType;
  offset?: number;
  limit?: number;
  resetExisting?: boolean;
  onProgress?: () => Promise<void> | void;
}

export interface GhostMetricsBatchResult {
  metrics: GhostMetric[];
  totalDevelopers: number;
  processedDevelopers: number;
  nextOffset: number;
  done: boolean;
}

export class GhostMetricsService {
  private async loadOrderScope(orderId: string, userId: string): Promise<ScopeConfig> {
    const order = await prisma.order.findFirst({
      where: { id: orderId, userId },
      select: {
        analysisPeriodMode: true,
        analysisYears: true,
        analysisStartDate: true,
        analysisEndDate: true,
        analysisCommitLimit: true,
      },
    });
    if (!order) throw new Error(`Order not found: ${orderId}`);

    return {
      analysisPeriodMode: order.analysisPeriodMode,
      analysisYears: order.analysisYears,
      analysisStartDate: order.analysisStartDate,
      analysisEndDate: order.analysisEndDate,
      analysisCommitLimit: order.analysisCommitLimit,
    };
  }

  private buildDeveloperWorksets(commitAnalyses: InScopeCommitRow[]): DeveloperWorkset[] {
    const byDev = new Map<string, DeveloperWorkset>();

    for (const commit of commitAnalyses) {
      const email = commit.authorEmail;
      if (!byDev.has(email)) {
        byDev.set(email, {
          email,
          commits: [],
          name: commit.authorName,
          commitCount: 0,
        });
      }
      const dev = byDev.get(email)!;
      dev.commits.push({
        sha: commit.commitHash,
        authorDate: new Date(commit.authorDate),
        effortHours: Number(commit.effortHours ?? 0),
      });
      dev.commitCount++;
    }

    return Array.from(byDev.values());
  }

  private async saveDeveloperMetric(
    orderId: string,
    periodType: PeriodType,
    workset: DeveloperWorkset,
    totalCommitsInOrder: number,
    settingsMap: Map<string, { share: unknown; isExcluded: boolean; shareAutoCalculated: boolean }>,
    onProgress?: () => Promise<void> | void,
  ): Promise<GhostMetric> {
    const email = workset.email;
    const devSettings = settingsMap.get(email);
    await onProgress?.();

    // Run effort spreading algorithm
    const spreadResult = spreadEffort(workset.commits);

    const totalEffort = workset.commits.reduce((sum, c) => sum + c.effortHours, 0);
    const workDays = spreadResult.dayMap.size;
    const avgDaily = workDays > 0 ? totalEffort / workDays : 0;
    const hasEnoughData = workDays >= MIN_WORK_DAYS_FOR_GHOST;
    const overheadHours = spreadResult.totalOverhead;

    // FTE mode: count all weekdays in [earliest spread day, last commit] + weekend commit days
    const fteDays = computeFteDays(
      Array.from(spreadResult.dayMap.keys()),
      workset.commits.map(c => c.authorDate),
    );
    const fteAvgDaily = fteDays > 0 ? totalEffort / fteDays : 0;

    log.info(
      { orderId, email, totalEffort, workDays, fteDays, overheadHours, commitCount: workset.commitCount },
      'Spread effort computed',
    );

    // Share: default manual 100%, auto only if explicitly set
    let share = 1.0;
    let shareAuto = false;
    if (devSettings && devSettings.shareAutoCalculated) {
      share = calcAutoShare(workset.commitCount, totalCommitsInOrder);
      shareAuto = true;
    } else if (devSettings && !devSettings.shareAutoCalculated) {
      share = Number(devSettings.share);
      shareAuto = false;
    }

    const ghostRaw = calcGhostPercentRaw(totalEffort, workDays);
    const ghost = calcGhostPercent(totalEffort, workDays, share);

    const fteGhostRaw = calcGhostPercentRaw(totalEffort, fteDays);
    const fteGhost = calcGhostPercent(totalEffort, fteDays, share);

    const devName = workset.name || email;
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
      commitCount: workset.commitCount,
      hasEnoughData,
      overheadHours,
      fteWorkDays: fteDays,
      fteAvgDailyEffort: fteAvgDaily,
      fteGhostPercentRaw: fteGhostRaw,
      fteGhostPercent: fteGhost,
    };

    // Idempotent for resumable post-processing: duplicate rows are skipped.
    if (spreadResult.dailyEffortRows.length > 0) {
      const rows = spreadResult.dailyEffortRows.map(row => ({
        orderId,
        developerEmail: email,
        date: new Date(row.date + 'T00:00:00.000Z'),
        effortHours: row.effortHours,
        sourceCommitHash: row.sourceCommitHash,
        sourceCommitDate: row.sourceCommitDate,
      }));
      const DAILY_BATCH_SIZE = 500;
      for (let i = 0; i < rows.length; i += DAILY_BATCH_SIZE) {
        await prisma.dailyEffort.createMany({
          data: rows.slice(i, i + DAILY_BATCH_SIZE),
          skipDuplicates: true,
        });
        await onProgress?.();
      }

      log.debug(
        { orderId, email, rowsWritten: spreadResult.dailyEffortRows.length },
        'DailyEffort rows written',
      );
    }

    const existing = await prisma.orderMetric.findFirst({
      where: {
        orderId,
        developerEmail: email,
        periodType,
        year: null,
        month: null,
      },
      select: { id: true },
    });

    const metricData = {
      totalEffortHours: totalEffort,
      workDays,
      avgDailyEffort: avgDaily,
      ghostPercentRaw: ghostRaw,
      ghostPercent: ghost,
      share,
      shareAutoCalculated: shareAuto,
      commitCount: workset.commitCount,
      calculatedAt: new Date(),
      fteWorkDays: fteDays,
      fteAvgDailyEffort: fteAvgDaily,
      fteGhostPercentRaw: fteGhostRaw,
      fteGhostPercent: fteGhost,
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

    await onProgress?.();
    return metric;
  }

  /**
   * Calculate and save Ghost % metrics for all developers in an order.
   * Uses effort spreading to determine realistic workDays and detect overhead.
   */
  async calculateAndSave(
    orderId: string,
    userId: string,
    periodType: PeriodType = 'ALL_TIME',
  ): Promise<GhostMetric[]> {
    const result = await this.calculateAndSaveBatch(orderId, userId, {
      periodType,
      offset: 0,
      limit: Number.MAX_SAFE_INTEGER,
      resetExisting: false,
    });
    return result.metrics;
  }

  /**
   * Incremental metrics processing for resumable post-processing.
   * Processes a deterministic developer slice [offset, offset+limit).
   */
  async calculateAndSaveBatch(
    orderId: string,
    userId: string,
    options: GhostMetricsBatchOptions = {},
  ): Promise<GhostMetricsBatchResult> {
    const periodType = options.periodType ?? 'ALL_TIME';
    const start = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? Number.MAX_SAFE_INTEGER);

    const scopeConfig = await this.loadOrderScope(orderId, userId);
    const commitAnalyses = await getInScopeCommits(orderId, scopeConfig, {
      select: {
        commitHash: true,
        authorEmail: true,
        authorName: true,
        authorDate: true,
        effortHours: true,
      },
    }) as InScopeCommitRow[];

    const worksets = this.buildDeveloperWorksets(commitAnalyses);

    const settings = await prisma.developerSettings.findMany({
      where: { orderId },
      select: {
        developerEmail: true,
        share: true,
        isExcluded: true,
        shareAutoCalculated: true,
      },
    });
    const settingsMap = new Map(settings.map(s => [s.developerEmail, s]));

    const activeWorksets = worksets
      .filter(workset => !settingsMap.get(workset.email)?.isExcluded)
      .sort((a, b) => a.email.localeCompare(b.email));

    if (options.resetExisting) {
      await prisma.orderMetric.deleteMany({ where: { orderId } });
      await prisma.dailyEffort.deleteMany({ where: { orderId } });
    }

    const end = Math.min(activeWorksets.length, start + limit);
    const chunk = activeWorksets.slice(start, end);
    const totalCommitsInOrder = commitAnalyses.length;
    const metrics: GhostMetric[] = [];
    const onProgress = options.onProgress;

    for (const workset of chunk) {
      const metric = await this.saveDeveloperMetric(
        orderId,
        periodType,
        workset,
        totalCommitsInOrder,
        settingsMap,
        onProgress,
      );
      metrics.push(metric);
      await onProgress?.();
    }

    return {
      metrics,
      totalDevelopers: activeWorksets.length,
      processedDevelopers: chunk.length,
      nextOffset: end,
      done: end >= activeWorksets.length,
    };
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
