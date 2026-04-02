import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { apiResponse, apiError, requireAdmin, isErrorResponse } from '@/lib/api-utils';
import { requestCancel } from '@/lib/services/job-registry';

// GET /api/orders/[id]/benchmark/[jobId] — Get benchmark comparison data
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id, jobId } = await params;
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const benchmarkJob = await prisma.analysisJob.findFirst({
    where: { id: jobId, orderId: id, type: 'benchmark' },
  });
  if (!benchmarkJob) return apiError('Benchmark not found', 404);

  // Fetch original CommitAnalysis (jobId = null)
  const originals = await prisma.commitAnalysis.findMany({
    where: { orderId: id, jobId: null },
    select: {
      commitHash: true, commitMessage: true, authorName: true, authorEmail: true,
      effortHours: true, category: true, complexity: true, confidence: true,
      additions: true, deletions: true, filesCount: true, repository: true,
    },
  });

  // Fetch benchmark CommitAnalysis
  const benchmarks = await prisma.commitAnalysis.findMany({
    where: { orderId: id, jobId },
    select: {
      commitHash: true, effortHours: true, category: true, complexity: true,
      confidence: true,
    },
  });

  // Build comparison by commitHash
  const benchmarkMap = new Map(benchmarks.map(b => [b.commitHash, b]));
  let totalOriginal = 0;
  let totalBenchmark = 0;
  let sumAbsError = 0;
  let matchedCount = 0;
  let methodMatchCount = 0;
  const comparisons = [];

  for (const orig of originals) {
    const bench = benchmarkMap.get(orig.commitHash);
    if (!bench) continue;

    const origHours = Number(orig.effortHours);
    const benchHours = Number(bench.effortHours);
    const delta = benchHours - origHours;

    totalOriginal += origHours;
    totalBenchmark += benchHours;
    sumAbsError += Math.abs(delta);
    matchedCount++;

    if (orig.category === bench.category) methodMatchCount++;

    comparisons.push({
      commitHash: orig.commitHash,
      commitMessage: orig.commitMessage,
      authorName: orig.authorName,
      repository: orig.repository,
      additions: orig.additions,
      deletions: orig.deletions,
      filesCount: orig.filesCount,
      originalHours: origHours,
      benchmarkHours: benchHours,
      delta,
      absDelta: Math.abs(delta),
      originalCategory: orig.category,
      benchmarkCategory: bench.category,
    });
  }

  // Sort by absolute delta descending (biggest outliers first)
  comparisons.sort((a, b) => b.absDelta - a.absDelta);

  // Pearson correlation coefficient
  let correlation: number | null = null;
  if (matchedCount >= 3) {
    const origValues = comparisons.map(c => c.originalHours);
    const benchValues = comparisons.map(c => c.benchmarkHours);
    const n = origValues.length;
    const meanX = origValues.reduce((a, b) => a + b, 0) / n;
    const meanY = benchValues.reduce((a, b) => a + b, 0) / n;
    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = origValues[i]! - meanX;
      const dy = benchValues[i]! - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    const den = Math.sqrt(denX * denY);
    correlation = den === 0 ? 0 : num / den;
  }

  return apiResponse({
    benchmarkJob: {
      id: benchmarkJob.id,
      status: benchmarkJob.status,
      llmProvider: benchmarkJob.llmProvider,
      llmModel: benchmarkJob.llmModel,
      smallLlmProvider: benchmarkJob.smallLlmProvider,
      smallLlmModel: benchmarkJob.smallLlmModel,
      largeLlmProvider: benchmarkJob.largeLlmProvider,
      largeLlmModel: benchmarkJob.largeLlmModel,
      fdV3Enabled: benchmarkJob.fdV3Enabled,
      totalLlmCalls: benchmarkJob.totalLlmCalls,
      totalPromptTokens: benchmarkJob.totalPromptTokens,
      totalCompletionTokens: benchmarkJob.totalCompletionTokens,
      completedAt: benchmarkJob.completedAt,
    },
    summary: {
      matchedCommits: matchedCount,
      totalOriginalCommits: originals.length,
      totalBenchmarkCommits: benchmarks.length,
      mae: matchedCount > 0 ? sumAbsError / matchedCount : null,
      totalHoursOriginal: totalOriginal,
      totalHoursBenchmark: totalBenchmark,
      totalHoursDelta: totalBenchmark - totalOriginal,
      correlation,
      methodMatchPercent: matchedCount > 0 ? (methodMatchCount / matchedCount) * 100 : null,
    },
    comparisons,
  });
}

// DELETE /api/orders/[id]/benchmark/[jobId] — Delete a benchmark run
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> }
) {
  const { id, jobId } = await params;
  const session = await requireAdmin();
  if (isErrorResponse(session)) return session;

  const job = await prisma.analysisJob.findFirst({
    where: { id: jobId, orderId: id, type: 'benchmark' },
    select: { id: true, status: true, executionMode: true },
  });
  if (!job) return apiError('Benchmark not found', 404);

  const isLive = job.status === 'PENDING' || job.status === 'RUNNING';
  const isModal = job.executionMode === 'modal';

  if (isLive && isModal && job.status === 'RUNNING') {
    // Modal worker is already running and doesn't check for cancellation.
    // Deleting the row would orphan the worker and cause write errors.
    return apiError('Cannot delete a running Modal benchmark. Wait for it to finish or fail.', 409);
  }

  if (isLive) {
    if (isModal) {
      // PENDING modal job: mark CANCELLED so acquire_job() won't pick it up
      await prisma.analysisJob.update({
        where: { id: jobId },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });
    } else {
      // Local job: in-memory cancel signal kills the subprocess
      requestCancel(jobId);
    }
  }

  // Delete commit analyses for this benchmark run, then the job itself
  await prisma.$transaction([
    prisma.commitAnalysis.deleteMany({ where: { orderId: id, jobId } }),
    prisma.analysisJob.delete({ where: { id: jobId } }),
  ]);

  return apiResponse({ deleted: true });
}
