import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import {
  apiResponse,
  apiError,
  requireUserSession,
  isErrorResponse,
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

  const session = await requireUserSession();
  if (isErrorResponse(session)) return session;

  const order = await prisma.order.findFirst({
    where: { id, userId: session.user.id },
    select: {
      id: true,
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

  if (!order) {
    return apiError('Order not found', 404);
  }

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
    : order.excludedDevelopers;

  const periodModeParam = searchParams.get('analysisPeriodMode');
  const scopeMode = periodModeParam ?? order.analysisPeriodMode;

  const startDateParam = toDateOrNull(searchParams.get('analysisStartDate'));
  const endDateParam = toDateOrNull(searchParams.get('analysisEndDate'));
  const commitLimitParam = toFiniteNumber(searchParams.get('analysisCommitLimit'));
  const yearsParam = searchParams.has('analysisYears')
    ? parseYears(searchParams.get('analysisYears'))
    : null;

  const scope: BillingPreviewScope = {
    mode: scopeMode as BillingPreviewScope['mode'],
    years: yearsParam ?? order.analysisYears,
    startDate: startDateParam ?? order.analysisStartDate,
    endDate: endDateParam ?? order.analysisEndDate,
    commitLimit: commitLimitParam !== null
      ? commitLimitParam
      : order.analysisCommitLimit,
  };

  const input = {
    userId: session.user.id,
    orderId: order.id,
    selectedRepos: order.selectedRepos as Array<Record<string, unknown>>,
    selectedDevelopers: order.selectedDevelopers as Array<Record<string, unknown>>,
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
