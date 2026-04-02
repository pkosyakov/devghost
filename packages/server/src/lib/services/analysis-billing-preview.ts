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

export type RepoCacheBreakdown = {
  repository: string;
  totalCommits: number;
  cachedCommits: number;
  newCommits: number;
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
    // On first-run there are no CommitAnalysis rows for this order, so we
    // cannot hash-join cross-order cache against the actual commit set.
    // Subtracting a cross-order cache count from the flat aggregate would be
    // speculation — if the cache is overstated the analyze route under-reserves
    // and the worker can fail mid-run with CREDIT_EXHAUSTED.
    //
    // Conservative strategy: reserve the full total from the selectedDevelopers
    // aggregate. The worker releases unused reservation after the run completes.
    // Re-run path (below) has authoritative hash-level data and subtracts cache
    // precisely.
    const total = computeFirstRunTotal(selectedDevelopers, excludedEmails, scope);

    log.info(
      { total, billable: total, isFirstRun: true },
      'Billing preview computed (first-run, no cache subtraction)',
    );

    return {
      totalScopedCommits: total,
      reusableCachedCommits: 0,
      billableCommits: total,
      estimatedCredits: total,
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

// ── Per-repo cache breakdown ──────────────────────────────

async function computeRepoBreakdownRerun(
  userId: string,
  orderId: string,
  repoNames: string[],
  excludedEmails: string[],
  cacheMode: 'any' | 'model' | 'off',
  llmModel: string | null,
  scope: BillingPreviewScope,
): Promise<RepoCacheBreakdown[]> {
  const scopeFilter = buildScopeFilter(scope);
  const excludedFilter = buildExcludedFilter(excludedEmails);
  const cacheFilter = buildCacheFilter(cacheMode, orderId, llmModel);

  if (scope.mode === 'LAST_N_COMMITS' && scope.commitLimit && scope.commitLimit > 0) {
    // LAST_N: rank all commits globally, then group by repo
    return prisma.$queryRaw<RepoCacheBreakdown[]>`
      WITH ranked AS (
        SELECT DISTINCT ON (ca."commitHash") ca."commitHash", ca.repository, ca."authorDate"
        FROM "CommitAnalysis" ca
        WHERE ca."orderId" = ${orderId}
          AND ca."jobId" IS NULL
          AND ca.method != 'error'
          AND ca.repository IN (${Prisma.join(repoNames)})
          ${excludedFilter}
        ORDER BY ca."commitHash", ca."authorDate" DESC
      ),
      scoped AS (
        SELECT * FROM ranked
        ORDER BY "authorDate" DESC
        LIMIT ${scope.commitLimit}
      ),
      cached AS (
        SELECT DISTINCT ca."commitHash", s.repository
        FROM "CommitAnalysis" ca
        JOIN "Order" o ON o.id = ca."orderId"
        JOIN scoped s ON s."commitHash" = ca."commitHash"
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
      )
      SELECT
        s.repository,
        COUNT(DISTINCT s."commitHash")::int AS "totalCommits",
        COUNT(DISTINCT c."commitHash")::int AS "cachedCommits",
        (COUNT(DISTINCT s."commitHash") - COUNT(DISTINCT c."commitHash"))::int AS "newCommits"
      FROM scoped s
      LEFT JOIN cached c ON c."commitHash" = s."commitHash" AND c.repository = s.repository
      GROUP BY s.repository
      ORDER BY s.repository
    `;
  }

  // Non-LAST_N: standard grouping
  return prisma.$queryRaw<RepoCacheBreakdown[]>`
    WITH scoped AS (
      SELECT DISTINCT ca."commitHash", ca.repository
      FROM "CommitAnalysis" ca
      WHERE ca."orderId" = ${orderId}
        AND ca."jobId" IS NULL
        AND ca.method != 'error'
        AND ca.repository IN (${Prisma.join(repoNames)})
        ${scopeFilter}
        ${excludedFilter}
    ),
    cached AS (
      SELECT DISTINCT ca."commitHash", ca.repository
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
      s.repository,
      COUNT(DISTINCT s."commitHash")::int AS "totalCommits",
      COUNT(DISTINCT c."commitHash")::int AS "cachedCommits",
      (COUNT(DISTINCT s."commitHash") - COUNT(DISTINCT c."commitHash"))::int AS "newCommits"
    FROM scoped s
    LEFT JOIN cached c ON c."commitHash" = s."commitHash" AND c.repository = s.repository
    GROUP BY s.repository
    ORDER BY s.repository
  `;
}

export async function computeRepoCacheBreakdown(
  input: BillingPreviewInput,
): Promise<{ totals: BillingPreviewResult; repos: RepoCacheBreakdown[] }> {
  const totals = await computeBillingPreview(input);

  if (totals.isFirstRunEstimate) {
    return { totals, repos: [] };
  }

  const {
    userId, orderId, selectedRepos, excludedEmails, cacheMode, scope,
  } = input;

  const repoNames = parseRepoNames(selectedRepos);
  const llmModel = await resolveLlmModel(cacheMode);

  const repos = await computeRepoBreakdownRerun(
    userId, orderId, repoNames, excludedEmails,
    cacheMode, llmModel, scope,
  );

  return { totals, repos };
}
