import { NextRequest } from 'next/server';
import {
  apiResponse,
  getOrderWithAuth,
  orderAuthError,
} from '@/lib/api-utils';
import {
  computeBillingPreview,
  computeRepoCacheBreakdown,
  parseRepoNames,
  type BillingPreviewScope,
  type BillingPreviewResult,
  type RepoCacheBreakdown,
} from '@/lib/services/analysis-billing-preview';
import { createGitHubClient } from '@/lib/github-client';
import prisma from '@/lib/db';
import { billingLogger } from '@/lib/logger';

// ── Local helpers ─────────────────────────────────────────

/**
 * Fetch real commit counts from GitHub when DB totals may undercount
 * (e.g. after shallow→full clone fix, repo has more commits than analyzed).
 * Falls back silently to DB-only numbers on any failure.
 */
async function enhanceWithGitHubCounts(
  userId: string,
  repoFullNames: string[],
  totals: BillingPreviewResult,
  repos: RepoCacheBreakdown[],
): Promise<BillingPreviewResult & { repos: RepoCacheBreakdown[] }> {
  try {
    const client = await createGitHubClient(userId, prisma);
    if (!client) return { ...totals, repos };

    const counts = await Promise.all(
      repoFullNames.map(async (fullName) => {
        const [owner, repo] = fullName.split('/');
        if (!owner || !repo) return { fullName, count: null };
        const count = await client.getCommitCount(owner, repo);
        return { fullName, count };
      }),
    );

    // Build map of GitHub counts per repo
    const ghMap = new Map<string, number>();
    for (const { fullName, count } of counts) {
      if (count !== null) ghMap.set(fullName, count);
    }

    // If no GitHub data, return DB-only
    if (ghMap.size === 0) return { ...totals, repos };

    // Adjust per-repo breakdown: use max(db, github) as total
    const adjustedRepos = repos.map((r) => {
      const ghCount = ghMap.get(r.repository);
      if (!ghCount || ghCount <= r.totalCommits) return r;
      return {
        ...r,
        totalCommits: ghCount,
        newCommits: ghCount - r.cachedCommits,
      };
    });

    // Recalculate totals from adjusted repos
    const newTotal = adjustedRepos.reduce((s, r) => s + r.totalCommits, 0);
    const newCached = adjustedRepos.reduce((s, r) => s + r.cachedCommits, 0);

    // Only adjust upward — GitHub counts include merges, so use max
    const adjustedTotal = Math.max(totals.totalScopedCommits, newTotal);
    const adjustedBillable = Math.max(0, adjustedTotal - newCached);

    return {
      ...totals,
      totalScopedCommits: adjustedTotal,
      reusableCachedCommits: newCached,
      billableCommits: adjustedBillable,
      estimatedCredits: adjustedBillable,
      repos: adjustedRepos,
    };
  } catch (err) {
    billingLogger.debug({ err }, 'GitHub commit count enhancement failed, using DB-only');
    return { ...totals, repos };
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toDateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseYears(raw: unknown): number[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && Number.isInteger(n));
}

// ── Route handler ─────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const result = await getOrderWithAuth(id, {
    select: {
      id: true,
      userId: true,
      selectedRepos: true,
      selectedDevelopers: true,
      excludedDevelopers: true,
      analysisPeriodMode: true,
      analysisYears: true,
      analysisStartDate: true,
      analysisEndDate: true,
      analysisCommitLimit: true,
    },
  });
  if (!result.success) return orderAuthError(result);

  const { searchParams } = new URL(request.url);

  // ── Parse overrides (fall back to persisted order values) ──

  const cacheModeRaw = searchParams.get('cacheMode');
  const cacheMode: 'any' | 'model' | 'off' =
    cacheModeRaw === 'any' || cacheModeRaw === 'model' || cacheModeRaw === 'off'
      ? cacheModeRaw
      : 'model';

  const excludedParam = searchParams.get('excludedEmails');
  const excludedEmails: string[] = excludedParam
    ? excludedParam.split(',').map((e) => e.trim()).filter(Boolean)
    : result.order.excludedDevelopers;

  const periodModeParam = searchParams.get('analysisPeriodMode');
  const scopeMode = periodModeParam ?? result.order.analysisPeriodMode;

  const startDateParam = toDateOrNull(searchParams.get('analysisStartDate'));
  const endDateParam = toDateOrNull(searchParams.get('analysisEndDate'));
  const commitLimitParam = toFiniteNumber(searchParams.get('analysisCommitLimit'));
  const yearsParam = searchParams.has('analysisYears')
    ? parseYears(searchParams.get('analysisYears'))
    : null;

  const scope: BillingPreviewScope = {
    mode: scopeMode as BillingPreviewScope['mode'],
    years: yearsParam ?? result.order.analysisYears,
    startDate: startDateParam ?? result.order.analysisStartDate,
    endDate: endDateParam ?? result.order.analysisEndDate,
    commitLimit: commitLimitParam !== null
      ? commitLimitParam
      : result.order.analysisCommitLimit,
  };

  const input = {
    userId: result.order.userId,
    orderId: result.order.id,
    selectedRepos: result.order.selectedRepos as Array<Record<string, unknown>>,
    selectedDevelopers: result.order.selectedDevelopers as Array<Record<string, unknown>>,
    excludedEmails,
    cacheMode,
    scope,
  };

  const includeRepoBreakdown = searchParams.get('includeRepoBreakdown') === 'true';

  if (includeRepoBreakdown) {
    const { totals, repos } = await computeRepoCacheBreakdown(input);

    // Enhance with GitHub commit counts when DB total may undercount
    // (e.g. after shallow clone fix, the repo has more commits than were analyzed)
    if (!totals.isFirstRunEstimate) {
      const repoFullNames = parseRepoNames(result.order.selectedRepos as Array<Record<string, unknown>>);
      const enhanced = await enhanceWithGitHubCounts(result.order.userId, repoFullNames, totals, repos);
      return apiResponse(enhanced);
    }

    return apiResponse({ ...totals, repos });
  }

  const preview = await computeBillingPreview(input);
  return apiResponse(preview);
}
