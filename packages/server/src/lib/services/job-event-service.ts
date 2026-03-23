import type { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { analysisLogger } from '@/lib/logger';

type JobEventLevel = 'info' | 'warn' | 'error';

interface AppendJobEventInput {
  jobId: string;
  level?: JobEventLevel;
  phase?: string;
  code?: string;
  message: string;
  repo?: string | null;
  sha?: string | null;
  payload?: Prisma.InputJsonValue;
}

/**
 * Best-effort diagnostics event append.
 * Never throws to callers: telemetry failures must not break pipeline flow.
 */
export async function appendJobEvent(input: AppendJobEventInput): Promise<void> {
  try {
    await prisma.analysisJobEvent.create({
      data: {
        jobId: input.jobId,
        level: input.level ?? 'info',
        phase: input.phase ?? null,
        code: input.code ?? null,
        message: input.message,
        repo: input.repo ?? null,
        sha: input.sha ?? null,
        payload: input.payload,
      },
    });
  } catch (err) {
    analysisLogger.warn(
      { err, jobId: input.jobId, code: input.code, phase: input.phase },
      'Failed to append analysis job event',
    );
  }
}

