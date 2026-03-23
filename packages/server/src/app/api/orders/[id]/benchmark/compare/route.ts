import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { auth } from '@/lib/auth';

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await params;

  const order = await prisma.order.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  // Pagination
  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '0') || 0;
  const offset = parseInt(req.nextUrl.searchParams.get('offset') || '0') || 0;
  const requestedGtAuthor = (req.nextUrl.searchParams.get('gtAuthor') || '').trim();

  // 1. Fetch all jobs (original analysis + benchmarks)
  const jobs = await prisma.analysisJob.findMany({
    where: { orderId: id, status: { in: ['COMPLETED', 'FAILED'] } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, type: true, status: true, llmProvider: true, llmModel: true,
      createdAt: true, totalCostUsd: true, llmConfigFingerprint: true,
      llmConfigSnapshot: true,
    },
  });

  // 2. Fetch all commit analyses
  const allAnalyses = await prisma.commitAnalysis.findMany({
    where: { orderId: id },
    orderBy: { id: 'asc' },
    select: { commitHash: true, commitMessage: true, repository: true,
              additions: true, deletions: true, filesCount: true,
              effortHours: true, jobId: true, method: true },
  });

  // 3. Fetch ground truth
  const gtEntries = await prisma.groundTruth.findMany({
    where: { orderId: id },
    select: { commitHash: true, hours: true, author: true },
  });
  const gtAuthorCounts = new Map<string, number>();
  for (const entry of gtEntries) {
    gtAuthorCounts.set(entry.author, (gtAuthorCounts.get(entry.author) ?? 0) + 1);
  }
  const availableGtAuthors = Array.from(gtAuthorCounts.entries())
    .map(([author, commitCount]) => ({ author, commitCount }))
    .sort((a, b) => b.commitCount - a.commitCount || a.author.localeCompare(b.author));

  const resolvedGtAuthor =
    gtEntries.length === 0
      ? null
      : requestedGtAuthor && requestedGtAuthor !== 'consensus' && gtAuthorCounts.has(requestedGtAuthor)
        ? requestedGtAuthor
        : 'consensus';

  const gtMap = new Map<string, number>();
  if (resolvedGtAuthor === 'consensus') {
    const byCommit = new Map<string, number[]>();
    for (const entry of gtEntries) {
      const existing = byCommit.get(entry.commitHash) ?? [];
      existing.push(entry.hours);
      byCommit.set(entry.commitHash, existing);
    }
    for (const [commitHash, values] of byCommit.entries()) {
      gtMap.set(commitHash, median(values));
    }
  } else if (resolvedGtAuthor) {
    for (const entry of gtEntries) {
      if (entry.author === resolvedGtAuthor) {
        gtMap.set(entry.commitHash, entry.hours);
      }
    }
  }

  // 4. Build runs list with labels
  // Deduplicate analysis jobs — only the latest one becomes "Original"
  const analysisJobs = jobs.filter(j => j.type === 'analysis');
  const latestAnalysisId = analysisJobs.length > 0 ? analysisJobs[analysisJobs.length - 1]!.id : null;
  const filteredJobs = jobs.filter(j => j.type !== 'analysis' || j.id === latestAnalysisId);

  const modelCounts = new Map<string, number>();
  const runs = filteredJobs.map(job => {
    const isOriginal = job.type === 'analysis';
    const modelKey = `${job.llmProvider || '?'}_${job.llmModel || '?'}`;
    // Only count benchmark runs for numbering — Original gets its own label
    let count = 0;
    if (!isOriginal) {
      count = (modelCounts.get(modelKey) || 0) + 1;
      modelCounts.set(modelKey, count);
    }

    // llmConfigSnapshot stores full LlmConfig shape (see src/lib/llm-config.ts)
    // OpenRouter routing lives at snapshot.openrouter.{providerOrder,providerIgnore,...}
    const snap = job.llmConfigSnapshot as any;
    const orSnap = snap?.openrouter;
    const routingProfile = orSnap ? {
      order: orSnap.providerOrder || [],
      ignore: orSnap.providerIgnore || [],
      allowFallbacks: orSnap.allowFallbacks ?? true,
      requireParameters: orSnap.requireParameters ?? true,
    } : null;

    return {
      jobId: isOriginal ? null : job.id,
      logJobId: job.id,  // always the real AnalysisJob ID — for fetching pipeline logs
      label: isOriginal ? 'Original' : `${job.llmModel || '?'} #${count}`,
      provider: job.llmProvider || '?',
      model: job.llmModel || '?',
      createdAt: job.createdAt.toISOString(),
      configFingerprint: job.llmConfigFingerprint,
      routingProfile,
      costUsd: job.totalCostUsd ? Number(job.totalCostUsd) : null,
      promptRepeat: !!snap?.promptRepeat,
      effectiveContextLength: snap?.effectiveContextLength as number | null ?? null,
      status: job.status,
      totalHours: 0,
      mae: null as number | null,
      correlation: null as number | null,
      completedCommits: 0,
      totalCommits: 0,
      fdCount: 0,
    };
  });

  // 5. Build commits matrix
  const commitMap = new Map<string, {
    sha: string; message: string; repository: string;
    filesChanged: number; linesAdded: number; linesDeleted: number;
    estimates: Record<string, number>;
    methods: Record<string, string>;
  }>();

  for (const a of allAnalyses) {
    if (!commitMap.has(a.commitHash)) {
      commitMap.set(a.commitHash, {
        sha: a.commitHash,
        message: a.commitMessage,
        repository: a.repository,
        filesChanged: a.filesCount,
        linesAdded: a.additions,
        linesDeleted: a.deletions,
        estimates: {},
        methods: {},
      });
    }
    const key = a.jobId === null ? 'original' : a.jobId;
    commitMap.get(a.commitHash)!.estimates[key] = Number(a.effortHours);
    if (a.method) {
      commitMap.get(a.commitHash)!.methods[key] = a.method;
    }
  }

  let commits = Array.from(commitMap.values()).map(c => ({
    ...c,
    groundTruth: gtMap.get(c.sha) ?? null,
  }));

  // Apply pagination
  const totalCommitCount = commits.length;
  if (limit > 0) {
    commits = commits.slice(offset, offset + limit);
  }

  // 6. Compute per-run MAE and correlation
  for (const run of runs) {
    const key = run.jobId === null ? 'original' : run.jobId;
    const pairs: { est: number; gt: number }[] = [];
    let total = 0;
    let count = 0;

    for (const c of Array.from(commitMap.values())) {
      const est = c.estimates[key];
      if (est !== undefined) {
        count++;
        total += est;
        const method = c.methods[key];
        if (method && method.startsWith('FD')) {
          run.fdCount++;
        }
        const gt = gtMap.get(c.sha);
        if (gt !== undefined) {
          pairs.push({ est, gt });
        }
      }
    }

    run.totalHours = Math.round(total * 100) / 100;
    run.completedCommits = count;
    run.totalCommits = totalCommitCount;

    if (pairs.length >= 1) {
      run.mae = Math.round(pairs.reduce((s, p) => s + Math.abs(p.est - p.gt), 0) / pairs.length * 100) / 100;
    }
    if (pairs.length >= 3) {
      const meanEst = pairs.reduce((s, p) => s + p.est, 0) / pairs.length;
      const meanGt = pairs.reduce((s, p) => s + p.gt, 0) / pairs.length;
      let num = 0, denEst = 0, denGt = 0;
      for (const p of pairs) {
        num += (p.est - meanEst) * (p.gt - meanGt);
        denEst += (p.est - meanEst) ** 2;
        denGt += (p.gt - meanGt) ** 2;
      }
      const den = Math.sqrt(denEst * denGt);
      run.correlation = den > 0 ? Math.round(num / den * 1000) / 1000 : null;
    }
  }

  return NextResponse.json({
    runs,
    commits,
    groundTruthMeta: {
      mode: resolvedGtAuthor === null ? null : resolvedGtAuthor === 'consensus' ? 'consensus' : 'author',
      selectedAuthor: resolvedGtAuthor,
      availableAuthors: availableGtAuthors,
      requestedAuthor: requestedGtAuthor || null,
      fallbackToConsensus: !!requestedGtAuthor && requestedGtAuthor !== 'consensus' && resolvedGtAuthor === 'consensus',
    },
  });
}
