import { createHash } from 'crypto';
import { GHOST_NORM } from '@devghost/shared';

// ── Types ──────────────────────────────────────────────────────────

export type ClientEvent = {
  id: string;
  ts: number;
  tier: 'milestone' | 'major' | 'micro';
  category: 'phase' | 'commit' | 'repo' | 'stat';
  text: string;
  params: Record<string, string | number>;
  developerId?: string;
  effortHours?: number;
};

export type LeaderboardData = {
  developers: {
    id: string;
    name: string;
    totalHours: number;
    commitCount: number;
  }[];
  ghost: { totalHours: number };
  scopeWorkDays: number;
};

// ── Helpers ────────────────────────────────────────────────────────

export function hashEmail(email: string): string {
  return createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, 12);
}

function asPayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

let idCounter = 0;
function nextId(base: string): string {
  return `${base}-${++idCounter}`;
}

/** Reset counter — for deterministic tests. */
export function _resetIdCounter(): void {
  idCounter = 0;
}

// ── Internal codes that are never mapped ───────────────────────────

const INTERNAL_PREFIXES = [
  'HEARTBEAT_', 'WORKER_', 'TRIGGER_', 'ROLLBACK_',
  'POST_WATCHDOG_', 'MODAL_TRIGGER_', 'REPOS_VOLUME_',
  'LLM_SNAPSHOT_', 'BENCHMARK_PIN_',
];

function isInternalCode(code: string | null): boolean {
  if (!code) return true;
  return INTERNAL_PREFIXES.some(p => code.startsWith(p));
}

// ── Mappers per event code ─────────────────────────────────────────

type RawEvent = {
  id: string;
  createdAt: Date;
  level: string;
  phase: string | null;
  code: string | null;
  message: string;
  repo: string | null;
  sha: string | null;
  payload: unknown;
};

type DevNameAccumulator = Map<string, string>; // developerId → display name

function mapSingleEvent(
  event: RawEvent,
  devNames: DevNameAccumulator,
): ClientEvent[] {
  const code = event.code;
  const p = asPayload(event.payload);
  const ts = event.createdAt.getTime();
  const repo = event.repo ?? '';

  if (!code || isInternalCode(code)) return [];

  switch (code) {
    case 'REPO_CLONE_START':
    case 'REPO_CLONE_DONE':
      if (code === 'REPO_CLONE_START') {
        return [{
          id: nextId('ce'), ts, tier: 'milestone', category: 'repo',
          text: 'clientProgress.repoConnecting', params: { repo },
        }];
      }
      return []; // clone done is internal

    case 'REPO_EXTRACT_START':
      return [{
        id: nextId('ce'), ts, tier: 'major', category: 'phase',
        text: 'clientProgress.extractingHistory', params: { repo },
      }];

    case 'REPO_EXTRACT_DONE': {
      const commitCount = asNumber(p.commitCount) ?? 0;
      return [{
        id: nextId('ce'), ts, tier: 'major', category: 'stat',
        text: 'clientProgress.historyExtracted', params: { commitCount },
      }];
    }

    case 'LLM_EVAL_START': {
      const commitCount = asNumber(p.commitCount) ?? 0;
      return [{
        id: nextId('ce'), ts, tier: 'milestone', category: 'phase',
        text: 'clientProgress.aiAnalysisStarted', params: { commitCount },
      }];
    }

    case 'LLM_COMMIT_RESULT': {
      const result: ClientEvent[] = [];
      const subject = asString(p.subject) ?? 'commit';
      const email = asString(p.authorEmail);
      const devId = email ? hashEmail(email) : undefined;
      const hours = asNumber(p.estimatedHours);
      const filesCount = asNumber(p.filesCount);
      const additions = asNumber(p.additions) ?? 0;
      const deletions = asNumber(p.deletions) ?? 0;
      const lineCount = additions + deletions;
      const category = asString(p.category);

      if (devId && email) {
        const name = asString(p.authorName) ?? email.split('@')[0];
        devNames.set(devId, name);
      }

      const developerName = devId ? (devNames.get(devId) ?? 'Developer') : 'Developer';

      result.push({
        id: nextId('ce'), ts, tier: 'major', category: 'commit',
        text: 'clientProgress.commitAnalyzed',
        params: { subject, developerName },
        developerId: devId,
        effortHours: hours ?? undefined,
      });

      if (filesCount != null && filesCount > 0) {
        result.push({
          id: nextId('ce'), ts, tier: 'micro', category: 'stat',
          text: 'clientProgress.filesChanged', params: { fileCount: filesCount },
        });
      }

      if (lineCount > 0) {
        result.push({
          id: nextId('ce'), ts, tier: 'micro', category: 'stat',
          text: 'clientProgress.linesChanged', params: { lineCount },
        });
      }

      if (category) {
        result.push({
          id: nextId('ce'), ts, tier: 'micro', category: 'stat',
          text: 'clientProgress.changeType', params: { type: category },
        });
      }

      return result;
    }

    case 'REPO_FULLY_CACHED': {
      const count = asNumber(p.cachedCount) ?? asNumber(p.commitCount) ?? 0;
      return [{
        id: nextId('ce'), ts, tier: 'major', category: 'stat',
        text: 'clientProgress.cachedResultsFound', params: { count },
      }];
    }

    case 'CACHE_REUSED': {
      const count = asNumber(p.cacheHitCount) ?? 0;
      return [{
        id: nextId('ce'), ts, tier: 'micro', category: 'stat',
        text: 'clientProgress.cacheReused', params: { count },
      }];
    }

    case 'REPO_PROCESS_DONE': {
      const commitCount = asNumber(p.totalAnalyzed) ?? 0;
      const totalHours = asNumber(p.totalHours) ?? 0;
      return [{
        id: nextId('ce'), ts, tier: 'milestone', category: 'repo',
        text: 'clientProgress.repoCompleted',
        params: { repo, commitCount, totalHours },
      }];
    }

    case 'LLM_EVAL_DONE':
      return [{
        id: nextId('ce'), ts, tier: 'major', category: 'phase',
        text: 'clientProgress.aiAnalysisDone', params: {},
      }];

    case 'REPO_EMPTY_SCOPE':
      return [{
        id: nextId('ce'), ts, tier: 'major', category: 'repo',
        text: 'clientProgress.repoEmptyScope', params: { repo },
      }];

    default:
      // Skip unknown codes silently — no internal data leaks
      return [];
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Transform raw AnalysisJobEvents into safe client-facing events.
 * Also populates devNames map as a side-effect (used by buildLeaderboard).
 */
export function mapToClientEvents(
  rawEvents: RawEvent[],
  devNames: DevNameAccumulator = new Map(),
): ClientEvent[] {
  _resetIdCounter();
  return rawEvents.flatMap(e => mapSingleEvent(e, devNames));
}

/**
 * Build leaderboard from accumulated client events.
 * @param clientEvents - output of mapToClientEvents
 * @param devNames - map populated by mapToClientEvents
 * @param scopeWorkDays - working days in analysis scope
 * @param progressPercent - current analysis progress (0-100)
 */
export function buildLeaderboard(
  clientEvents: ClientEvent[],
  devNames: DevNameAccumulator,
  scopeWorkDays: number,
  progressPercent: number,
): LeaderboardData {
  const devMap = new Map<string, { totalHours: number; commitCount: number }>();

  for (const event of clientEvents) {
    if (!event.developerId || event.effortHours == null) continue;
    const existing = devMap.get(event.developerId);
    if (existing) {
      existing.totalHours += event.effortHours;
      existing.commitCount += 1;
    } else {
      devMap.set(event.developerId, {
        totalHours: event.effortHours,
        commitCount: 1,
      });
    }
  }

  const developers = Array.from(devMap.entries()).map(([id, data]) => ({
    id,
    name: devNames.get(id) ?? 'Developer',
    totalHours: Math.round(data.totalHours * 100) / 100,
    commitCount: data.commitCount,
  }));

  const ghostTotalHours = Math.round(
    GHOST_NORM * scopeWorkDays * (progressPercent / 100),
  );

  return {
    developers,
    ghost: { totalHours: ghostTotalHours },
    scopeWorkDays,
  };
}
