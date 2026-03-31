/**
 * Analysis Billing Preview Service
 *
 * Single source of truth for estimating billable commits before/during analysis.
 * Dual-source strategy:
 *   - First-run path: flat aggregate from selectedDevelopers + cross-order cache
 *   - Re-run path: precise SQL from existing CommitAnalysis rows + cross-order cache
 */

import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { getLlmConfig } from '@/lib/llm-config';
import { billingLogger } from '@/lib/logger';

// ── Types ──────────────────────────────────────────────────

export type BillingPreviewScope = {
  mode: 'ALL_TIME' | 'SELECTED_YEARS' | 'DATE_RANGE' | 'LAST_N_COMMITS';
  years: number[];
  startDate: Date | null;
  endDate: Date | null;
  commitLimit: number | null;
};

export type BillingPreviewInput = {
  userId: string;
  orderId: string;
  selectedRepos: Array<Record<string, unknown>>;
  selectedDevelopers: Array<Record<string, unknown>>;
  excludedEmails: string[];
  cacheMode: 'any' | 'model' | 'off';
  scope: BillingPreviewScope;
};

export type BillingPreviewResult = {
  totalScopedCommits: number;
  reusableCachedCommits: number;
  billableCommits: number;
  estimatedCredits: number;
  isFirstRunEstimate: boolean;
};

// ── Shared helpers ─────────────────────────────────────────

function parseRepoNames(raw: Array<Record<string, unknown>>): string[] {
  const names = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const fullName = item.fullName ?? item.full_name;
    if (typeof fullName === 'string' && fullName.trim()) {
      names.add(fullName.trim());
    }
  }
  return [...names];
}

function buildScopeFilter(scope: BillingPreviewScope): Prisma.Sql {
  if (scope.mode === 'DATE_RANGE' && scope.startDate && scope.endDate) {
    return Prisma.sql`AND ca."authorDate" >= ${scope.startDate} AND ca."authorDate" <= ${scope.endDate}`;
  }
  if (scope.mode === 'SELECTED_YEARS' && scope.years.length > 0) {
    const yearPredicates = scope.years.map((year) => Prisma.sql`
      (ca."authorDate" >= ${new Date(`${year}-01-01T00:00:00.000Z`)}
       AND ca."authorDate" < ${new Date(`${year + 1}-01-01T00:00:00.000Z`)})
    `);
    return Prisma.sql`AND (${Prisma.join(yearPredicates, ' OR ')})`;
  }
  return Prisma.empty;
}

function buildExcludedFilter(excludedEmails: string[]): Prisma.Sql {
  if (excludedEmails.length > 0) {
    return Prisma.sql`AND ca."authorEmail" NOT IN (${Prisma.join(excludedEmails)})`;
  }
  return Prisma.empty;
}

function buildCacheFilter(
  cacheMode: 'any' | 'model' | 'off',
  orderId: string,
  llmModel: string | null,
): Prisma.Sql {
  if (cacheMode === 'off') {
    return Prisma.sql`AND FALSE`;
  }
  if (cacheMode === 'model') {
    if (llmModel) {
      return Prisma.sql`AND (ca."orderId" = ${orderId} OR ca."llmModel" = ${llmModel} OR ca."llmModel" IS NULL)`;
    }
    // Cannot determine model — restrict to same order only
    return Prisma.sql`AND ca."orderId" = ${orderId}`;
  }
  // cacheMode === 'any' — no additional filter
  return Prisma.empty;
}

async function resolveLlmModel(cacheMode: 'any' | 'model' | 'off'): Promise<string | null> {
  if (cacheMode !== 'model') return null;
  try {
    const config = await getLlmConfig();
    return config.provider === 'openrouter'
      ? config.openrouter.model
      : config.ollama.model;
  } catch (err) {
    billingLogger.warn({ err }, 'Failed to resolve LLM model for cache filter');
    return null;
  }
}

// ── First-run path ─────────────────────────────────────────

function computeFirstRunTotal(
  selectedDevelopers: Array<Record<string, unknown>>,
  excludedEmails: string[],
  scope: BillingPreviewScope,
): number {
  const excludedSet = new Set(excludedEmails);

  let total = 0;
  for (const dev of selectedDevelopers) {
    const email = dev.email;
    if (typeof email !== 'string' || !email.trim()) continue;
    if (excludedSet.has(email)) continue;

    const count = (dev.commitCount ?? dev.commit_count ?? 0) as number;
    total += typeof count === 'number' ? count : 0;
  }

  // Cap at commitLimit for LAST_N_COMMITS
  if (scope.mode === 'LAST_N_COMMITS' && scope.commitLimit && scope.commitLimit > 0) {
    total = Math.min(total, scope.commitLimit);
  }

  return total;
}

async function queryCrossOrderCache(
  userId: string,
  orderId: string,
  repoNames: string[],
  excludedEmails: string[],
  cacheMode: 'any' | 'model' | 'off',
  llmModel: string | null,
  scope: BillingPreviewScope,
): Promise<number> {
  if (cacheMode === 'off' || repoNames.length === 0) return 0;

  const scopeFilter = buildScopeFilter(scope);
  const excludedFilter = buildExcludedFilter(excludedEmails);
  const cacheFilter = buildCacheFilter(cacheMode, orderId, llmModel);

  const baseWhere = Prisma.sql`
    ca."jobId" IS NULL
    AND ca.method != 'error'
    AND ca.repository IN (${Prisma.join(repoNames)})
    AND ca."orderId" != ${orderId}
    AND o."userId" = ${userId}
    AND o.status = 'COMPLETED'
    ${cacheFilter}
    ${scopeFilter}
    ${excludedFilter}
  `;

  if (scope.mode === 'LAST_N_COMMITS' && scope.commitLimit && scope.commitLimit > 0) {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      WITH candidate AS (
        SELECT ca."commitHash", MAX(ca."authorDate") AS "authorDate"
        FROM "CommitAnalysis" ca
        JOIN "Order" o ON o.id = ca."orderId"
        WHERE ${baseWhere}
        GROUP BY ca."commitHash"
      ),
      ranked AS (
        SELECT "commitHash"
        FROM candidate
        ORDER BY "authorDate" DESC
        LIMIT ${scope.commitLimit}
      )
      SELECT COUNT(*)::int AS count FROM ranked
    `;
    return rows[0]?.count ?? 0;
  }

  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(DISTINCT ca."commitHash")::int AS count
    FROM "CommitAnalysis" ca
    JOIN "Order" o ON o.id = ca."orderId"
    WHERE ${baseWhere}
  `;
  return rows[0]?.count ?? 0;
}

// ── Re-run path ────────────────────────────────────────────

async function computeRerunPreview(
  userId: string,
  orderId: string,
  repoNames: string[],
  excludedEmails: string[],
  cacheMode: 'any' | 'model' | 'off',
  llmModel: string | null,
  scope: BillingPreviewScope,
): Promise<{ total: number; cached: number }> {
  const scopeFilter = buildScopeFilter(scope);
  const excludedFilter = buildExcludedFilter(excludedEmails);
  const cacheFilter = buildCacheFilter(cacheMode, orderId, llmModel);

  // For LAST_N_COMMITS, use a ranked subquery
  if (scope.mode === 'LAST_N_COMMITS' && scope.commitLimit && scope.commitLimit > 0) {
    const rows = await prisma.$queryRaw<{ total: number; cached: number }[]>`
      WITH scoped AS (
        SELECT DISTINCT ca."commitHash", MAX(ca."authorDate") AS "authorDate"
        FROM "CommitAnalysis" ca
        WHERE ca."orderId" = ${orderId}
          AND ca."jobId" IS NULL
          AND ca.method != 'error'
          AND ca.repository IN (${Prisma.join(repoNames)})
          ${excludedFilter}
        GROUP BY ca."commitHash"
        ORDER BY "authorDate" DESC
        LIMIT ${scope.commitLimit}
      ),
      cached AS (
        SELECT DISTINCT ca."commitHash"
        FROM "CommitAnalysis" ca
        JOIN "Order" o ON o.id = ca."orderId"
        WHERE ca."jobId" IS NULL
          AND ca.method != 'error'
          AND ca.repository IN (${Prisma.join(repoNames)})
          AND (
            ca."orderId" = ${orderId}
            OR (
              ca."orderId" != ${orderId}
              AND o."userId" = ${userId}
              AND o.status = 'COMPLETED'
            )
          )
          ${cacheFilter}
          ${excludedFilter}
          AND ca."commitHash" IN (SELECT "commitHash" FROM scoped)
      )
      SELECT
        (SELECT COUNT(*)::int FROM scoped) AS total,
        (SELECT COUNT(*)::int FROM cached) AS cached
    `;
    return rows[0] ?? { total: 0, cached: 0 };
  }

  // Non-LAST_N: standard CTE query
  const rows = await prisma.$queryRaw<{ total: number; cached: number }[]>`
    WITH scoped AS (
      SELECT DISTINCT ca."commitHash"
      FROM "CommitAnalysis" ca
      WHERE ca."orderId" = ${orderId}
        AND ca."jobId" IS NULL
        AND ca.method != 'error'
        AND ca.repository IN (${Prisma.join(repoNames)})
        ${scopeFilter}
        ${excludedFilter}
    ),
    cached AS (
      SELECT DISTINCT ca."commitHash"
      FROM "CommitAnalysis" ca
      JOIN "Order" o ON o.id = ca."orderId"
      WHERE ca."jobId" IS NULL
        AND ca.method != 'error'
        AND ca.repository IN (${Prisma.join(repoNames)})
        AND (
          ca."orderId" = ${orderId}
          OR (
            ca."orderId" != ${orderId}
            AND o."userId" = ${userId}
            AND o.status = 'COMPLETED'
          )
        )
        ${cacheFilter}
        ${scopeFilter}
        ${excludedFilter}
        AND ca."commitHash" IN (SELECT "commitHash" FROM scoped)
    )
    SELECT
      (SELECT COUNT(*)::int FROM scoped) AS total,
      (SELECT COUNT(*)::int FROM cached) AS cached
  `;
  return rows[0] ?? { total: 0, cached: 0 };
}

// ── Main function ──────────────────────────────────────────

export async function computeBillingPreview(
  input: BillingPreviewInput,
): Promise<BillingPreviewResult> {
  const {
    userId,
    orderId,
    selectedRepos,
    selectedDevelopers,
    excludedEmails,
    cacheMode,
    scope,
  } = input;

  const log = billingLogger.child({ orderId, userId });

  const repoNames = parseRepoNames(selectedRepos);
  if (repoNames.length === 0) {
    log.debug('No repos selected — returning zero preview');
    return {
      totalScopedCommits: 0,
      reusableCachedCommits: 0,
      billableCommits: 0,
      estimatedCredits: 0,
      isFirstRunEstimate: true,
    };
  }

  // Check if CommitAnalysis rows exist for this order (non-benchmark, non-error)
  const existingRows = await prisma.commitAnalysis.count({
    where: {
      orderId,
      jobId: null,
      method: { not: 'error' },
    },
  });

  const llmModel = await resolveLlmModel(cacheMode);

  if (existingRows === 0) {
    // ── First-run path ──
    const total = computeFirstRunTotal(selectedDevelopers, excludedEmails, scope);

    if (total === 0) {
      return {
        totalScopedCommits: 0,
        reusableCachedCommits: 0,
        billableCommits: 0,
        estimatedCredits: 0,
        isFirstRunEstimate: true,
      };
    }

    const cached = cacheMode === 'off'
      ? 0
      : await queryCrossOrderCache(
          userId, orderId, repoNames, excludedEmails,
          cacheMode, llmModel, scope,
        );

    const cappedCache = Math.min(cached, total);
    let billable = Math.max(0, total - cappedCache);

    // First-run safety: cross-order cache counts hashes from other orders but
    // we cannot hash-join them against the current order's actual commit set
    // (which doesn't exist yet). If cache subtraction drives billable to 0 but
    // total > 0, keep a 1-credit safety margin so the analyze route still
    // reserves credits. This avoids CREDIT_EXHAUSTED when the worker encounters
    // commits that weren't in the cross-order cache after all.
    // This is NOT the old universal Math.max(1) — it only applies to first-run
    // where hash-level verification is impossible.
    if (total > 0 && billable === 0) {
      billable = 1;
      log.debug(
        { total, cached: cappedCache },
        'First-run safety: cache >= total but no hash-level join — keeping 1-credit floor',
      );
    }

    log.info(
      { total, cached: cappedCache, billable, isFirstRun: true },
      'Billing preview computed (first-run)',
    );

    return {
      totalScopedCommits: total,
      reusableCachedCommits: cappedCache,
      billableCommits: billable,
      estimatedCredits: billable,
      isFirstRunEstimate: true,
    };
  }

  // ── Re-run path ──
  const { total, cached } = await computeRerunPreview(
    userId, orderId, repoNames, excludedEmails,
    cacheMode, llmModel, scope,
  );

  const billable = Math.max(0, total - cached);

  log.info(
    { total, cached, billable, isFirstRun: false },
    'Billing preview computed (re-run)',
  );

  return {
    totalScopedCommits: total,
    reusableCachedCommits: cached,
    billableCommits: billable,
    estimatedCredits: billable,
    isFirstRunEstimate: false,
  };
}
