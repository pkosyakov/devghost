/**
 * In-memory store for pipeline per-commit processing logs.
 * Used to stream real-time status to the frontend during analysis.
 * Entries are ephemeral — cleared when job completes.
 *
 * Uses globalThis to survive Next.js HMR in dev mode (same pattern as db.ts).
 */

/**
 * In-memory pipeline log store for SSE progress streaming.
 *
 * IMPORTANT: This store only works within a single process/isolate.
 * In production, PIPELINE_MODE=modal uses database-based progress tracking.
 * SSE log streaming via this store is dev-only (PIPELINE_MODE=local).
 */

export interface PipelineLogEntry {
  ts: number;         // unix ms
  sha: string;        // short sha (8 chars)
  status: 'ok' | 'error' | 'skip';
  hours?: number;
  method?: string;
  type?: string;      // change_type
  durationMs?: number;
  error?: string;
  repo?: string;
}

// ==================== Job Metadata ====================

export interface JobMeta {
  totalCloneSizeKb: number;
  progress?: number;
  currentCommit?: number;
  currentStep?: string;
}

// Survive Next.js HMR — globalThis persists across module re-evaluations
const g = globalThis as unknown as {
  __pipelineLogStore?: Map<string, PipelineLogEntry[]>;
  __pipelineMetaStore?: Map<string, JobMeta>;
};

const store = g.__pipelineLogStore ?? new Map<string, PipelineLogEntry[]>();
const metaStore = g.__pipelineMetaStore ?? new Map<string, JobMeta>();

if (process.env.NODE_ENV !== 'production') {
  g.__pipelineLogStore = store;
  g.__pipelineMetaStore = metaStore;
}

const MAX_ENTRIES = 2000;

export function updateJobMeta(jobId: string, patch: Partial<JobMeta>): void {
  const existing = metaStore.get(jobId) ?? { totalCloneSizeKb: 0 };
  metaStore.set(jobId, { ...existing, ...patch });
}

export function getJobMeta(jobId: string): JobMeta | undefined {
  return metaStore.get(jobId);
}

export function appendPipelineLog(jobId: string, entry: PipelineLogEntry): void {
  let entries = store.get(jobId);
  if (!entries) {
    entries = [];
    store.set(jobId, entries);
  }
  entries.push(entry);
  // Cap to prevent memory leak on huge jobs
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }
}

/** Get log entries. If `since` provided, returns only entries after that timestamp. */
export function getPipelineLogs(jobId: string, since?: number): PipelineLogEntry[] {
  const entries = store.get(jobId);
  if (!entries) return [];
  if (since) {
    return entries.filter(e => e.ts > since);
  }
  return entries;
}

export function clearPipelineLogs(jobId: string): void {
  store.delete(jobId);
  metaStore.delete(jobId);
}
