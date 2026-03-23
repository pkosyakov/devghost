import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { Prisma } from '@prisma/client';
import {
  apiResponse,
  apiError,
  getOrderWithAuth,
  orderAuthError,
} from '@/lib/api-utils';
import { buildScopeWhereClause, type ScopeConfig } from '@/lib/services/scope-filter';
import { logger } from '@/lib/logger';

// Security: Whitelist of allowed sort fields to prevent field enumeration
const ALLOWED_SORT_FIELDS = [
  'authorDate',
  'authorEmail',
  'authorName',
  'category',
  'complexity',
  'effortHours',
  'qualityScore',
  'confidence',
  'repository',
  'commitHash',
  'additions',
  'deletions',
  'filesCount',
] as const;
type SortField = (typeof ALLOWED_SORT_FIELDS)[number];

function isValidSortField(field: string): field is SortField {
  return ALLOWED_SORT_FIELDS.includes(field as SortField);
}

// Security: Maximum page size to prevent memory exhaustion
const MAX_PAGE_SIZE = 500;

// GET /api/orders/[id]/commits - Get commit analysis data for an order
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await getOrderWithAuth(id, {
      select: {
        id: true,
        status: true,
        analysisPeriodMode: true,
        analysisYears: true,
        analysisStartDate: true,
        analysisEndDate: true,
        analysisCommitLimit: true,
      },
    });
    if (!result.success) {
      return orderAuthError(result);
    }
    const order = result.order;

    // Parse query params for pagination and filtering
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const pageSize = Math.min(
      parseInt(url.searchParams.get('pageSize') || '50', 10),
      MAX_PAGE_SIZE
    );
    const authorEmail = url.searchParams.get('authorEmail');
    const category = url.searchParams.get('category');
    const complexity = url.searchParams.get('complexity');
    const sortByParam = url.searchParams.get('sortBy') || 'authorDate';
    const sortBy = isValidSortField(sortByParam) ? sortByParam : 'authorDate';
    const sortOrder = url.searchParams.get('sortOrder') || 'desc';

    // Build scope-filtered where clause
    const scopeConfig: ScopeConfig = {
      analysisPeriodMode: order.analysisPeriodMode,
      analysisYears: order.analysisYears as number[],
      analysisStartDate: order.analysisStartDate,
      analysisEndDate: order.analysisEndDate,
      analysisCommitLimit: order.analysisCommitLimit,
    };
    const scopeWhere = buildScopeWhereClause(id, scopeConfig);

    const where: Prisma.CommitAnalysisWhereInput = {
      ...scopeWhere,
      ...(authorEmail && { authorEmail }),
      ...(category && { category }),
      ...(complexity && { complexity }),
    };

    // For LAST_N_COMMITS: restrict to in-scope SHAs so pagination works correctly
    if (order.analysisPeriodMode === 'LAST_N_COMMITS' && order.analysisCommitLimit) {
      const inScopeShas = await prisma.commitAnalysis.findMany({
        where: scopeWhere,
        orderBy: { authorDate: 'desc' },
        take: order.analysisCommitLimit,
        select: { commitHash: true },
      });
      where.commitHash = { in: inScopeShas.map((c) => c.commitHash) };
    }

    // Get total count
    const totalCount = await prisma.commitAnalysis.count({ where });

    // Get commits with pagination
    const commits = await prisma.commitAnalysis.findMany({
      where,
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        commitHash: true,
        commitMessage: true,
        authorEmail: true,
        authorName: true,
        authorDate: true,
        repository: true,
        additions: true,
        deletions: true,
        filesCount: true,
        effortHours: true,
        category: true,
        complexity: true,
        confidence: true,
        analyzedAt: true,
      },
    });

    // Build stats where — scope filter + optional authorEmail
    const statsWhere: Prisma.CommitAnalysisWhereInput = {
      ...scopeWhere,
      ...(authorEmail && { authorEmail }),
    };
    // For LAST_N_COMMITS: reuse the same SHA restriction
    if (where.commitHash) statsWhere.commitHash = where.commitHash;

    // Get aggregated stats
    const stats = await prisma.commitAnalysis.aggregate({
      where: statsWhere,
      _count: { id: true },
      _sum: {
        effortHours: true,
        additions: true,
        deletions: true,
      },
      _avg: {
        confidence: true,
        effortHours: true,
      },
    });

    // Get category breakdown
    const categoryBreakdown = await prisma.commitAnalysis.groupBy({
      by: ['category'],
      where: statsWhere,
      _count: { id: true },
    });

    // Get complexity breakdown
    const complexityBreakdown = await prisma.commitAnalysis.groupBy({
      by: ['complexity'],
      where: statsWhere,
      _count: { id: true },
    });

    return apiResponse({
      commits: commits.map((c) => ({
        ...c,
        effortHours: Number(c.effortHours),
        confidence: Number(c.confidence),
      })),
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
      },
      stats: {
        totalCommits: stats._count.id,
        totalEffortHours: Number(stats._sum.effortHours) || 0,
        totalAdditions: stats._sum.additions || 0,
        totalDeletions: stats._sum.deletions || 0,
        avgConfidence: Number(stats._avg.confidence) || 0,
        avgEffortHours: Number(stats._avg.effortHours) || 0,
      },
      categoryBreakdown: categoryBreakdown.reduce(
        (acc, item) => {
          if (item.category) {
            acc[item.category] = item._count.id;
          }
          return acc;
        },
        {} as Record<string, number>
      ),
      complexityBreakdown: complexityBreakdown.reduce(
        (acc, item) => {
          if (item.complexity) {
            acc[item.complexity] = item._count.id;
          }
          return acc;
        },
        {} as Record<string, number>
      ),
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch commits');
    return apiError('Failed to fetch commits', 500);
  }
}
