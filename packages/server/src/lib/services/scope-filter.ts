import { Prisma, AnalysisPeriodMode } from '@prisma/client';
import prisma from '@/lib/db';

export interface ScopeConfig {
  analysisPeriodMode: AnalysisPeriodMode | string; // string fallback for unknown/future modes
  analysisYears: number[];
  analysisStartDate: Date | null;
  analysisEndDate: Date | null;
  analysisCommitLimit: number | null;
}

/**
 * Build a Prisma WHERE clause for CommitAnalysis based on the order's scope config.
 *
 * Pure function — no DB calls. Used by metrics service, commits API,
 * effort-timeline API, and analysis worker.
 */
export function buildScopeWhereClause(
  orderId: string,
  scope: ScopeConfig,
): Prisma.CommitAnalysisWhereInput {
  const base: Prisma.CommitAnalysisWhereInput = {
    orderId,
    jobId: null,
    method: { not: 'error' },
  };

  switch (scope.analysisPeriodMode) {
    case 'DATE_RANGE':
      if (scope.analysisStartDate && scope.analysisEndDate) {
        return {
          ...base,
          authorDate: { gte: scope.analysisStartDate, lte: scope.analysisEndDate },
        };
      }
      return base;

    case 'SELECTED_YEARS':
      if (scope.analysisYears.length === 0) {
        // Return an impossible filter — no commits should match
        return { orderId: '__impossible__', jobId: null };
      }
      return {
        ...base,
        OR: scope.analysisYears.map(year => ({
          authorDate: {
            gte: new Date(`${year}-01-01T00:00:00Z`),
            lt: new Date(`${year + 1}-01-01T00:00:00Z`),
          },
        })),
      };

    case 'LAST_N_COMMITS':
    case 'ALL_TIME':
    default:
      return base;
  }
}

/**
 * Fetch in-scope CommitAnalysis rows. Handles LAST_N_COMMITS limit automatically.
 */
export async function getInScopeCommits(
  orderId: string,
  scope: ScopeConfig,
  options?: {
    select?: Prisma.CommitAnalysisSelect;
    orderBy?: Prisma.CommitAnalysisOrderByWithRelationInput;
    skip?: number;
    take?: number;
  },
) {
  const where = buildScopeWhereClause(orderId, scope);
  const isLastN =
    scope.analysisPeriodMode === 'LAST_N_COMMITS' && scope.analysisCommitLimit;
  const effectiveOrderBy =
    options?.orderBy ?? (isLastN ? ({ authorDate: 'desc' } as const) : undefined);
  const effectiveTake =
    isLastN && !options?.take ? scope.analysisCommitLimit! : options?.take;

  return prisma.commitAnalysis.findMany({
    where,
    select: options?.select,
    orderBy: effectiveOrderBy,
    skip: options?.skip,
    take: effectiveTake,
  });
}

/**
 * Count in-scope commits. For LAST_N_COMMITS, caps at the configured limit.
 */
export async function countInScopeCommits(
  orderId: string,
  scope: ScopeConfig,
): Promise<number> {
  const where = buildScopeWhereClause(orderId, scope);
  const count = await prisma.commitAnalysis.count({ where });
  if (scope.analysisPeriodMode === 'LAST_N_COMMITS' && scope.analysisCommitLimit) {
    return Math.min(count, scope.analysisCommitLimit);
  }
  return count;
}

/**
 * Get the set of commit SHAs that are in scope for this order.
 */
export async function getInScopeShas(
  orderId: string,
  scope: ScopeConfig,
): Promise<Set<string>> {
  const commits = await getInScopeCommits(orderId, scope, {
    select: { commitHash: true },
  });
  return new Set(commits.map((c: { commitHash: string }) => c.commitHash));
}
