import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, getOrderWithAuth, orderAuthError } from '@/lib/api-utils';
import { logger } from '@/lib/logger';

const log = logger.child({ route: 'daily-effort' });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const { searchParams } = new URL(request.url);
    const email = searchParams.get('email');
    if (!email) return apiError('email parameter required', 400);

    const result = await getOrderWithAuth(id, { select: { id: true } });
    if (!result.success) return orderAuthError(result);

    // 1. Placed effort: DailyEffort rows grouped by calendar date
    const deRows = await prisma.dailyEffort.findMany({
      where: { orderId: id, developerEmail: email },
      select: {
        date: true,
        effortHours: true,
        sourceCommitHash: true,
        sourceCommitDate: true,
      },
      orderBy: { date: 'asc' },
    });

    // Calendar view: placed hours per spread day
    const byDate = new Map<string, { date: string; effort: number; commits: string[] }>();
    for (const r of deRows) {
      const dateStr = new Date(r.date).toISOString().slice(0, 10);
      const entry = byDate.get(dateStr);
      const effort = Number(r.effortHours ?? 0);
      if (entry) {
        entry.effort += effort;
        entry.commits.push(r.sourceCommitHash);
      } else {
        byDate.set(dateStr, { date: dateStr, effort, commits: [r.sourceCommitHash] });
      }
    }

    // Placed effort grouped by source commit date (to compute per-date overhead)
    const placedByCommitDate = new Map<string, number>();
    for (const r of deRows) {
      const commitDateStr = new Date(r.sourceCommitDate).toISOString().slice(0, 10);
      placedByCommitDate.set(
        commitDateStr,
        (placedByCommitDate.get(commitDateStr) ?? 0) + Number(r.effortHours ?? 0),
      );
    }

    // 2. Original estimated effort from CommitAnalysis, grouped by commit date
    const commits = await prisma.commitAnalysis.findMany({
      where: { orderId: id, authorEmail: email, jobId: null },
      select: {
        authorDate: true,
        effortHours: true,
        commitHash: true,
      },
      orderBy: { authorDate: 'asc' },
    });

    const estimatedByDate = new Map<string, { date: string; estimated: number; commits: string[] }>();
    for (const c of commits) {
      const dateStr = new Date(c.authorDate).toISOString().slice(0, 10);
      const entry = estimatedByDate.get(dateStr);
      const effort = Number(c.effortHours ?? 0);
      if (entry) {
        entry.estimated += effort;
        entry.commits.push(c.commitHash);
      } else {
        estimatedByDate.set(dateStr, { date: dateStr, estimated: effort, commits: [c.commitHash] });
      }
    }

    // 3. Build commit-date view with overhead per date
    const commitDates = Array.from(estimatedByDate.values()).map(e => ({
      date: e.date,
      estimated: Math.round(e.estimated * 100) / 100,
      placed: Math.round((placedByCommitDate.get(e.date) ?? 0) * 100) / 100,
      overhead: Math.max(0, Math.round((e.estimated - (placedByCommitDate.get(e.date) ?? 0)) * 100) / 100),
      commits: e.commits,
    }));

    // 4. Per-commit distribution: how each commit's effort was spread across days
    const byCommit = new Map<string, { date: string; effort: number }[]>();
    for (const r of deRows) {
      const dateStr = new Date(r.date).toISOString().slice(0, 10);
      const effort = Number(r.effortHours ?? 0);
      const arr = byCommit.get(r.sourceCommitHash);
      if (arr) {
        arr.push({ date: dateStr, effort });
      } else {
        byCommit.set(r.sourceCommitHash, [{ date: dateStr, effort }]);
      }
    }

    const commitDistribution: Record<string, { date: string; effort: number }[]> = {};
    for (const [hash, entries] of byCommit) {
      commitDistribution[hash] = entries.sort((a, b) => a.date.localeCompare(b.date));
    }

    return apiResponse({
      // Calendar view: where hours landed after spreading
      spread: Array.from(byDate.values()),
      // Source view: where hours came from, with per-date overhead
      sources: commitDates,
      // Per-commit view: how each commit was distributed across days
      commitDistribution,
    });
  } catch (err) {
    log.error({ err }, 'Failed to fetch daily effort');
    return apiError('Failed to fetch daily effort', 500);
  }
}
