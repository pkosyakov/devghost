/**
 * Analysis Worker — orchestrates the full analysis pipeline.
 *
 * Flow: clone repos → extract commits → run Python pipeline → save results → calculate Ghost %
 */
import prisma from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { getLlmConfig } from '@/lib/llm-config';
import type { LlmConfig } from '@/lib/llm-config';
import { analysisLogger, billingLogger } from '@/lib/logger';
import { getGhostMetricsService } from './ghost-metrics-service';
import { debitCredit, isBillingEnabled, releaseReservedCredits } from '@/lib/services/credit-service';
import {
  cloneOrUpdateRepo,
  extractCommits as gitExtractCommits,
  writeCommitsFile,
  cleanupCommitsFile,
  type GitCommit,
} from './git-operations';
import { projectContributorsFromOrder } from './contributor-identity';
import {
  checkOllamaHealth,
  spawnPipeline,
  aggregateLlmUsage,
  PipelineError,
  type PipelineCommitResult,
  type LlmUsageStats,
} from './pipeline-bridge';
import { appendPipelineLog, getPipelineLogs, clearPipelineLogs, updateJobMeta, getJobMeta } from './pipeline-log-store';
import { registerJob, unregisterJob, isCancelRequested } from './job-registry';
import { type ScopeConfig, getInScopeShas, countInScopeCommits } from '@/lib/services/scope-filter';
import type { SelectedRepository } from '@/types/repository';

// ==================== Billing Helpers ====================

/** Account for cached commits — release reservation without wallet debit (batched). */
async function accountCachedBatch(
  count: number, userId: string, jobId: string, skip: boolean,
): Promise<void> {
  if (skip || count === 0) return;
  await prisma.$transaction(async (tx) => {
    await tx.analysisJob.update({
      where: { id: jobId },
      data: { creditsReleased: { increment: count } },
    });
    await tx.$executeRaw`
      UPDATE "User" SET "reservedCredits" = GREATEST("reservedCredits" - ${count}, 0)
      WHERE id = ${userId}
    `;
  });
}

/** Debit 1 credit per non-cached commit. Returns true if all debited OK. */
async function debitBatch(
  count: number, userId: string, jobId: string, orderId: string, skip: boolean,
): Promise<boolean> {
  if (skip || count === 0) return true;
  for (let ci = 0; ci < count; ci++) {
    const result = await debitCredit(userId, jobId, orderId);
    if (!result) {
      billingLogger.warn(
        { userId, jobId, orderId, debited: ci, total: count },
        'Credit reservation exhausted during analysis',
      );
      await prisma.order.update({
        where: { id: orderId },
        data: { status: 'INSUFFICIENT_CREDITS', errorMessage: 'Credit reservation exhausted during analysis' },
      });
      return false;
    }
  }
  return true;
}

// ==================== Repo Normalization ====================

/** JSONB in DB may store snake_case (from GitHub API) or camelCase keys. Normalize to camelCase. */
function normalizeRepo(raw: Record<string, unknown>): SelectedRepository {
  return {
    id: (raw.id as number) ?? 0,
    name: (raw.name as string) ?? '',
    fullName: (raw.fullName ?? raw.full_name ?? '') as string,
    description: (raw.description as string) ?? null,
    url: (raw.url ?? raw.html_url ?? '') as string,
    cloneUrl: (raw.cloneUrl ?? raw.clone_url ?? '') as string,
    language: (raw.language as string) ?? null,
    stars: (raw.stars ?? raw.stargazers_count ?? 0) as number,
    isPrivate: (raw.isPrivate ?? raw.is_private ?? false) as boolean,
    defaultBranch: (raw.defaultBranch ?? raw.default_branch ?? 'main') as string,
    owner: (raw.owner as SelectedRepository['owner']) ?? { login: '', avatarUrl: '' },
    source: (raw.source ?? 'public') as SelectedRepository['source'],
  };
}

// ==================== Constants ====================

const BATCH_SIZE = 100;
const PROGRESS_THROTTLE_MS = 1000;

// ==================== Main Entry ====================

interface AnalysisJobOptions {
  isBenchmark?: boolean;
  llmConfigOverride?: LlmConfig;
  noLlmCache?: boolean;
  contextLength?: number;
  failFast?: boolean;
  promptRepeat?: boolean;
  cacheMode?: 'any' | 'model' | 'off';  // cross-order commit cache behavior
  forceRecalculate?: boolean;  // delete in-scope commits and re-analyze from scratch
  skipBillingOverride?: boolean; // force billing on/off for admin/manual reruns
}

export async function processAnalysisJob(
  jobId: string,
  options: AnalysisJobOptions = {},
): Promise<void> {
  const log = analysisLogger.child({ jobId });
  const updateJobProgress = createProgressTracker();
  log.info('Starting job');

  const job = await prisma.analysisJob.findUnique({
    where: { id: jobId },
    include: { order: { include: { user: true } } },
  });
  if (!job || job.status !== 'PENDING') {
    log.warn({ status: job?.status }, 'Job not found or not PENDING, skipping');
    return;
  }

  const order = job.order;
  const userId = order.userId;
  const githubToken = job.order.user.githubAccessToken ?? undefined;
  const skipBilling = options.skipBillingOverride
    ?? (!!options.isBenchmark || !isBillingEnabled() || order.user.role === 'ADMIN');

  log.info({ orderId: order.id, orderName: order.name, hasToken: !!githubToken, skipBilling }, 'Order loaded');

  // Mark RUNNING (init totalCommits to 0 so Prisma increment works on non-null)
  // Order status already set to PROCESSING by the analyze endpoint
  await prisma.analysisJob.update({
    where: { id: jobId },
    data: { status: 'RUNNING', startedAt: new Date(), totalCommits: 0 },
  });

  try {
    // 1. Check LLM provider health — fail fast
    let llmConfig = await getLlmConfig();
    if (options.llmConfigOverride) {
      llmConfig = options.llmConfigOverride;
      log.info({ provider: llmConfig.provider, model: llmConfig.provider === 'openrouter' ? llmConfig.openrouter.model : llmConfig.ollama.model }, 'Using config override');
    }
    log.info({ provider: llmConfig.provider, ollamaUrl: llmConfig.ollama.url, ollamaModel: llmConfig.ollama.model }, 'LLM config');

    // Write provider/model early so the progress UI shows it during analysis
    await prisma.analysisJob.update({
      where: { id: jobId },
      data: {
        llmProvider: llmConfig.provider,
        llmModel: llmConfig.provider === 'openrouter' ? llmConfig.openrouter.model : llmConfig.ollama.model,
      },
    });

    const currentLlmModel = llmConfig.provider === 'openrouter'
      ? llmConfig.openrouter.model
      : llmConfig.ollama.model;

    if (llmConfig.provider === 'ollama') {
      const ollamaHealthy = await checkOllamaHealth(llmConfig.ollama.url);
      log.info({ healthy: ollamaHealthy }, 'Ollama health check');

      if (!ollamaHealthy) {
        throw new Error(
          `Ollama is not reachable at ${llmConfig.ollama.url}. ` +
          'Please ensure Ollama is running with the required model loaded.'
        );
      }
    } else {
      log.info({ model: llmConfig.openrouter.model }, 'Using OpenRouter — skipping Ollama health check');
    }

    // 2. Clear CommitAnalysis for force recalculate (skip for benchmarks — they append)
    //    Note: metrics + DailyEffort are cleared later, just before recalculation (step 6),
    //    so that cancellation during the repo loop preserves existing metrics.
    if (!options.isBenchmark) {
      if (options.forceRecalculate) {
        // Force: delete only IN-SCOPE CommitAnalysis, preserve out-of-scope
        const scopeConfig: ScopeConfig = {
          analysisPeriodMode: order.analysisPeriodMode,
          analysisYears: order.analysisYears,
          analysisStartDate: order.analysisStartDate,
          analysisEndDate: order.analysisEndDate,
          analysisCommitLimit: order.analysisCommitLimit,
        };
        const inScopeShas = await getInScopeShas(order.id, scopeConfig);
        if (inScopeShas.size > 0) {
          const deletedCommits = await prisma.commitAnalysis.deleteMany({
            where: { orderId: order.id, jobId: null, commitHash: { in: [...inScopeShas] } },
          });
          log.info({ deletedCommits: deletedCommits.count }, 'Force recalculate — cleared in-scope commits');
        }
      }
    }

    // 3. Parse repos and build commit scope (normalize snake_case JSONB → camelCase)
    const rawRepos = (order.selectedRepos as unknown as Record<string, unknown>[]) ?? [];
    const repos = rawRepos.map(normalizeRepo);
    const { since, until, maxCount, years } = buildCommitScope(order);
    const excludedEmails = order.excludedDevelopers ?? [];

    log.info({
      repoCount: repos.length,
      period: order.analysisPeriodMode,
      since: since ?? 'none',
      until: until ?? 'none',
      maxCount: maxCount ?? 'none',
      excludedEmails,
      repos: repos.map(r => ({ fullName: r.fullName, language: r.language, isPrivate: r.isPrivate })),
    }, 'Analysis config');

    if (!options.isBenchmark) {
      await prisma.order.update({
        where: { id: order.id },
        data: { repositoriesTotal: repos.length, repositoriesProcessed: 0, repositoriesFailed: 0 },
      });
    }

    let totalAnalyzed = 0;
    let totalCacheHits = 0;
    const effectiveCacheMode = options.isBenchmark ? 'off' as const : (options.cacheMode ?? 'model' as const);
    const accumulatedUsage: LlmUsageStats = {
      totalPromptTokens: 0, totalCompletionTokens: 0, totalLlmCalls: 0, totalDurationMs: 0,
    };

    const isLastN = order.analysisPeriodMode === 'LAST_N_COMMITS' && !!order.analysisCommitLimit;

    // For LAST_N: two-phase processing — extract all repos first, then global truncation, then pipeline
    const lastNExtracted: Array<{
      repoIdx: number;
      repo: typeof repos[number];
      repoLabel: string;
      repoPath: string;
      commits: GitCommit[];
    }> = [];

    // 4. Process each repo sequentially
    for (let repoIdx = 0; repoIdx < repos.length; repoIdx++) {
      // Early cancellation check before starting next repo
      if (isCancelRequested(jobId)) {
        log.info({ repoIdx, repoTotal: repos.length }, 'Cancel requested — skipping remaining repos');
        break;
      }

      const repo = repos[repoIdx]!;
      const repoLabel = repo.fullName || repo.name;
      const rlog = log.child({ repo: repoLabel, repoIdx: repoIdx + 1, repoTotal: repos.length });

      rlog.info('Processing repo');

      if (!options.isBenchmark) {
        await prisma.order.update({
          where: { id: order.id },
          data: { currentRepoName: repoLabel },
        });
      }

      // 4a. Clone / update
      rlog.info({ cloneUrl: repo.cloneUrl, branch: repo.defaultBranch }, 'Cloning');
      await updateJobProgress(jobId, 0, undefined, 'cloning');

      let repoPath: string;
      try {
        const cloneResult = await cloneOrUpdateRepo(
          repo.cloneUrl,
          repo.fullName,
          repo.isPrivate ? githubToken : undefined,
          repo.defaultBranch,
          maxCount ? undefined : since, // LAST_N_COMMITS needs full history, skip shallow clone
        );
        repoPath = cloneResult.repoPath;
        rlog.info({ repoPath, isNewClone: cloneResult.isNewClone, commitCount: cloneResult.commitCount, sizeKb: cloneResult.sizeKb }, 'Clone OK');

        // Track cumulative clone size for progress display
        const prevMeta = getJobMeta(jobId);
        updateJobMeta(jobId, {
          totalCloneSizeKb: (prevMeta?.totalCloneSizeKb ?? 0) + cloneResult.sizeKb,
        });
      } catch (err) {
        rlog.error({ err }, 'Clone failed');
        if (!options.isBenchmark) {
          await prisma.order.update({
            where: { id: order.id },
            data: { repositoriesFailed: { increment: 1 } },
          });
        }
        continue;
      }

      // 4b. Extract commits
      rlog.info('Extracting commits');
      await updateJobProgress(jobId, 0, undefined, 'extracting');

      let commits = years?.length
        ? await extractCommitsForSelectedYears(repoPath, years, excludedEmails)
        : await gitExtractCommits(repoPath, { since, until, maxCount, excludedEmails });

      // Benchmark: pin to the exact same commit set as the base analysis.
      // Without this, git fetch may pull new commits that weren't in the original run.
      if (options.isBenchmark && job.baseJobId) {
        const baseCommits = await prisma.commitAnalysis.findMany({
          where: { orderId: order.id, jobId: null, repository: repoLabel },
          select: { commitHash: true },
        });
        const baseHashSet = new Set(baseCommits.map(c => c.commitHash));
        const before = commits.length;
        commits = commits.filter(c => baseHashSet.has(c.sha));
        if (before !== commits.length) {
          rlog.info({ extracted: before, baseSet: baseHashSet.size, pinned: commits.length }, 'Pinned to base analysis commit set');
        }
      }

      rlog.info({ commitCount: commits.length }, 'Commits extracted');
      if (commits.length > 0) {
        rlog.debug({
          first: `${commits[0]!.sha.slice(0, 8)} "${commits[0]!.message.slice(0, 60)}" by ${commits[0]!.authorEmail}`,
          last: `${commits[commits.length - 1]!.sha.slice(0, 8)} "${commits[commits.length - 1]!.message.slice(0, 60)}"`,
        }, 'Commit range');
      }

      if (commits.length === 0) {
        rlog.info('No commits found, skipping');
        if (!options.isBenchmark) {
          await prisma.order.update({
            where: { id: order.id },
            data: { repositoriesProcessed: { increment: 1 } },
          });
        }
        continue;
      }

      // For LAST_N: defer pipeline processing until after global truncation (Phase 2)
      if (isLastN) {
        lastNExtracted.push({ repoIdx, repo, repoLabel, repoPath, commits });
        continue;
      }

      // Intra-order dedup: skip commits already analyzed in THIS order (unless force)
      if (!options.forceRecalculate && !options.isBenchmark) {
        const existingInOrder = await prisma.commitAnalysis.findMany({
          where: { orderId: order.id, jobId: null, method: { not: 'error' }, commitHash: { in: commits.map(c => c.sha) } },
          select: { commitHash: true },
        });
        const existingSet = new Set(existingInOrder.map(c => c.commitHash));
        if (existingSet.size > 0) {
          rlog.info({ existing: existingSet.size, total: commits.length }, 'Intra-order dedup — skipping already analyzed');
          totalAnalyzed += existingSet.size;
          commits = commits.filter(c => !existingSet.has(c.sha));
        }
      }

      if (commits.length === 0) {
        rlog.info('All commits already in order, skipping pipeline');
        if (!options.isBenchmark) {
          await prisma.order.update({
            where: { id: order.id },
            data: { repositoriesProcessed: { increment: 1 } },
          });
        }
        continue;
      }

      // Cross-order cache: look up previously analyzed commits before sending to pipeline
      const allCommitShas = commits.map(c => c.sha);
      const { rows: cachedRows, shaSet: cachedShaSet } = await lookupCachedCommits(
        allCommitShas,
        order.id,
        userId,
        repoLabel,
        effectiveCacheMode,
        currentLlmModel,
      );

      if (cachedRows.length > 0) {
        await copyCachedToOrder(cachedRows, order.id, repoLabel);
        totalCacheHits += cachedRows.length;
        totalAnalyzed += cachedRows.length;
        rlog.info({ cached: cachedRows.length, total: allCommitShas.length }, 'Cross-order cache hit');

        // Account for cached commits — release reservation without wallet debit
        await accountCachedBatch(cachedRows.length, userId, jobId, skipBilling);
      }

      // Filter out already-cached commits
      commits = commits.filter(c => !cachedShaSet.has(c.sha));
      rlog.debug({ remaining: commits.length }, 'Commits after cache filter');

      if (commits.length === 0 && cachedRows.length > 0) {
        // All commits from cache — skip pipeline entirely for this repo
        rlog.info('All commits served from cache, skipping pipeline');
        await prisma.analysisJob.update({
          where: { id: jobId },
          data: { totalCommits: { increment: allCommitShas.length } },
        });
        if (!options.isBenchmark) {
          await prisma.order.update({
            where: { id: order.id },
            data: { repositoriesProcessed: { increment: 1 } },
          });
        }
        continue;
      }

      await prisma.analysisJob.update({
        where: { id: jobId },
        data: { totalCommits: { increment: allCommitShas.length } },
      });

      // 4c. Write temp file and run pipeline
      rlog.info({ commitCount: commits.length, language: repo.language || 'Unknown' }, 'Running pipeline');
      await updateJobProgress(jobId, 0, undefined, 'analyzing');

      const commitsFile = await writeCommitsFile(commits, repo.fullName);
      rlog.debug({ commitsFile }, 'Commits file written');

      try {
        const language = repo.language || 'Unknown';

        const pipelineResult = await spawnPipeline(repoPath, language, commitsFile, {
          llmConfigOverride: options.isBenchmark ? llmConfig : undefined,
          noLlmCache: options.noLlmCache,
          contextLength: options.contextLength,
          failFast: options.failFast,
          promptRepeat: options.promptRepeat,
          onSpawn: (pid) => registerJob(jobId, pid),
          onProgress: (current, total) => {
            const overallProgress = Math.round(
              ((repoIdx / repos.length) + (current / total / repos.length)) * 90
            );
            updateJobProgress(jobId, overallProgress, totalAnalyzed + current, 'analyzing')
              .catch(() => {}); // fire-and-forget, throttled
          },
          onResult: (entry) => {
            appendPipelineLog(jobId, {
              ...entry,
              ts: Date.now(),
              repo: repoLabel,
            });
          },
        });

        rlog.info({ results: pipelineResult.commits.length, errors: pipelineResult.errors.length }, 'Pipeline done');
        if (pipelineResult.errors.length > 0) {
          rlog.warn({ pipelineErrors: pipelineResult.errors }, 'Pipeline had errors');
        }

        // Log LLM errors from first few commits (helps diagnose OpenRouter failures)
        const errorCommits = pipelineResult.commits.filter(c => c.method === 'error').slice(0, 3);
        if (errorCommits.length > 0) {
          const totalErrors = pipelineResult.commits.filter(c => c.method === 'error').length;
          rlog.warn({ totalErrors, total: pipelineResult.commits.length }, 'Commits with LLM errors');
          for (const ec of errorCommits) {
            const llmErrors = (ec.llm_calls ?? [])
              .filter(c => c.error)
              .map(c => c.error);
            if (llmErrors.length > 0) {
              rlog.warn({ sha: ec.sha.slice(0, 8), llmErrors }, 'LLM call errors');
            }
          }
        }

        for (const r of pipelineResult.commits.slice(0, 3)) {
          rlog.debug({ sha: r.sha.slice(0, 8), hours: r.estimated_hours, method: r.method, type: r.analysis?.change_type }, 'Sample result');
        }

        // 4d. Aggregate LLM usage
        const repoUsage = aggregateLlmUsage(pipelineResult.commits);
        accumulatedUsage.totalPromptTokens += repoUsage.totalPromptTokens;
        accumulatedUsage.totalCompletionTokens += repoUsage.totalCompletionTokens;
        accumulatedUsage.totalLlmCalls += repoUsage.totalLlmCalls;
        accumulatedUsage.totalDurationMs += repoUsage.totalDurationMs;
        rlog.info({
          promptTokens: repoUsage.totalPromptTokens,
          completionTokens: repoUsage.totalCompletionTokens,
          llmCalls: repoUsage.totalLlmCalls,
        }, 'Repo LLM usage');

        // 4e. Map results to CommitAnalysis records
        const commitMap = new Map(commits.map(c => [c.sha, c]));
        const analyses = pipelineResult.commits.map(result => {
          const commit = commitMap.get(result.sha);
          const analysis = mapToCommitAnalysis(result, commit, order.id, repoLabel, currentLlmModel);
          return options.isBenchmark ? { ...analysis, jobId } : analysis;
        });

        await saveCommitAnalyses(analyses);
        totalAnalyzed += analyses.length;
        rlog.info({ saved: analyses.length, totalAnalyzed }, 'Commit analyses saved');

        // Debit 1 credit per processed (non-cached) commit
        if (!await debitBatch(analyses.length, userId, jobId, order.id, skipBilling)) {
          throw new Error('CREDIT_EXHAUSTED');
        }

      } catch (err) {
        rlog.error({ err }, 'Pipeline failed');
        if (err instanceof PipelineError) {
          if (!options.isBenchmark) {
            await prisma.order.update({
              where: { id: order.id },
              data: { repositoriesFailed: { increment: 1 } },
            });
          }
          continue;
        }
        throw err;
      } finally {
        await cleanupCommitsFile(commitsFile);
      }

      if (!options.isBenchmark) {
        await prisma.order.update({
          where: { id: order.id },
          data: { repositoriesProcessed: { increment: 1 } },
        });
      }

      // Check cancellation between repos
      if (isCancelRequested(jobId)) {
        log.info({ repoIdx: repoIdx + 1, repoTotal: repos.length }, 'Cancel requested — breaking repo loop');
        break;
      }
    }

    // 4.5. Handle cancellation
    if (isCancelRequested(jobId)) {
      log.info({ totalAnalyzed }, 'Job cancelled');

      // Release unused reserved credits
      if (!skipBilling) {
        await releaseReservedCredits(userId, jobId, order.id);
      }

      const cancelLog = getPipelineLogs(jobId);
      await prisma.analysisJob.update({
        where: { id: jobId },
        data: {
          status: 'CANCELLED',
          completedAt: new Date(),
          pipelineLog: cancelLog.length > 0 ? cancelLog as unknown as Prisma.InputJsonValue : undefined,
        },
      });

      if (!options.isBenchmark) {
        // Reset order to previous usable state
        const hasMetrics = await prisma.orderMetric.count({ where: { orderId: order.id } });
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: hasMetrics > 0 ? 'COMPLETED' : 'READY_FOR_ANALYSIS',
            errorMessage: null,
          },
        });
      }

      setTimeout(() => clearPipelineLogs(jobId), 30_000);
      return; // exit early — skip metrics calculation
    }

    // ── LAST_N Phase 1.5 + Phase 2: global truncation then pipeline ──
    if (isLastN && lastNExtracted.length > 0 && !isCancelRequested(jobId)) {
      // Phase 1.5: Global sort + truncate to N across all repos
      const allExtractedCommits = lastNExtracted.flatMap(e =>
        e.commits.map(c => ({ ...c, _repoLabel: e.repoLabel }))
      );
      allExtractedCommits.sort((a, b) =>
        new Date(b.authorDate).getTime() - new Date(a.authorDate).getTime()
      );
      const topN = allExtractedCommits.slice(0, order.analysisCommitLimit!);
      const allowedShas = new Set(topN.map(c => c.sha));

      log.info({
        totalExtracted: allExtractedCommits.length,
        globalTopN: topN.length,
        repos: lastNExtracted.length,
      }, 'LAST_N global truncation — selected top N by date across all repos');

      // Phase 2: Process pipeline for each repo (only allowed commits)
      for (let i = 0; i < lastNExtracted.length; i++) {
        if (isCancelRequested(jobId)) {
          log.info({ i, total: lastNExtracted.length }, 'Cancel requested — skipping remaining LAST_N repos');
          break;
        }

        const { repoIdx, repo, repoLabel, repoPath, commits: rawCommits } = lastNExtracted[i]!;
        const rlog = log.child({ repo: repoLabel, repoIdx: repoIdx + 1, repoTotal: repos.length });

        // Filter to globally allowed SHAs
        let commits = rawCommits.filter(c => allowedShas.has(c.sha));
        if (commits.length === 0) {
          rlog.info('No in-scope commits after global truncation');
          if (!options.isBenchmark) {
            await prisma.order.update({
              where: { id: order.id },
              data: { repositoriesProcessed: { increment: 1 } },
            });
          }
          continue;
        }

        rlog.info({ inScope: commits.length, extracted: rawCommits.length }, 'Commits in global top N');

        if (!options.isBenchmark) {
          await prisma.order.update({
            where: { id: order.id },
            data: { currentRepoName: repoLabel },
          });
        }

        // Intra-order dedup: skip commits already analyzed in THIS order (unless force)
        if (!options.forceRecalculate && !options.isBenchmark) {
          const existingInOrder = await prisma.commitAnalysis.findMany({
            where: { orderId: order.id, jobId: null, method: { not: 'error' }, commitHash: { in: commits.map(c => c.sha) } },
            select: { commitHash: true },
          });
          const existingSet = new Set(existingInOrder.map(c => c.commitHash));
          if (existingSet.size > 0) {
            rlog.info({ existing: existingSet.size, total: commits.length }, 'Intra-order dedup — skipping already analyzed');
            totalAnalyzed += existingSet.size;
            commits = commits.filter(c => !existingSet.has(c.sha));
          }
        }

        if (commits.length === 0) {
          rlog.info('All in-scope commits already in order, skipping pipeline');
          if (!options.isBenchmark) {
            await prisma.order.update({
              where: { id: order.id },
              data: { repositoriesProcessed: { increment: 1 } },
            });
          }
          continue;
        }

        // Cross-order cache
        const allCommitShas = commits.map(c => c.sha);
        const { rows: cachedRows, shaSet: cachedShaSet } = await lookupCachedCommits(
          allCommitShas, order.id, userId, repoLabel, effectiveCacheMode, currentLlmModel,
        );

        if (cachedRows.length > 0) {
          await copyCachedToOrder(cachedRows, order.id, repoLabel);
          totalCacheHits += cachedRows.length;
          totalAnalyzed += cachedRows.length;
          rlog.info({ cached: cachedRows.length, total: allCommitShas.length }, 'Cross-order cache hit');

          // Account for cached commits — release reservation without wallet debit
          await accountCachedBatch(cachedRows.length, userId, jobId, skipBilling);
        }

        commits = commits.filter(c => !cachedShaSet.has(c.sha));
        rlog.debug({ remaining: commits.length }, 'Commits after cache filter');

        if (commits.length === 0 && cachedRows.length > 0) {
          rlog.info('All commits served from cache, skipping pipeline');
          await prisma.analysisJob.update({
            where: { id: jobId },
            data: { totalCommits: { increment: allCommitShas.length } },
          });
          if (!options.isBenchmark) {
            await prisma.order.update({
              where: { id: order.id },
              data: { repositoriesProcessed: { increment: 1 } },
            });
          }
          continue;
        }

        await prisma.analysisJob.update({
          where: { id: jobId },
          data: { totalCommits: { increment: allCommitShas.length } },
        });

        // Pipeline
        rlog.info({ commitCount: commits.length, language: repo.language || 'Unknown' }, 'Running pipeline');
        await updateJobProgress(jobId, 0, undefined, 'analyzing');

        const commitsFile = await writeCommitsFile(commits, repo.fullName);
        rlog.debug({ commitsFile }, 'Commits file written');

        try {
          const language = repo.language || 'Unknown';

          const pipelineResult = await spawnPipeline(repoPath, language, commitsFile, {
            llmConfigOverride: options.isBenchmark ? llmConfig : undefined,
            noLlmCache: options.noLlmCache,
            contextLength: options.contextLength,
            failFast: options.failFast,
            promptRepeat: options.promptRepeat,
            onSpawn: (pid) => registerJob(jobId, pid),
            onProgress: (current, total) => {
              const overallProgress = Math.round(
                ((i / lastNExtracted.length) + (current / total / lastNExtracted.length)) * 90
              );
              updateJobProgress(jobId, overallProgress, totalAnalyzed + current, 'analyzing')
                .catch(() => {});
            },
            onResult: (entry) => {
              appendPipelineLog(jobId, { ...entry, ts: Date.now(), repo: repoLabel });
            },
          });

          rlog.info({ results: pipelineResult.commits.length, errors: pipelineResult.errors.length }, 'Pipeline done');
          if (pipelineResult.errors.length > 0) {
            rlog.warn({ pipelineErrors: pipelineResult.errors }, 'Pipeline had errors');
          }

          const errorCommits = pipelineResult.commits.filter(c => c.method === 'error').slice(0, 3);
          if (errorCommits.length > 0) {
            const totalErrors = pipelineResult.commits.filter(c => c.method === 'error').length;
            rlog.warn({ totalErrors, total: pipelineResult.commits.length }, 'Commits with LLM errors');
            for (const ec of errorCommits) {
              const llmErrors = (ec.llm_calls ?? []).filter(c => c.error).map(c => c.error);
              if (llmErrors.length > 0) {
                rlog.warn({ sha: ec.sha.slice(0, 8), llmErrors }, 'LLM call errors');
              }
            }
          }

          for (const r of pipelineResult.commits.slice(0, 3)) {
            rlog.debug({ sha: r.sha.slice(0, 8), hours: r.estimated_hours, method: r.method, type: r.analysis?.change_type }, 'Sample result');
          }

          const repoUsage = aggregateLlmUsage(pipelineResult.commits);
          accumulatedUsage.totalPromptTokens += repoUsage.totalPromptTokens;
          accumulatedUsage.totalCompletionTokens += repoUsage.totalCompletionTokens;
          accumulatedUsage.totalLlmCalls += repoUsage.totalLlmCalls;
          accumulatedUsage.totalDurationMs += repoUsage.totalDurationMs;
          rlog.info({
            promptTokens: repoUsage.totalPromptTokens,
            completionTokens: repoUsage.totalCompletionTokens,
            llmCalls: repoUsage.totalLlmCalls,
          }, 'Repo LLM usage');

          const commitMap = new Map(commits.map(c => [c.sha, c]));
          const analyses = pipelineResult.commits.map(result => {
            const commit = commitMap.get(result.sha);
            const analysis = mapToCommitAnalysis(result, commit, order.id, repoLabel, currentLlmModel);
            return options.isBenchmark ? { ...analysis, jobId } : analysis;
          });

          await saveCommitAnalyses(analyses);
          totalAnalyzed += analyses.length;
          rlog.info({ saved: analyses.length, totalAnalyzed }, 'Commit analyses saved');

          // Debit 1 credit per processed (non-cached) commit
          if (!await debitBatch(analyses.length, userId, jobId, order.id, skipBilling)) {
            throw new Error('CREDIT_EXHAUSTED');
          }

        } catch (err) {
          rlog.error({ err }, 'Pipeline failed');
          if (err instanceof PipelineError) {
            if (!options.isBenchmark) {
              await prisma.order.update({
                where: { id: order.id },
                data: { repositoriesFailed: { increment: 1 } },
              });
            }
            continue;
          }
          throw err;
        } finally {
          await cleanupCommitsFile(commitsFile);
        }

        if (!options.isBenchmark) {
          await prisma.order.update({
            where: { id: order.id },
            data: { repositoriesProcessed: { increment: 1 } },
          });
        }

        if (isCancelRequested(jobId)) {
          log.info({ i: i + 1, total: lastNExtracted.length }, 'Cancel requested — breaking LAST_N pipeline loop');
          break;
        }
      }
    }

    // 5. Guard: if nothing was analyzed, check if there are existing results (narrow/re-run scenario)
    if (totalAnalyzed === 0) {
      // Check if there are ANY successful CommitAnalysis for this order (narrow/re-run scenario)
      const existingCount = await prisma.commitAnalysis.count({
        where: { orderId: order.id, jobId: null, method: { not: 'error' } },
      });
      if (existingCount === 0) {
        throw new Error('No commits were analyzed — all repositories failed or had no commits in the selected period');
      }
      log.info({ existingCount }, 'No new commits to analyze — proceeding to metrics recalculation');
    }

    // 6. Calculate Ghost % metrics (skip for benchmarks — they don't recalculate order metrics)
    let metrics: { developerEmail: string; ghostPercent: number | null; commitCount: number; actualWorkDays: number }[] = [];
    if (options.isBenchmark) {
      await prisma.analysisJob.update({
        where: { id: jobId },
        data: { currentStep: 'finalizing', progress: 95 },
      });
    } else {
      // Clear old metrics + DailyEffort just before recalculation.
      // Deferred from step 2 so that cancellation during the repo loop preserves existing metrics.
      const deletedMetrics = await prisma.orderMetric.deleteMany({ where: { orderId: order.id } });
      const deletedEffort = await prisma.dailyEffort.deleteMany({ where: { orderId: order.id } });
      log.info({ deletedMetrics: deletedMetrics.count, deletedEffort: deletedEffort.count, totalAnalyzed }, 'Cleared old metrics — calculating Ghost % metrics');
      await prisma.analysisJob.update({
        where: { id: jobId },
        data: { currentStep: 'calculating', progress: 95 },
      });

      const ghostService = getGhostMetricsService();
      metrics = await ghostService.calculateAndSave(order.id, userId);
      log.info({ developerCount: metrics.length }, 'Ghost metrics calculated');
      for (const m of metrics) {
        log.info({ email: m.developerEmail, ghost: m.ghostPercent?.toFixed(1) ?? 'N/A', commits: m.commitCount, days: m.actualWorkDays }, 'Developer metric');
      }
    }

    // 7. Calculate actual cost and save LLM usage
    const actualCost = llmConfig.provider === 'openrouter'
      ? (accumulatedUsage.totalPromptTokens / 1e6 * llmConfig.openrouter.inputPrice +
         accumulatedUsage.totalCompletionTokens / 1e6 * llmConfig.openrouter.outputPrice)
      : 0;

    log.info({
      provider: llmConfig.provider,
      promptTokens: accumulatedUsage.totalPromptTokens,
      completionTokens: accumulatedUsage.totalCompletionTokens,
      llmCalls: accumulatedUsage.totalLlmCalls,
      costUsd: actualCost.toFixed(6),
    }, 'Total LLM usage');

    // 8. Persist pipeline log and mark completed with LLM usage stats
    const finalLog = getPipelineLogs(jobId);
    await prisma.analysisJob.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED', progress: 100, currentStep: 'done', completedAt: new Date(),
        llmProvider: llmConfig.provider,
        llmModel: llmConfig.provider === 'openrouter' ? llmConfig.openrouter.model : llmConfig.ollama.model,
        totalPromptTokens: accumulatedUsage.totalPromptTokens,
        totalCompletionTokens: accumulatedUsage.totalCompletionTokens,
        totalLlmCalls: accumulatedUsage.totalLlmCalls,
        totalCostUsd: actualCost,
        pipelineLog: finalLog.length > 0 ? finalLog as unknown as Prisma.InputJsonValue : undefined,
      },
    });

    if (!options.isBenchmark) {
      // Count actual in-scope commits (not totalAnalyzed which includes all processed this run)
      const scopeConfig: ScopeConfig = {
        analysisPeriodMode: order.analysisPeriodMode,
        analysisYears: order.analysisYears,
        analysisStartDate: order.analysisStartDate,
        analysisEndDate: order.analysisEndDate,
        analysisCommitLimit: order.analysisCommitLimit,
      };
      const inScopeCount = await countInScopeCommits(order.id, scopeConfig);
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'COMPLETED', analyzedAt: new Date(), totalCommits: inScopeCount },
      });
    }

    // Best-effort contributor projection — does not affect analysis status
    try {
      await projectContributorsFromOrder(orderId);
    } catch (projectionErr) {
      analysisLogger.error(
        { err: projectionErr, orderId },
        'Contributor projection failed (non-blocking)'
      );
    }

    // Release any unused reserved credits (idempotent)
    if (!skipBilling) {
      await releaseReservedCredits(userId, jobId, order.id);
    }

    log.info({ totalAnalyzed, cacheHits: totalCacheHits, developerCount: metrics.length }, 'Job COMPLETED');

    // Clear pipeline logs after delay (let frontend read final entries)
    setTimeout(() => clearPipelineLogs(jobId), 30_000);

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ err: error }, 'Job FAILED');

    // Release unused reserved credits on failure (idempotent)
    if (!skipBilling) {
      try {
        await releaseReservedCredits(userId, jobId, order.id);
      } catch (releaseErr) {
        billingLogger.error({ err: releaseErr, userId, jobId, orderId: order.id }, 'Failed to release credits on job failure');
      }
    }

    const failedLog = getPipelineLogs(jobId);
    await prisma.analysisJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED', error: message, completedAt: new Date(),
        pipelineLog: failedLog.length > 0 ? failedLog as unknown as Prisma.InputJsonValue : undefined,
      },
    });
    if (!options.isBenchmark) {
      // CREDIT_EXHAUSTED already set the order status — don't overwrite with FAILED
      if (message !== 'CREDIT_EXHAUSTED') {
        await prisma.order.update({
          where: { id: order.id },
          data: { status: 'FAILED', errorMessage: message },
        });
      }
    }
    setTimeout(() => clearPipelineLogs(jobId), 30_000);
    throw error;
  } finally {
    unregisterJob(jobId);
  }
}

// ==================== Helpers ====================

/** @internal Exported for testing only. */
export function mapToCommitAnalysis(
  result: PipelineCommitResult,
  commit: GitCommit | undefined,
  orderId: string,
  repoFullName: string,
  llmModel: string | null,
) {
  let confidence = 0.8;
  if (result.method.startsWith('FD')) confidence = 0.6;
  if (result.method === 'error') confidence = 0.1;
  if (result.method === 'root_commit_skip') confidence = 0.5;

  return {
    orderId,
    commitHash: result.sha,
    commitMessage: commit?.message ?? '',
    authorEmail: commit?.authorEmail ?? '',
    authorName: commit?.authorName ?? '',
    authorDate: commit?.authorDate ?? new Date(),
    repository: repoFullName,
    additions: commit?.additions ?? 0,
    deletions: commit?.deletions ?? 0,
    filesCount: commit?.filesCount ?? 0,
    effortHours: result.estimated_hours,
    category: result.analysis?.change_type ?? null,
    complexity: result.analysis?.cognitive_complexity ?? null,
    confidence,
    method: result.method ?? null,
    llmModel: result.method === 'root_commit_skip' || result.method === 'error'
      ? null
      : result.method?.startsWith('FD')
        ? (result.model || null)
        : llmModel,
  };
}

async function saveCommitAnalyses(
  analyses: ReturnType<typeof mapToCommitAnalysis>[],
): Promise<void> {
  for (let i = 0; i < analyses.length; i += BATCH_SIZE) {
    const batch = analyses.slice(i, i + BATCH_SIZE);
    await prisma.commitAnalysis.createMany({
      data: batch,
      skipDuplicates: true,
    });
  }
}

// ==================== Cross-Order Cache ====================

type CachedCommitRow = {
  commitHash: string;
  commitMessage: string;
  authorEmail: string;
  authorName: string;
  authorDate: Date;
  repository: string;
  additions: number;
  deletions: number;
  filesCount: number;
  effortHours: Prisma.Decimal;
  category: string | null;
  complexity: string | null;
  confidence: Prisma.Decimal;
  method: string | null;
  llmModel: string | null;
};

/**
 * Look up commits already analyzed in other orders for the same user.
 * Returns one result per SHA (most recently analyzed, non-error).
 */
async function lookupCachedCommits(
  shas: string[],
  currentOrderId: string,
  userId: string,
  repository: string,
  cacheMode: 'any' | 'model' | 'off',
  currentLlmModel: string,
): Promise<{ rows: CachedCommitRow[]; shaSet: Set<string> }> {
  if (cacheMode === 'off' || shas.length === 0) {
    return { rows: [], shaSet: new Set() };
  }

  const where: Prisma.CommitAnalysisWhereInput = {
    commitHash: { in: shas },
    repository,
    orderId: { not: currentOrderId },
    order: { userId, status: 'COMPLETED' },
    method: { not: 'error' },
    jobId: null,
  };

  if (cacheMode === 'model') {
    // Note: legacy rows (pre-cache feature) have llmModel=null and won't match.
    // First re-analysis after deployment populates llmModel; subsequent runs benefit from cache.
    where.llmModel = currentLlmModel;
  }

  const rows = await prisma.commitAnalysis.findMany({
    where,
    select: {
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
      method: true,
      llmModel: true,
    },
    orderBy: { analyzedAt: 'desc' },
  });

  // Deduplicate: keep one row per SHA (first = most recent due to DESC sort)
  const seen = new Set<string>();
  const deduped: CachedCommitRow[] = [];
  for (const row of rows) {
    if (!seen.has(row.commitHash)) {
      seen.add(row.commitHash);
      deduped.push(row);
    }
  }

  return { rows: deduped, shaSet: seen };
}

/**
 * Copy cached CommitAnalysis rows into the current order.
 */
async function copyCachedToOrder(
  rows: CachedCommitRow[],
  orderId: string,
  repository: string,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await prisma.commitAnalysis.createMany({
      data: batch.map(row => ({
        orderId,
        commitHash: row.commitHash,
        commitMessage: row.commitMessage,
        authorEmail: row.authorEmail,
        authorName: row.authorName,
        authorDate: row.authorDate,
        repository,  // always use current repoLabel, not cached value
        additions: row.additions,
        deletions: row.deletions,
        filesCount: row.filesCount,
        effortHours: row.effortHours,
        category: row.category,
        complexity: row.complexity,
        confidence: row.confidence,
        method: row.method,
        llmModel: row.llmModel,
      })),
      skipDuplicates: true,
    });
  }
}

function createProgressTracker() {
  let lastDbWrite = 0;
  return async function updateJobProgress(
    jobId: string,
    progress: number,
    currentCommit?: number,
    currentStep?: string,
  ): Promise<void> {
    // Always update in-memory immediately — progress endpoint reads this for RUNNING jobs
    updateJobMeta(jobId, {
      progress: Math.min(progress, 99),
      ...(currentCommit !== undefined && { currentCommit }),
      ...(currentStep !== undefined && { currentStep }),
    });

    // Throttle DB writes (fire-and-forget, may lag behind in-memory)
    const now = Date.now();
    if (now - lastDbWrite < PROGRESS_THROTTLE_MS) return;
    lastDbWrite = now;

    await prisma.analysisJob.update({
      where: { id: jobId },
      data: {
        progress: Math.min(progress, 99),
        ...(currentCommit !== undefined && { currentCommit }),
        ...(currentStep !== undefined && { currentStep }),
      },
    });
  };
}

async function extractCommitsForSelectedYears(
  repoPath: string,
  years: number[],
  excludedEmails: string[],
): Promise<GitCommit[]> {
  const uniqueYears = [...new Set(years)].sort((a, b) => b - a);
  const bySha = new Map<string, GitCommit>();

  for (const year of uniqueYears) {
    const since = `${year}-01-01T00:00:00Z`;
    const until = `${year + 1}-01-01T00:00:00Z`;
    const yearCommits = await gitExtractCommits(repoPath, {
      since,
      until,
      excludedEmails,
    });
    for (const commit of yearCommits) {
      bySha.set(commit.sha, commit);
    }
  }

  return [...bySha.values()].sort(
    (a, b) => b.authorDate.getTime() - a.authorDate.getTime(),
  );
}

function buildCommitScope(order: {
  analysisPeriodMode: string;
  analysisStartDate: Date | null;
  analysisEndDate: Date | null;
  analysisYears: number[];
  analysisCommitLimit: number | null;
}): { since?: string; until?: string; maxCount?: number; years?: number[] } {
  if (
    order.analysisPeriodMode === 'LAST_N_COMMITS' &&
    order.analysisCommitLimit
  ) {
    // Per-repo: extract generous buffer. Global truncation happens after merge.
    return { maxCount: order.analysisCommitLimit * 2 };
  }

  if (
    order.analysisPeriodMode === 'DATE_RANGE' &&
    order.analysisStartDate &&
    order.analysisEndDate
  ) {
    return {
      since: order.analysisStartDate.toISOString(),
      until: order.analysisEndDate.toISOString(),
    };
  }

  if (
    order.analysisPeriodMode === 'SELECTED_YEARS' &&
    order.analysisYears.length > 0
  ) {
    const parseYear = (rawYear: unknown): number => {
      if (typeof rawYear === 'number') return rawYear;
      if (typeof rawYear === 'string' && /^\d+$/.test(rawYear.trim())) {
        return Number.parseInt(rawYear.trim(), 10);
      }
      return Number.NaN;
    };

    const years = [...new Set(
      (order.analysisYears as unknown[])
        .map(parseYear)
        .filter((year) => Number.isInteger(year) && year > 0)
        .map((year) => Math.trunc(year))
    )]
      .sort((a, b) => a - b);
    if (years.length === 0) return {};

    const minYear = years[0]!;
    const maxYear = years[years.length - 1]!;
    return {
      years,
      since: `${minYear}-01-01T00:00:00Z`,
      until: `${maxYear + 1}-01-01T00:00:00Z`,
    };
  }

  return {};
}
