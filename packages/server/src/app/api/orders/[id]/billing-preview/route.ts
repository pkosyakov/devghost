import { NextRequest } from 'next/server';
import {
  apiResponse,
  getOrderWithAuth,
  orderAuthError,
} from '@/lib/api-utils';
import {
  computeBillingPreview,
  computeRepoCacheBreakdown,
  type BillingPreviewScope,
} from '@/lib/services/analysis-billing-preview';

// ── Local helpers ─────────────────────────────────────────

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
    return apiResponse({ ...totals, repos });
  }

  const preview = await computeBillingPreview(input);
  return apiResponse(preview);
}
