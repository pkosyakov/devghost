import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireUserSession, isErrorResponse, apiError } from '@/lib/api-utils';
import { checkRateLimit } from '@/lib/rate-limit';
import { analysisLogger } from '@/lib/logger';

/**
 * POST /api/demo
 * Creates a demo order with sample data (same as seed.ts logic)
 */
export async function POST(request: NextRequest) {
  try {
    const result = await requireUserSession();
    if (isErrorResponse(result)) return result;

    const rateLimited = await checkRateLimit(request, 'analysis', result.user.id);
    if (rateLimited) return rateLimited;

    const userId = result.user.id;

    // Delete previous demo orders
    await prisma.order.deleteMany({
      where: {
        userId,
        name: { startsWith: 'Demo Order' },
      },
    });

    // Create demo order
    const order = await prisma.order.create({
      data: {
        userId,
        name: 'Demo Order — DevGhost Analytics',
        status: 'COMPLETED',
        selectedRepos: [
          { url: 'https://github.com/example/frontend-app', name: 'frontend-app' },
          { url: 'https://github.com/example/backend-api', name: 'backend-api' },
        ],
        analyzedAt: new Date(),
        completedAt: new Date(),
      },
    });

    // Create demo developers settings
    await prisma.developerSettings.createMany({
      data: [
        { orderId: order.id, developerEmail: 'alice@example.com', share: 1.0, isExcluded: false },
        { orderId: order.id, developerEmail: 'bob@example.com', share: 0.8, isExcluded: false, shareAutoCalculated: false },
        { orderId: order.id, developerEmail: 'carol@example.com', share: 1.0, isExcluded: false },
        { orderId: order.id, developerEmail: 'dave@example.com', share: 1.0, isExcluded: false },
        { orderId: order.id, developerEmail: 'ci-bot@example.com', share: 1.0, isExcluded: true },
      ],
    });

    // Create sample commits
    const baseDate = new Date('2024-01-01');
    const commits = [
      { author: 'alice@example.com', name: 'Alice Chen', effort: 2.5, day: 0, msg: 'Add user authentication' },
      { author: 'bob@example.com', name: 'Bob Smith', effort: 3.2, day: 0, msg: 'Implement API endpoints' },
      { author: 'carol@example.com', name: 'Carol Johnson', effort: 4.1, day: 1, msg: 'Refactor database queries' },
      { author: 'alice@example.com', name: 'Alice Chen', effort: 1.8, day: 2, msg: 'Fix login bug' },
      { author: 'dave@example.com', name: 'Dave Wilson', effort: 2.0, day: 3, msg: 'Update dependencies' },
      { author: 'bob@example.com', name: 'Bob Smith', effort: 3.5, day: 4, msg: 'Add caching layer' },
      { author: 'carol@example.com', name: 'Carol Johnson', effort: 4.5, day: 5, msg: 'Optimize performance' },
      { author: 'alice@example.com', name: 'Alice Chen', effort: 2.2, day: 7, msg: 'Add unit tests' },
      { author: 'dave@example.com', name: 'Dave Wilson', effort: 1.5, day: 8, msg: 'Update README' },
      { author: 'ci-bot@example.com', name: 'CI Bot', effort: 0.1, day: 9, msg: 'Auto-format code' },
    ];

    await prisma.commitAnalysis.createMany({
      data: commits.map((c, i) => ({
        orderId: order.id,
        commitHash: `abc123${i.toString().padStart(3, '0')}`,
        commitMessage: c.msg,
        repository: i % 2 === 0 ? 'frontend-app' : 'backend-api',
        authorEmail: c.author,
        authorName: c.name,
        authorDate: new Date(baseDate.getTime() + c.day * 24 * 60 * 60 * 1000),
        effortHours: c.effort,
        filesCount: Math.floor(Math.random() * 10) + 1,
        additions: Math.floor(Math.random() * 200) + 10,
        deletions: Math.floor(Math.random() * 100),
        category: 'feature',
        complexity: 'moderate',
        confidence: 0.85,
      })),
    });

    // Create OrderMetrics
    await prisma.orderMetric.createMany({
      data: [
        {
          orderId: order.id,
          developerEmail: 'alice@example.com',
          developerName: 'Alice Chen',
          periodType: 'ALL_TIME',
          totalEffortHours: 198.5,
          workDays: 45,
          avgDailyEffort: 4.41,
          ghostPercentRaw: 110.3,
          ghostPercent: 110.3,
          share: 1.0,
          shareAutoCalculated: true,
          commitCount: 150,
        },
        {
          orderId: order.id,
          developerEmail: 'bob@example.com',
          developerName: 'Bob Smith',
          periodType: 'ALL_TIME',
          totalEffortHours: 128.0,
          workDays: 38,
          avgDailyEffort: 3.37,
          ghostPercentRaw: 84.2,
          ghostPercent: 105.3,
          share: 0.8,
          shareAutoCalculated: false,
          commitCount: 110,
        },
        {
          orderId: order.id,
          developerEmail: 'carol@example.com',
          developerName: 'Carol Johnson',
          periodType: 'ALL_TIME',
          totalEffortHours: 235.8,
          workDays: 50,
          avgDailyEffort: 4.72,
          ghostPercentRaw: 118.0,
          ghostPercent: 118.0,
          share: 1.0,
          shareAutoCalculated: true,
          commitCount: 180,
        },
        {
          orderId: order.id,
          developerEmail: 'dave@example.com',
          developerName: 'Dave Wilson',
          periodType: 'ALL_TIME',
          totalEffortHours: 72.0,
          workDays: 30,
          avgDailyEffort: 2.4,
          ghostPercentRaw: 60.0,
          ghostPercent: 60.0,
          share: 1.0,
          shareAutoCalculated: true,
          commitCount: 85,
        },
      ],
    });

    // Create completed job
    await prisma.analysisJob.create({
      data: {
        orderId: order.id,
        status: 'COMPLETED',
        progress: 100,
        currentStep: 'done',
        totalCommits: 10,
        currentCommit: 10,
        startedAt: new Date(Date.now() - 60000),
        completedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      data: { orderId: order.id },
    });
  } catch (error) {
    analysisLogger.error({ err: error }, 'Failed to create demo order');
    return apiError('Failed to create demo order', 500);
  }
}
