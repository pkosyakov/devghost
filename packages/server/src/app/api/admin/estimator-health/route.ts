import { AnalysisJobStatus, Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { apiResponse, requireAdmin, isErrorResponse } from '@/lib/api-utils';

const WINDOW_HOURS = 24;
const STALE_PENDING_MS = 2 * 60 * 1000;
const STALE_RUNNING_MS = 10 * 60 * 1000;
const STALE_POST_PROCESSING_MS = 5 * 60 * 1000;

type HealthStatus = 'pass' | 'warn' | 'fail' | 'na';

const HEURISTIC_ONLY_FD_METHODS = [
  'FD_cheap',
  'FD_bulk_scaffold',
  'FD_v2_heuristic_only',
  'FD_v3_heuristic_only',
  'FD_v3_fallback',
  'FD_fallback',
] as const;

const LARGE_MODEL_FD_METHODS = [
  'FD_v3_holistic',
  'FD_v2_single_holistic',
  'FD_v2_single_call',
  'FD_v2_cluster_holistic',
  'FD_v2_cluster',
] as const;

const FD_V3_HOLISTIC_METHODS = [
  'FD_v3_holistic',
] as const;

const FD_V3_NON_HOLISTIC_METHODS = [
  'FD_v3_heuristic_only',
  'FD_v3_fallback',
] as const;

function statusFromRate(
  value: number | null,
  thresholds: { passMax?: number; warnMax?: number; passMin?: number; warnMin?: number },
): HealthStatus {
  if (value == null) return 'na';
  if (thresholds.passMax != null && value <= thresholds.passMax) return 'pass';
  if (thresholds.warnMax != null && value <= thresholds.warnMax) return 'warn';
  if (thresholds.passMin != null && value >= thresholds.passMin) return 'pass';
  if (thresholds.warnMin != null && value >= thresholds.warnMin) return 'warn';
  return 'fail';
}

function worstStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.includes('pass')) return 'pass';
  return 'na';
}

export async function GET() {
  const auth = await requireAdmin();
  if (isErrorResponse(auth)) return auth;

  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000);
  const stalePendingBefore = new Date(now.getTime() - STALE_PENDING_MS);
  const staleRunningBefore = new Date(now.getTime() - STALE_RUNNING_MS);
  const stalePostProcessingBefore = new Date(now.getTime() - STALE_POST_PROCESSING_MS);

  const productionCommitWhere = {
    jobId: null,
    analyzedAt: { gte: since },
    method: { notIn: ['error', 'root_commit_skip'] },
  } satisfies Prisma.CommitAnalysisWhereInput;

  const [
    recentCommitCount,
    fallbackCount,
    fdTotalCount,
    fdV3HolisticCount,
    fdV3NonHolisticCount,
    heuristicAttributedCount,
    specialMethodAttributedCount,
    largeModelMissingCount,
    recentModalJobCount,
    failedModalJobsCount,
    stalePendingJobsCount,
    staleRunningJobsCount,
    stalledPostProcessingJobsCount,
    suspiciousRows,
  ] = await Promise.all([
    prisma.commitAnalysis.count({ where: productionCommitWhere }),
    prisma.commitAnalysis.count({
      where: {
        ...productionCommitWhere,
        effortHours: new Prisma.Decimal('5'),
      },
    }),
    prisma.commitAnalysis.count({
      where: {
        jobId: null,
        analyzedAt: { gte: since },
        method: { startsWith: 'FD' },
      },
    }),
    prisma.commitAnalysis.count({
      where: {
        jobId: null,
        analyzedAt: { gte: since },
        method: { in: [...FD_V3_HOLISTIC_METHODS] },
      },
    }),
    prisma.commitAnalysis.count({
      where: {
        jobId: null,
        analyzedAt: { gte: since },
        method: { in: [...FD_V3_NON_HOLISTIC_METHODS] },
      },
    }),
    prisma.commitAnalysis.count({
      where: {
        jobId: null,
        analyzedAt: { gte: since },
        method: { in: [...HEURISTIC_ONLY_FD_METHODS] },
        llmModel: { not: null },
      },
    }),
    prisma.commitAnalysis.count({
      where: {
        jobId: null,
        analyzedAt: { gte: since },
        method: { in: ['root_commit_skip', 'error'] },
        llmModel: { not: null },
      },
    }),
    prisma.commitAnalysis.count({
      where: {
        jobId: null,
        analyzedAt: { gte: since },
        method: { in: [...LARGE_MODEL_FD_METHODS] },
        llmModel: null,
      },
    }),
    prisma.analysisJob.count({
      where: {
        type: 'analysis',
        executionMode: 'modal',
        updatedAt: { gte: since },
      },
    }),
    prisma.analysisJob.count({
      where: {
        type: 'analysis',
        executionMode: 'modal',
        status: {
          in: [
            AnalysisJobStatus.FAILED,
            AnalysisJobStatus.FAILED_RETRYABLE,
            AnalysisJobStatus.FAILED_FATAL,
          ],
        },
        updatedAt: { gte: since },
      },
    }),
    prisma.analysisJob.count({
      where: {
        type: 'analysis',
        executionMode: 'modal',
        status: AnalysisJobStatus.PENDING,
        updatedAt: {
          gte: since,
          lt: stalePendingBefore,
        },
      },
    }),
    prisma.analysisJob.count({
      where: {
        type: 'analysis',
        executionMode: 'modal',
        status: AnalysisJobStatus.RUNNING,
        OR: [
          {
            heartbeatAt: {
              gte: since,
              lt: staleRunningBefore,
            },
          },
          {
            heartbeatAt: null,
            updatedAt: {
              gte: since,
              lt: staleRunningBefore,
            },
          },
        ],
      },
    }),
    prisma.analysisJob.count({
      where: {
        type: 'analysis',
        executionMode: 'modal',
        status: AnalysisJobStatus.LLM_COMPLETE,
        updatedAt: {
          gte: since,
          lt: stalePostProcessingBefore,
        },
      },
    }),
    prisma.commitAnalysis.findMany({
      where: {
        jobId: null,
        analyzedAt: { gte: since },
        OR: [
          {
            method: { in: [...HEURISTIC_ONLY_FD_METHODS] },
            llmModel: { not: null },
          },
          {
            method: { in: ['root_commit_skip', 'error'] },
            llmModel: { not: null },
          },
          {
            method: { in: [...LARGE_MODEL_FD_METHODS] },
            llmModel: null,
          },
        ],
      },
      select: {
        commitHash: true,
        method: true,
        llmModel: true,
        repository: true,
        analyzedAt: true,
      },
      orderBy: { analyzedAt: 'desc' },
      take: 5,
    }),
  ]);

  const fallbackRate =
    recentCommitCount > 0 ? (fallbackCount / recentCommitCount) * 100 : null;
  const fdV3Share =
    fdTotalCount > 0 ? (fdV3HolisticCount / fdTotalCount) * 100 : null;
  const modalIssuesCount =
    failedModalJobsCount + stalePendingJobsCount + staleRunningJobsCount + stalledPostProcessingJobsCount;
  const attributionIssuesCount =
    heuristicAttributedCount + specialMethodAttributedCount + largeModelMissingCount;

  const fallbackStatus = statusFromRate(fallbackRate, { passMax: 1, warnMax: 3 });
  const fdV3Status = statusFromRate(fdV3Share, { passMin: 95, warnMin: 80 });
  const modalStatus: HealthStatus =
    modalIssuesCount > 0 ? (modalIssuesCount <= 2 ? 'warn' : 'fail')
      : recentModalJobCount > 0 ? 'pass'
        : 'na';
  const attributionStatus: HealthStatus =
    attributionIssuesCount > 0 ? (attributionIssuesCount <= 2 ? 'warn' : 'fail')
      : recentCommitCount > 0 ? 'pass'
        : 'na';

  return apiResponse({
    windowHours: WINDOW_HOURS,
    generatedAt: now.toISOString(),
    overallStatus: worstStatus([fallbackStatus, fdV3Status, modalStatus, attributionStatus]),
    fallbackRate: {
      status: fallbackStatus,
      percent: fallbackRate,
      fallbackCount,
      totalCount: recentCommitCount,
    },
    fdV3Share: {
      status: fdV3Status,
      percent: fdV3Share,
      fdV3HolisticCount,
      fdV3NonHolisticCount,
      fdTotalCount,
    },
    modalJobs: {
      status: modalStatus,
      recentModalJobCount,
      failedCount: failedModalJobsCount,
      stuckPendingCount: stalePendingJobsCount,
      stuckRunningCount: staleRunningJobsCount,
      stalledPostProcessingCount: stalledPostProcessingJobsCount,
      totalIssues: modalIssuesCount,
    },
    attribution: {
      status: attributionStatus,
      suspiciousCount: attributionIssuesCount,
      heuristicAttributedCount,
      specialMethodAttributedCount,
      largeModelMissingCount,
      samples: suspiciousRows.map((row) => ({
        sha: row.commitHash,
        method: row.method,
        llmModel: row.llmModel,
        repository: row.repository,
        analyzedAt: row.analyzedAt.toISOString(),
      })),
    },
  });
}
