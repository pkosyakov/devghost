import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, getOrderWithAuth, orderAuthError } from '@/lib/api-utils';
import { logger } from '@/lib/logger';
import { buildScopeWhereClause, getInScopeCommits, type ScopeConfig } from '@/lib/services/scope-filter';

const log = logger.child({ route: 'effort-timeline' });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await getOrderWithAuth(id, {
      select: {
        id: true,
        analysisPeriodMode: true,
        analysisYears: true,
        analysisStartDate: true,
        analysisEndDate: true,
        analysisCommitLimit: true,
      },
    });
    if (!result.success) return orderAuthError(result);
    const order = result.order;

    // Build scope-filtered where for developer distinct query
    const scopeConfig: ScopeConfig = {
      analysisPeriodMode: order.analysisPeriodMode,
      analysisYears: order.analysisYears as number[],
      analysisStartDate: order.analysisStartDate,
      analysisEndDate: order.analysisEndDate,
      analysisCommitLimit: order.analysisCommitLimit,
    };
    let developerWhere = buildScopeWhereClause(id, scopeConfig);

    // For LAST_N_COMMITS: restrict to in-scope SHAs
    if (order.analysisPeriodMode === 'LAST_N_COMMITS' && order.analysisCommitLimit) {
      const inScopeShas = await prisma.commitAnalysis.findMany({
        where: developerWhere,
        orderBy: { authorDate: 'desc' },
        take: order.analysisCommitLimit,
        select: { commitHash: true },
      });
      developerWhere = { ...developerWhere, commitHash: { in: inScopeShas.map(c => c.commitHash) } };
    }

    // Fetch effort rows, developer names, and in-scope commits in parallel
    // DailyEffort is already clean (cleared upfront in worker, written from in-scope commits)
    const [effortRows, commitDevs, inScopeCommits] = await Promise.all([
      prisma.dailyEffort.findMany({
        where: { orderId: id },
        select: {
          developerEmail: true,
          date: true,
          effortHours: true,
          sourceCommitHash: true,
        },
        orderBy: { date: 'asc' },
      }),
      prisma.commitAnalysis.findMany({
        where: developerWhere,
        select: { authorEmail: true, authorName: true },
        distinct: ['authorEmail'],
        orderBy: { authorName: 'asc' },
      }),
      getInScopeCommits(id, scopeConfig, {
        select: { commitHash: true, authorEmail: true, authorName: true, authorDate: true, effortHours: true },
      }),
    ]);

    // Placed effort per commit from DailyEffort rows
    const placedByCommit = new Map<string, number>();
    for (const r of effortRows) {
      if (r.sourceCommitHash) {
        placedByCommit.set(r.sourceCommitHash, (placedByCommit.get(r.sourceCommitHash) ?? 0) + Number(r.effortHours));
      }
    }

    // Overhead rows: raw LLM effort minus placed effort per commit.
    // Overhead is pinned to the commit's authorDate, while placed effort
    // may be spread to adjacent days by the spreading algorithm.
    // At day granularity this can cause visual separation, but it is semantically
    // correct: overhead represents unplaceable effort tied to the commit event.
    const overheadRows: { email: string; date: string; effort: number; type: 'overhead' }[] = [];
    for (const c of inScopeCommits) {
      const raw = Number(c.effortHours);
      const placed = placedByCommit.get(c.commitHash) ?? 0;
      const overhead = Math.max(0, Math.round((raw - placed) * 100) / 100);
      if (overhead > 0) {
        overheadRows.push({
          email: c.authorEmail,
          date: new Date(c.authorDate).toISOString().slice(0, 10),
          effort: overhead,
          type: 'overhead' as const,
        });
      }
    }

    const rows = [
      ...effortRows.map(r => ({
        email: r.developerEmail,
        date: new Date(r.date).toISOString().slice(0, 10),
        effort: Number(r.effortHours),
        type: 'placed' as const,
      })),
      ...overheadRows,
    ];

    // Build developer list from union of DailyEffort + in-scope commit emails
    const nameMap = new Map(commitDevs.map(d => [d.authorEmail, d.authorName]));
    for (const c of inScopeCommits) {
      if (!nameMap.has(c.authorEmail)) {
        nameMap.set(c.authorEmail, c.authorName);
      }
    }
    const allEmails = new Set([
      ...effortRows.map(r => r.developerEmail),
      ...inScopeCommits.map(c => c.authorEmail),
    ]);
    const developers = [...allEmails].sort().map(email => ({
      email,
      name: nameMap.get(email) ?? email,
    }));

    return apiResponse({ rows, developers });
  } catch (err) {
    log.error({ err }, 'Failed to fetch effort timeline');
    return apiError('Failed to fetch effort timeline', 500);
  }
}
