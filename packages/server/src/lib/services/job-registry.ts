/**
 * In-memory job registry — tracks running pipeline PIDs and cancel flags.
 * Uses globalThis to survive Next.js HMR (same pattern as pipeline-log-store.ts).
 */
import { execFile } from 'child_process';
import { analysisLogger } from '@/lib/logger';

/**
 * In-memory job registry for tracking active analysis jobs.
 *
 * IMPORTANT: This store only works within a single process/isolate.
 * In production on Vercel (serverless), PIPELINE_MODE=modal is required —
 * it uses the database for job tracking, not this in-memory registry.
 * Cancel and progress features via this registry are dev-only (PIPELINE_MODE=local).
 */

const log = analysisLogger.child({ module: 'job-registry' });

interface JobEntry {
  pid: number | undefined;
  cancelRequested: boolean;
}

const g = globalThis as unknown as {
  __jobRegistry?: Map<string, JobEntry>;
};

const registry = g.__jobRegistry ?? new Map<string, JobEntry>();

if (process.env.NODE_ENV !== 'production') {
  g.__jobRegistry = registry;
}

export function registerJob(jobId: string, pid: number | undefined): void {
  registry.set(jobId, { pid, cancelRequested: false });
  log.debug({ jobId, pid }, 'Job registered');
}

export function unregisterJob(jobId: string): void {
  registry.delete(jobId);
  log.debug({ jobId }, 'Job unregistered');
}

export function isCancelRequested(jobId: string): boolean {
  return registry.get(jobId)?.cancelRequested === true;
}

export function requestCancel(jobId: string): void {
  const entry = registry.get(jobId);
  if (entry) {
    entry.cancelRequested = true;
    log.info({ jobId, pid: entry.pid }, 'Cancel requested — killing process tree');
    killProcessTree(entry.pid);
  } else {
    // Job not in registry (maybe already finished or not yet spawned) — create a flag entry
    // so the worker picks it up if it hasn't started the pipeline yet
    registry.set(jobId, { pid: undefined, cancelRequested: true });
    log.info({ jobId }, 'Cancel requested — job not in registry, flag set');
  }
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], (err) => {
      if (err) log.debug({ pid, err: err.message }, 'taskkill result');
    });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    setTimeout(() => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }, 5000);
  }
}
