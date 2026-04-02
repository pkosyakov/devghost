# Client-Facing Analysis Progress Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the technical admin-only PROCESSING screen with an engaging client-facing UI featuring an adaptive drip-feed event stream, animated dashboard, and a live leaderboard bar race where developers compete against DevGhost.

**Architecture:** Three layers — (1) Modal worker enriches event payloads with author/file/line data, (2) server-side `client-event-mapper.ts` transforms raw events into safe, i18n-ready `ClientEvent[]` with leaderboard accumulation, (3) client-side `useDripFeed` hook buffers events and emits them with adaptive timing. The progress API uses role-based filtering in a single endpoint. Admin view is preserved unchanged with a toggle to preview client view.

**Tech Stack:** Python (Modal worker), TypeScript, Next.js API routes, React hooks, Tailwind CSS, vitest

**Spec:** `docs/superpowers/specs/2026-04-02-client-analysis-progress-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/modal/worker.py` | Enrich event payloads (author, files, lines, dates, totalHours) |
| `packages/server/src/lib/services/client-event-mapper.ts` | Raw events → ClientEvent[] + LeaderboardData |
| `packages/server/src/lib/services/__tests__/client-event-mapper.test.ts` | Mapper unit tests |
| `packages/server/src/app/api/orders/[id]/progress/route.ts` | Role-based response filtering |
| `packages/server/src/app/api/orders/[id]/progress/__tests__/route.test.ts` | Progress route test updates |
| `packages/server/src/hooks/use-drip-feed.ts` | Adaptive drip-feed state machine |
| `packages/server/src/hooks/__tests__/use-drip-feed.test.ts` | Drip-feed hook tests |
| `packages/server/src/components/client-analysis-progress.tsx` | Client progress UI (dashboard + feed + leaderboard) |
| `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx` | Page integration with admin toggle + state machine |
| `packages/server/messages/en.json` | English i18n keys |
| `packages/server/messages/ru.json` | Russian i18n keys |

---

### Task 1: Enrich Modal worker event payloads

**Files:**
- Modify: `packages/modal/worker.py:1394-1476` (`_emit_commit_live_results`)
- Modify: `packages/modal/worker.py:1204-1219` (`REPO_PROCESS_DONE` in `_process_single_repo`)
- Modify: `packages/modal/worker.py:520-527` and `567-574` (`REPO_EXTRACT_DONE`)

This task has no automated tests — worker.py is Python running in Modal, tested via integration. The enrichment adds fields from data already present in memory.

- [ ] **Step 1: Add author/file/line fields to `_emit_commit_live_results` payload**

In `packages/modal/worker.py`, inside `_emit_commit_live_results()`, after the existing payload dict (line ~1394), add the new fields:

```python
        payload = {
            "method": method,
            "estimatedHours": round(estimated_hours, 2) if estimated_hours is not None else None,
            "category": analysis.get("change_type"),
            "complexity": analysis.get("cognitive_complexity") or analysis.get("complexity"),
            "confidence": round(confidence, 3),
            "type": result.get("type"),
            "subject": str(commit.get("message") or "")[:140] or None,
            "llmCallCount": len(llm_calls),
            "durationMs": round(duration_ms, 1) if duration_ms is not None else None,
            # Client event mapper fields:
            "authorEmail": commit.get("author_email"),
            "authorName": commit.get("author_name"),
            "filesCount": commit.get("files_count"),
            "additions": commit.get("additions"),
            "deletions": commit.get("deletions"),
        }
```

- [ ] **Step 2: Accumulate totalHours in `_process_single_repo` and add to `REPO_PROCESS_DONE`**

In `_process_single_repo()`, after `saved_count = 0` (line ~1052), add a totalHours accumulator:

```python
    method_counts = {}
    error_samples = []
    saved_count = 0
    total_hours = 0.0
    commit_lookup = {c["sha"]: c for c in commits}
```

Inside the chunk result loop (after line ~1114), accumulate hours:

```python
        for result in chunk_results:
            method = result.get("method", "unknown")
            method_counts[method] = method_counts.get(method, 0) + 1
            # Accumulate effort hours for REPO_PROCESS_DONE
            est_h = result.get("estimated_hours")
            if isinstance(est_h, (int, float)) and est_h > 0:
                total_hours += est_h
            if method == "error" or result.get("error"):
```

Update the `REPO_PROCESS_DONE` event payload (line ~1214):

```python
    append_job_event(
        conn,
        job_id,
        "Repository processing completed",
        phase="repo",
        code="REPO_PROCESS_DONE",
        repo_name=repo_full_name,
        payload={
            "progress": progress_pct,
            "totalAnalyzed": total_analyzed,
            "totalHours": round(total_hours, 2),
            "durationSec": round(time.time() - repo_started, 2),
        },
    )
```

- [ ] **Step 3: Add date range to `REPO_EXTRACT_DONE` events**

There are two `REPO_EXTRACT_DONE` emit sites. For the adaptive-shallow path (line ~520):

```python
                append_job_event(
                    conn,
                    job_id,
                    "Commit extraction finished",
                    phase="extract",
                    code="REPO_EXTRACT_DONE",
                    repo_name=repo_full_name,
                    payload={
                        "commitCount": len(commits),
                        "durationSec": round(time.time() - extract_started, 2),
                        "adaptiveShallow": adaptive_meta,
                        "earliestDate": commits[-1]["author_date"] if commits else None,
                        "latestDate": commits[0]["author_date"] if commits else None,
                    },
                )
```

For the standard path (line ~567):

```python
                append_job_event(
                    conn,
                    job_id,
                    "Commit extraction finished",
                    phase="extract",
                    code="REPO_EXTRACT_DONE",
                    repo_name=repo_full_name,
                    payload={
                        "commitCount": len(commits),
                        "durationSec": round(time.time() - extract_started, 2),
                        **({"selectedYears": years} if years else {}),
                        "earliestDate": commits[-1]["author_date"] if commits else None,
                        "latestDate": commits[0]["author_date"] if commits else None,
                    },
                )
```

Note: commits are sorted by `author_date` descending (newest first), so `commits[0]` is latest and `commits[-1]` is earliest.

- [ ] **Step 4: Add commitCount to `REPO_FULLY_CACHED` payload**

In `_process_single_repo()`, find the `REPO_FULLY_CACHED` event (line ~1009). Replace the payload:

```python
    if not commits:
        append_job_event(
            conn,
            job_id,
            "Repository fully satisfied by cache (no LLM calls needed)",
            phase="cache",
            code="REPO_FULLY_CACHED",
            repo_name=repo_full_name,
            payload={
                "commitCount": len(all_shas),
                "durationSec": round(time.time() - repo_started, 2),
            },
        )
        return total_analyzed, total_cache_hits, total_commit_plan
```

`all_shas` is in scope — it holds the full set of SHAs before cache filtering.

- [ ] **Step 5: Commit**

```bash
git add packages/modal/worker.py
git commit -m "feat(worker): enrich event payloads for client progress screen

Add authorEmail, authorName, filesCount, additions, deletions to
LLM_COMMIT_RESULT. Add totalHours to REPO_PROCESS_DONE. Add
earliestDate/latestDate to REPO_EXTRACT_DONE. Add commitCount to
REPO_FULLY_CACHED."
```

---

### Task 2: Build client-event-mapper with tests

**Files:**
- Create: `packages/server/src/lib/services/client-event-mapper.ts`
- Create: `packages/server/src/lib/services/__tests__/client-event-mapper.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/server/src/lib/services/__tests__/client-event-mapper.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  mapToClientEvents,
  buildLeaderboard,
  type ClientEvent,
  type LeaderboardData,
} from '../client-event-mapper';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    createdAt: new Date('2026-04-02T10:00:00Z'),
    level: 'info',
    phase: 'llm',
    code: 'LLM_COMMIT_RESULT',
    message: 'Commit analysis result available',
    repo: 'owner/repo',
    sha: 'abc123',
    payload: {
      method: 'llm',
      estimatedHours: 2.5,
      subject: 'fix: login validation',
      category: 'bugfix',
      authorEmail: 'dev@example.com',
      authorName: 'Alice Dev',
      filesCount: 7,
      additions: 120,
      deletions: 30,
    },
    ...overrides,
  };
}

describe('mapToClientEvents', () => {
  it('expands LLM_COMMIT_RESULT into major + micro events', () => {
    const events = mapToClientEvents([makeEvent()]);
    expect(events.length).toBeGreaterThanOrEqual(3);

    const major = events.find(e => e.tier === 'major');
    expect(major).toBeDefined();
    expect(major!.text).toBe('clientProgress.commitAnalyzed');
    expect(major!.params.subject).toBe('fix: login validation');
    expect(major!.developerId).toBeDefined();
    expect(major!.effortHours).toBe(2.5);

    const filesMicro = events.find(
      e => e.tier === 'micro' && e.text === 'clientProgress.filesChanged',
    );
    expect(filesMicro).toBeDefined();
    expect(filesMicro!.params.fileCount).toBe(7);

    const linesMicro = events.find(
      e => e.tier === 'micro' && e.text === 'clientProgress.linesChanged',
    );
    expect(linesMicro).toBeDefined();
    expect(linesMicro!.params.lineCount).toBe(150);
  });

  it('maps REPO_CLONE_START to milestone', () => {
    const events = mapToClientEvents([
      makeEvent({
        code: 'REPO_CLONE_START',
        payload: {},
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe('milestone');
    expect(events[0].text).toBe('clientProgress.repoConnecting');
    expect(events[0].params.repo).toBe('owner/repo');
  });

  it('maps REPO_PROCESS_DONE to milestone with totalHours', () => {
    const events = mapToClientEvents([
      makeEvent({
        code: 'REPO_PROCESS_DONE',
        payload: { totalAnalyzed: 42, totalHours: 85.5 },
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].tier).toBe('milestone');
    expect(events[0].text).toBe('clientProgress.repoCompleted');
    expect(events[0].params.commitCount).toBe(42);
    expect(events[0].params.totalHours).toBe(85.5);
  });

  it('filters out internal event codes', () => {
    const events = mapToClientEvents([
      makeEvent({ code: 'HEARTBEAT_TOUCH_FAILED', payload: {} }),
      makeEvent({ code: 'WORKER_ACQUIRED', payload: {} }),
      makeEvent({ code: 'TRIGGER_CLAIM_CLEARED', payload: {} }),
    ]);
    expect(events).toHaveLength(0);
  });

  it('never includes sha in output', () => {
    const events = mapToClientEvents([makeEvent()]);
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain('abc123');
    }
  });

  it('developerId is a stable hash, not raw email', () => {
    const events = mapToClientEvents([makeEvent()]);
    const withDev = events.filter(e => e.developerId);
    expect(withDev.length).toBeGreaterThan(0);
    for (const e of withDev) {
      expect(e.developerId).not.toBe('dev@example.com');
      expect(e.developerId).not.toContain('@');
    }
  });
});

describe('buildLeaderboard', () => {
  it('accumulates hours per developer', () => {
    const events: ClientEvent[] = [
      {
        id: '1', ts: 1000, tier: 'major', category: 'commit',
        text: 'clientProgress.commitAnalyzed', params: { subject: 'a' },
        developerId: 'hash-alice', effortHours: 2.0,
      },
      {
        id: '2', ts: 2000, tier: 'major', category: 'commit',
        text: 'clientProgress.commitAnalyzed', params: { subject: 'b' },
        developerId: 'hash-alice', effortHours: 1.5,
      },
      {
        id: '3', ts: 3000, tier: 'major', category: 'commit',
        text: 'clientProgress.commitAnalyzed', params: { subject: 'c' },
        developerId: 'hash-bob', effortHours: 3.0,
      },
    ];
    const devNames = new Map([['hash-alice', 'Alice'], ['hash-bob', 'Bob']]);
    const lb = buildLeaderboard(events, devNames, 22, 50);

    expect(lb.developers).toHaveLength(2);
    const alice = lb.developers.find(d => d.id === 'hash-alice')!;
    expect(alice.totalHours).toBe(3.5);
    expect(alice.commitCount).toBe(2);
    expect(alice.name).toBe('Alice');

    const bob = lb.developers.find(d => d.id === 'hash-bob')!;
    expect(bob.totalHours).toBe(3.0);
    expect(bob.commitCount).toBe(1);
  });

  it('computes ghost hours proportional to progress', () => {
    const lb = buildLeaderboard([], new Map(), 20, 45);
    // GHOST_NORM (3.0) * 20 workDays * 45% progress / 100 = 27.0
    expect(lb.ghost.totalHours).toBe(27);
    expect(lb.scopeWorkDays).toBe(20);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test -- src/lib/services/__tests__/client-event-mapper.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the mapper**

Create `packages/server/src/lib/services/client-event-mapper.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests**

Run: `cd packages/server && pnpm test -- src/lib/services/__tests__/client-event-mapper.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/lib/services/client-event-mapper.ts packages/server/src/lib/services/__tests__/client-event-mapper.test.ts
git commit -m "feat: add client-event-mapper for safe progress events

Maps raw AnalysisJobEvents to ClientEvent[] with tier-based hierarchy.
Filters internal codes, hashes developer emails, expands LLM_COMMIT_RESULT
into 3-5 micro-facts. Builds leaderboard with ghost baseline."
```

---

### Task 3: Wire mapper into progress API with role-based filtering

**Files:**
- Modify: `packages/server/src/app/api/orders/[id]/progress/route.ts`
- Modify: `packages/server/src/app/api/orders/[id]/progress/__tests__/route.test.ts`

- [ ] **Step 1: Write failing test for non-admin response filtering**

Add to `packages/server/src/app/api/orders/[id]/progress/__tests__/route.test.ts`:

```typescript
// Add at top with other mocks:
const mockMapToClientEvents = vi.fn().mockReturnValue([]);
const mockHashEmail = vi.fn((email: string) => `h_${email}`);
const mockCommitAnalysisGroupBy = vi.fn().mockResolvedValue([]);
const mockOrderFindUnique = vi.fn().mockResolvedValue(null);

vi.mock('@/lib/services/client-event-mapper', () => ({
  mapToClientEvents: (...args: unknown[]) => mockMapToClientEvents(...args),
  hashEmail: (email: string) => mockHashEmail(email),
}));

// Extend the existing prisma mock to add groupBy and order lookup:
// In the prisma mock object, add:
//   commitAnalysis: { ...existing, groupBy: (...args) => mockCommitAnalysisGroupBy(...args) },
//   order: { findUnique: (...args) => mockOrderFindUnique(...args) },

// Add test:
describe('role-based response filtering', () => {
  it('non-admin response excludes internal fields and includes clientEvents', async () => {
    (requireUserSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: 'user-1', role: 'USER' },
    });
    mockJobFindFirst.mockResolvedValue(makeJob());
    mockEventFindMany.mockResolvedValue([]);
    mockGetPipelineLogs.mockReturnValue([]);
    mockGetJobMeta.mockReturnValue(null);
    mockEventFindFirst.mockResolvedValue(null);

    mockMapToClientEvents.mockReturnValue([
      { id: 'ce-1', ts: 1000, tier: 'major', category: 'commit',
        text: 'clientProgress.commitAnalyzed', params: { subject: 'test' } },
    ]);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();
    const data = json.data;

    // Must include client events
    expect(data.clientEvents).toHaveLength(1);
    expect(data.leaderboard).toBeDefined();

    // Must NOT include internal fields
    expect(data.events).toBeUndefined();
    expect(data.log).toBeUndefined();
    expect(data.modalCallId).toBeUndefined();
    expect(data.heartbeatAt).toBeUndefined();
    expect(data.llmProvider).toBeUndefined();
    expect(data.llmModel).toBeUndefined();
    expect(data.llmConcurrency).toBeUndefined();
    expect(data.totalPromptTokens).toBeUndefined();
    expect(data.totalCostUsd).toBeUndefined();
    expect(data.retryCount).toBeUndefined();
    expect(data.executionMode).toBeUndefined();
    expect(data.cloneSizeMb).toBeUndefined();
  });

  it('admin response includes both internal fields and clientEvents', async () => {
    (requireUserSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: 'admin-1', role: 'ADMIN' },
    });
    mockJobFindFirst.mockResolvedValue(makeJob());
    mockEventFindMany.mockResolvedValue([]);
    mockGetPipelineLogs.mockReturnValue([]);
    mockGetJobMeta.mockReturnValue(null);
    mockEventFindFirst.mockResolvedValue(null);

    const res = await GET(makeRequest(), { params: Promise.resolve({ id: 'order-1' }) });
    const json = await res.json();
    const data = json.data;

    // Admin gets both
    expect(data.clientEvents).toBeDefined();
    expect(data.leaderboard).toBeDefined();
    expect(data.events).toBeDefined();
    expect(data.log).toBeDefined();
    expect(data.llmProvider).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test -- src/app/api/orders/\\[id\\]/progress/__tests__/route.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement role-based filtering in progress route**

Modify `packages/server/src/app/api/orders/[id]/progress/route.ts`. Add imports at top:

```typescript
import { mapToClientEvents, hashEmail } from '@/lib/services/client-event-mapper';
import { GHOST_NORM } from '@devghost/shared';
```

Before the `return NextResponse.json(...)` at the end of the GET handler, add mapper call and build the role-based response:

```typescript
  // Map events to client-safe format (for all roles)
  const devNames = new Map<string, string>();
  const clientEvents = mapToClientEvents(
    events.map(event => ({
      id: event.id.toString(),
      createdAt: event.createdAt,
      level: event.level,
      phase: event.phase,
      code: event.code,
      message: event.message,
      repo: event.repo,
      sha: event.sha,
      payload: event.payload,
    })),
    devNames,
  );

  // ── Cumulative leaderboard from CommitAnalysis (always accurate) ──
  // Queried from DB so it's independent of sinceEventId pagination.
  const devAggRows = await prisma.commitAnalysis.groupBy({
    by: ['authorEmail', 'authorName'],
    where: {
      orderId: id,
      method: { not: 'error' },
    },
    _sum: { estimatedHours: true },
    _count: { _all: true },
  });

  const isAdmin = session.user.role === 'ADMIN';

  const leaderboardDevs = devAggRows.map(row => {
    const devId = hashEmail(row.authorEmail);
    return {
      id: devId,
      name: isAdmin ? row.authorName : (devNames.get(devId) ?? row.authorName.split(' ')[0]),
      totalHours: Math.round((row._sum.estimatedHours?.toNumber() ?? 0) * 100) / 100,
      commitCount: row._count._all,
    };
  });

  // ── Scope work days for ghost baseline ──
  const scopeWorkDays = await computeScopeWorkDays(id, job.id);

  const ghostTotalHours = Math.round(
    GHOST_NORM * scopeWorkDays * (effectiveProgress / 100),
  );

  const leaderboard = {
    developers: leaderboardDevs,
    ghost: { totalHours: ghostTotalHours },
    scopeWorkDays,
  };

  if (!isAdmin) {
    // Sanitize error message for non-admin
    const sanitizedError = job.error
      ? (job.error.toLowerCase().includes('clone') || job.error.toLowerCase().includes('repository')
        ? 'Repository access issue. Please check permissions and try again.'
        : job.error.toLowerCase().includes('quota') || job.error.toLowerCase().includes('rate')
          ? 'Analysis service temporarily unavailable. Please try again later.'
          : 'Analysis encountered an issue. Please try again.')
      : null;

    return NextResponse.json(
      {
        success: true,
        data: {
          jobId: job.id,
          status: job.status,
          progress: effectiveProgress,
          currentStep: (isLive ? meta?.currentStep : undefined) ?? job.currentStep,
          currentCommit: effectiveCurrentCommit,
          totalCommits: effectiveTotalCommits,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          error: sanitizedError,
          isPaused,
          pauseReason: isPaused ? 'EXTERNAL_QUOTA' : null,
          isRetrying: job.status === 'FAILED_RETRYABLE' && job.retryCount < job.maxRetries,
          currentRepoName: job.order.currentRepoName,
          clientEvents,
          eventCursor,
          leaderboard,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Admin: full response + client data
  return NextResponse.json(
    {
      success: true,
      data: {
        // ... keep all existing admin fields exactly as they are now ...
        jobId: job.id,
        type: job.type ?? 'analysis',
        status: job.status,
        progress: effectiveProgress,
        currentStep: (isLive ? meta?.currentStep : undefined) ?? job.currentStep,
        currentCommit: effectiveCurrentCommit,
        totalCommits: effectiveTotalCommits,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        error: job.error,
        llmProvider: job.llmProvider,
        llmModel: job.llmModel,
        totalPromptTokens: job.totalPromptTokens,
        totalCompletionTokens: job.totalCompletionTokens,
        totalLlmCalls: job.totalLlmCalls,
        totalCostUsd: job.totalCostUsd ? Number(job.totalCostUsd) : null,
        cloneSizeMb,
        llmConcurrency,
        fdLlmConcurrency,
        executionMode: job.executionMode,
        modalCallId: job.modalCallId,
        heartbeatAt: job.heartbeatAt,
        updatedAt: job.updatedAt,
        createdAt: job.createdAt,
        retryCount: job.retryCount,
        maxRetries: job.maxRetries,
        failureClass,
        isPaused,
        pauseReason: isPaused ? 'EXTERNAL_QUOTA' : null,
        currentRepoName: job.order.currentRepoName,
        log: logEntries,
        events: events.map((event) => ({
          id: event.id.toString(),
          createdAt: event.createdAt,
          level: event.level,
          phase: event.phase,
          code: event.code,
          message: event.message,
          repo: event.repo,
          sha: event.sha,
          payload: event.payload,
        })),
        eventCursor,
        // New: client data for admin preview
        clientEvents,
        leaderboard,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
```

Add the `computeScopeWorkDays` helper above the GET handler:

```typescript
/** Count weekdays in analysis scope. For LAST_N, aggregates ALL extract events. */
async function computeScopeWorkDays(orderId: string, jobId: string): Promise<number> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      analysisPeriodMode: true,
      analysisStartDate: true,
      analysisEndDate: true,
      availableStartDate: true,
      availableEndDate: true,
    },
  });
  if (!order) return 0;

  let startDate: Date | null = null;
  let endDate: Date | null = null;

  if (order.analysisPeriodMode === 'DATE_RANGE') {
    startDate = order.analysisStartDate;
    endDate = order.analysisEndDate;
  } else if (order.analysisPeriodMode === 'LAST_N_COMMITS') {
    // Aggregate ALL REPO_EXTRACT_DONE events — min(earliest), max(latest)
    const extractEvents = await prisma.analysisJobEvent.findMany({
      where: { jobId, code: 'REPO_EXTRACT_DONE' },
      select: { payload: true },
    });
    for (const evt of extractEvents) {
      const ep = asPayload(evt.payload);
      const earliest = ep.earliestDate ? new Date(ep.earliestDate as string) : null;
      const latest = ep.latestDate ? new Date(ep.latestDate as string) : null;
      if (earliest && (!startDate || earliest < startDate)) startDate = earliest;
      if (latest && (!endDate || latest > endDate)) endDate = latest;
    }
  } else {
    startDate = order.availableStartDate;
    endDate = order.availableEndDate;
  }

  if (!startDate || !endDate) return 0;

  let count = 0;
  const d = new Date(startDate);
  while (d <= endDate) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}
```

Add the `asPayload` helper at the top of the file (or import from mapper):

```typescript
function asPayload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/server && pnpm test -- src/app/api/orders/\\[id\\]/progress/__tests__/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/app/api/orders/[id]/progress/route.ts packages/server/src/app/api/orders/[id]/progress/__tests__/route.test.ts
git commit -m "feat(progress): role-based response filtering with client events

Non-admin users receive filtered response with clientEvents and
leaderboard instead of raw events, pipeline log, and internal fields.
Admin response includes both for toggle preview."
```

---

### Task 4: Add i18n keys for client progress events

**Files:**
- Modify: `packages/server/messages/en.json`
- Modify: `packages/server/messages/ru.json`

- [ ] **Step 1: Add English i18n keys**

Add a new `clientProgress` section inside the `orders` namespace in `packages/server/messages/en.json`, after the existing `detail` section:

```json
    "clientProgress": {
      "repoConnecting": "Connecting to repository {repo}",
      "extractingHistory": "Extracting commit history from {repo}",
      "historyExtracted": "Found {commitCount} commits to analyze",
      "aiAnalysisStarted": "Starting AI analysis of {commitCount} commits",
      "aiAnalysisDone": "AI analysis phase complete",
      "commitAnalyzed": "Analyzing: {subject}",
      "filesChanged": "{fileCount} files changed",
      "linesChanged": "{lineCount} lines of code",
      "changeType": "Type: {type}",
      "cachedResultsFound": "Found {count} cached results",
      "cacheReused": "Reused {count} cached analyses",
      "repoCompleted": "Repository {repo} complete — {commitCount} commits, {totalHours}h effort",
      "repoEmptyScope": "No commits in selected scope for {repo}",
      "analysisComplete": "Analysis complete!",
      "analysisFailed": "Analysis encountered an issue",
      "analysisCancelled": "Analysis was cancelled",
      "retryingAutomatically": "Temporary issue — retrying automatically...",
      "finalizingResults": "Finalizing results...",
      "pausedBanner": "Analysis paused — waiting for resources. Progress preserved.",
      "dashboardPhaseConnecting": "Connecting to repositories",
      "dashboardPhaseExtracting": "Extracting commit history",
      "dashboardPhaseAnalyzing": "AI commit analysis",
      "dashboardPhaseFinalizing": "Finalizing results",
      "leaderboardTitle": "Developer Leaderboard",
      "ghostLabel": "DevGhost — the norm",
      "hoursUnit": "{hours}h",
      "commitsUnit": "{count} commits",
      "adminViewToggle": "Admin View",
      "clientViewToggle": "Client View",
      "tryAgain": "Try Again",
      "startNewAnalysis": "Start New Analysis",
      "repositoryAccessIssue": "Repository access issue. Please check permissions and try again.",
      "serviceTemporarilyUnavailable": "Analysis service temporarily unavailable. Please try again later.",
      "genericError": "Analysis encountered an issue. Please try again."
    }
```

- [ ] **Step 2: Add Russian i18n keys**

Add the same section to `packages/server/messages/ru.json`:

```json
    "clientProgress": {
      "repoConnecting": "Подключение к репозиторию {repo}",
      "extractingHistory": "Извлечение истории коммитов из {repo}",
      "historyExtracted": "Найдено {commitCount} коммитов для анализа",
      "aiAnalysisStarted": "Запуск AI-анализа {commitCount} коммитов",
      "aiAnalysisDone": "Фаза AI-анализа завершена",
      "commitAnalyzed": "Анализируем: {subject}",
      "filesChanged": "{fileCount} файлов изменено",
      "linesChanged": "{lineCount} строк кода",
      "changeType": "Тип: {type}",
      "cachedResultsFound": "Найдено {count} кэшированных результатов",
      "cacheReused": "Использовано {count} кэшированных анализов",
      "repoCompleted": "Репозиторий {repo} обработан — {commitCount} коммитов, {totalHours}ч",
      "repoEmptyScope": "Нет коммитов в выбранном периоде для {repo}",
      "analysisComplete": "Анализ завершён!",
      "analysisFailed": "При анализе возникла проблема",
      "analysisCancelled": "Анализ был отменён",
      "retryingAutomatically": "Временная проблема — автоматическая повторная попытка...",
      "finalizingResults": "Подготовка результатов...",
      "pausedBanner": "Анализ приостановлен — ожидание ресурсов. Прогресс сохранён.",
      "dashboardPhaseConnecting": "Подключение к репозиториям",
      "dashboardPhaseExtracting": "Извлечение истории коммитов",
      "dashboardPhaseAnalyzing": "AI-анализ коммитов",
      "dashboardPhaseFinalizing": "Подготовка результатов",
      "leaderboardTitle": "Рейтинг разработчиков",
      "ghostLabel": "DevGhost — норма",
      "hoursUnit": "{hours}ч",
      "commitsUnit": "{count} коммитов",
      "adminViewToggle": "Режим админа",
      "clientViewToggle": "Режим клиента",
      "tryAgain": "Попробовать снова",
      "startNewAnalysis": "Начать новый анализ",
      "repositoryAccessIssue": "Проблема с доступом к репозиторию. Проверьте права и попробуйте снова.",
      "serviceTemporarilyUnavailable": "Сервис анализа временно недоступен. Попробуйте позже.",
      "genericError": "При анализе возникла проблема. Попробуйте снова."
    }
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/messages/en.json packages/server/messages/ru.json
git commit -m "feat(i18n): add client progress screen translations (en + ru)"
```

---

### Task 5: Build `useDripFeed` hook with tests

**Files:**
- Create: `packages/server/src/hooks/use-drip-feed.ts`
- Create: `packages/server/src/hooks/__tests__/use-drip-feed.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/server/src/hooks/__tests__/use-drip-feed.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDripFeed } from '../use-drip-feed';
import type { ClientEvent } from '@/lib/services/client-event-mapper';
import type { LeaderboardData } from '@/lib/services/client-event-mapper';

function makeClientEvent(overrides: Partial<ClientEvent> = {}): ClientEvent {
  return {
    id: `ce-${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    tier: 'major',
    category: 'commit',
    text: 'clientProgress.commitAnalyzed',
    params: { subject: 'test commit' },
    ...overrides,
  };
}

const emptyLeaderboard: LeaderboardData = {
  developers: [],
  ghost: { totalHours: 0 },
  scopeWorkDays: 0,
};

describe('useDripFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with empty visible events', () => {
    const { result } = renderHook(() =>
      useDripFeed({
        rawEvents: [],
        rawLeaderboard: emptyLeaderboard,
        pollIntervalMs: 1000,
        jobStatus: 'RUNNING',
      }),
    );
    expect(result.current.visibleEvents).toEqual([]);
    expect(result.current.isDraining).toBe(false);
    expect(result.current.isDrained).toBe(false);
  });

  it('drips events one by one over time', () => {
    const events = [
      makeClientEvent({ tier: 'major' }),
      makeClientEvent({ tier: 'micro' }),
      makeClientEvent({ tier: 'micro' }),
    ];
    const { result } = renderHook(() =>
      useDripFeed({
        rawEvents: events,
        rawLeaderboard: emptyLeaderboard,
        pollIntervalMs: 1000,
        jobStatus: 'RUNNING',
      }),
    );

    // Initially no events visible
    expect(result.current.visibleEvents).toHaveLength(0);

    // Advance time — events should appear one by one
    act(() => { vi.advanceTimersByTime(500); });
    expect(result.current.visibleEvents.length).toBeGreaterThan(0);
    expect(result.current.visibleEvents.length).toBeLessThanOrEqual(events.length);
  });

  it('sets isDraining when jobStatus becomes a terminal state', () => {
    const events = [
      makeClientEvent(),
      makeClientEvent(),
      makeClientEvent(),
      makeClientEvent(),
      makeClientEvent(),
    ];
    const { result, rerender } = renderHook(
      ({ status }) =>
        useDripFeed({
          rawEvents: events,
          rawLeaderboard: emptyLeaderboard,
          pollIntervalMs: 1000,
          jobStatus: status,
        }),
      { initialProps: { status: 'RUNNING' } },
    );

    // Switch to LLM_COMPLETE (terminal job status)
    rerender({ status: 'LLM_COMPLETE' });
    expect(result.current.isDraining).toBe(true);

    // Advance time to drain
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.isDrained).toBe(true);
  });

  it('updates counters from micro events', () => {
    const events = [
      makeClientEvent({
        tier: 'major', text: 'clientProgress.commitAnalyzed',
        developerId: 'h1', effortHours: 2.0,
      }),
      makeClientEvent({
        tier: 'micro', text: 'clientProgress.filesChanged',
        params: { fileCount: 5 },
      }),
      makeClientEvent({
        tier: 'micro', text: 'clientProgress.linesChanged',
        params: { lineCount: 120 },
      }),
    ];
    const { result } = renderHook(() =>
      useDripFeed({
        rawEvents: events,
        rawLeaderboard: emptyLeaderboard,
        pollIntervalMs: 1000,
        jobStatus: 'RUNNING',
      }),
    );

    // Drain all events
    act(() => { vi.advanceTimersByTime(5000); });
    expect(result.current.counters.commits).toBe(1);
    expect(result.current.counters.files).toBe(5);
    expect(result.current.counters.lines).toBe(120);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/server && pnpm test -- src/hooks/__tests__/use-drip-feed.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the hook**

Create `packages/server/src/hooks/use-drip-feed.ts`:

```typescript
'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import type { ClientEvent, LeaderboardData } from '@/lib/services/client-event-mapper';

// ── Base delays per tier (ms) ──────────────────────────────────────
const BASE_DELAY: Record<string, [number, number]> = {
  milestone: [400, 600],
  major: [150, 300],
  micro: [30, 60],
};

function baseDelayFor(tier: string): number {
  const [min, max] = BASE_DELAY[tier] ?? BASE_DELAY.major;
  return min + Math.random() * (max - min);
}

// ── Terminal job statuses that trigger draining ─────────────────────
const DRAIN_STATUSES = new Set([
  'COMPLETED', 'LLM_COMPLETE', 'FAILED', 'FAILED_FATAL', 'FAILED_RETRYABLE', 'CANCELLED',
]);

interface UseDripFeedOpts {
  rawEvents: ClientEvent[];
  rawLeaderboard: LeaderboardData;
  pollIntervalMs: number;
  jobStatus: string;  // job-level status (RUNNING, COMPLETED, FAILED_FATAL, etc.)
}

interface UseDripFeedResult {
  visibleEvents: ClientEvent[];
  counters: { commits: number; files: number; lines: number };
  leaderboard: LeaderboardData;
  isDraining: boolean;
  isDrained: boolean;
}

export function useDripFeed(opts: UseDripFeedOpts): UseDripFeedResult {
  const { rawEvents, rawLeaderboard, pollIntervalMs, jobStatus } = opts;

  const [visibleEvents, setVisibleEvents] = useState<ClientEvent[]>([]);
  const [counters, setCounters] = useState({ commits: 0, files: 0, lines: 0 });
  const [isDraining, setIsDraining] = useState(false);
  const [isDrained, setIsDrained] = useState(false);

  // Per-event leaderboard accumulation (not snapshot replacement)
  const dripDevMapRef = useRef(new Map<string, { name: string; totalHours: number; commitCount: number }>());
  const drippedCommitsRef = useRef(0);
  const [dripLeaderboard, setDripLeaderboard] = useState<LeaderboardData>({
    developers: [], ghost: { totalHours: 0 }, scopeWorkDays: 0,
  });

  // Keep latest raw leaderboard for ghost proportional calculation and final snap
  const rawLeaderboardRef = useRef(rawLeaderboard);
  useEffect(() => {
    rawLeaderboardRef.current = rawLeaderboard;
  }, [rawLeaderboard]);

  const queueRef = useRef<ClientEvent[]>([]);
  const seenIdsRef = useRef(new Set<string>());
  const speedRef = useRef(1.0);
  const targetSpeedRef = useRef(1.0);
  const batchSizesRef = useRef<number[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Enqueue new events from rawEvents, deduplicating by id
  useEffect(() => {
    let newCount = 0;
    for (const event of rawEvents) {
      if (!seenIdsRef.current.has(event.id)) {
        seenIdsRef.current.add(event.id);
        queueRef.current.push(event);
        newCount++;
      }
    }
    if (newCount > 0) {
      const sizes = batchSizesRef.current;
      sizes.push(newCount);
      if (sizes.length > 5) sizes.shift();
    }
  }, [rawEvents]);

  // Detect drain trigger (uses job status, NOT order status)
  useEffect(() => {
    if (DRAIN_STATUSES.has(jobStatus) && !isDraining && !isDrained) {
      setIsDraining(true);
      targetSpeedRef.current = 5.0; // fast-forward
    }
  }, [jobStatus, isDraining, isDrained]);

  // Compute adaptive pressure
  const getExpectedBatchSize = useCallback(() => {
    const sizes = batchSizesRef.current;
    if (sizes.length === 0) return 10;
    return sizes.reduce((a, b) => a + b, 0) / sizes.length;
  }, []);

  // Recompute dripLeaderboard from internal dev map + proportional ghost
  const emitLeaderboardUpdate = useCallback(() => {
    const raw = rawLeaderboardRef.current;
    const devMap = dripDevMapRef.current;
    const developers = Array.from(devMap.entries()).map(([id, d]) => ({
      id,
      name: d.name,
      totalHours: Math.round(d.totalHours * 100) / 100,
      commitCount: d.commitCount,
    }));

    // Ghost proportional to drip progress: fraction of dripped dev hours vs raw total
    const rawDevTotal = raw.developers.reduce((s, d) => s + d.totalHours, 0);
    const dripDevTotal = developers.reduce((s, d) => s + d.totalHours, 0);
    const fraction = rawDevTotal > 0 ? Math.min(1, dripDevTotal / rawDevTotal) : 0;
    const ghostHours = Math.round(raw.ghost.totalHours * fraction * 100) / 100;

    setDripLeaderboard({
      developers,
      ghost: { totalHours: ghostHours },
      scopeWorkDays: raw.scopeWorkDays,
    });
  }, []);

  // On drain complete, snap to raw leaderboard to close rounding gaps
  useEffect(() => {
    if (isDrained) {
      setDripLeaderboard(rawLeaderboardRef.current);
    }
  }, [isDrained]);

  // Main drip loop
  useEffect(() => {
    function tick() {
      const queue = queueRef.current;

      if (queue.length === 0) {
        if (isDraining) {
          setIsDrained(true);
          return;
        }
        // Schedule next check
        timerRef.current = setTimeout(tick, 50);
        return;
      }

      // Adaptive pressure
      const expected = getExpectedBatchSize();
      const pressure = queue.length / expected;
      if (pressure < 0.5) {
        targetSpeedRef.current = isDraining ? 5.0 : 0.75;
      } else if (pressure <= 1.5) {
        targetSpeedRef.current = isDraining ? 5.0 : 1.0;
      } else if (pressure <= 3.0) {
        targetSpeedRef.current = isDraining ? 5.0 : Math.min(2.0, 1.0 + (pressure - 1.5));
      } else {
        targetSpeedRef.current = isDraining ? 5.0 : 3.0;
      }

      // Lerp speed
      speedRef.current += (targetSpeedRef.current - speedRef.current) * 0.1;

      // Emit next event
      const event = queue.shift()!;
      setVisibleEvents(prev => [...prev, event]);

      // Update counters
      if (event.text === 'clientProgress.commitAnalyzed') {
        setCounters(prev => ({ ...prev, commits: prev.commits + 1 }));
      }
      if (event.text === 'clientProgress.filesChanged') {
        const fc = typeof event.params.fileCount === 'number' ? event.params.fileCount : 0;
        setCounters(prev => ({ ...prev, files: prev.files + fc }));
      }
      if (event.text === 'clientProgress.linesChanged') {
        const lc = typeof event.params.lineCount === 'number' ? event.params.lineCount : 0;
        setCounters(prev => ({ ...prev, lines: prev.lines + lc }));
      }

      // Per-event leaderboard accumulation (not snapshot replacement)
      if (event.developerId && event.effortHours != null) {
        const devMap = dripDevMapRef.current;
        const existing = devMap.get(event.developerId);
        if (existing) {
          existing.totalHours += event.effortHours;
          existing.commitCount += 1;
        } else {
          devMap.set(event.developerId, {
            name: (event.params.developerName as string) ?? 'Developer',
            totalHours: event.effortHours,
            commitCount: 1,
          });
        }
        drippedCommitsRef.current += 1;
        emitLeaderboardUpdate();
      }

      // Schedule next tick with adaptive delay
      const baseDelay = baseDelayFor(event.tier);
      const adjustedDelay = Math.max(15, baseDelay / speedRef.current);
      timerRef.current = setTimeout(tick, adjustedDelay);
    }

    timerRef.current = setTimeout(tick, 50);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isDraining, getExpectedBatchSize, emitLeaderboardUpdate]);

  return { visibleEvents, counters, leaderboard: dripLeaderboard, isDraining, isDrained };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/server && pnpm test -- src/hooks/__tests__/use-drip-feed.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/hooks/use-drip-feed.ts packages/server/src/hooks/__tests__/use-drip-feed.test.ts
git commit -m "feat: add useDripFeed hook with adaptive speed and drain state machine

Buffers client events and emits them with tier-based delays.
Adapts speed based on queue pressure with lerp transitions.
Drives LIVE→DRAINING→DONE state machine from jobStatus."
```

---

### Task 6: Build ClientAnalysisProgress component

**Files:**
- Create: `packages/server/src/components/client-analysis-progress.tsx`

This is a presentational component — tested via integration with the page. The complex logic (drip-feed, mapping) is already unit-tested in Tasks 2 and 5.

- [ ] **Step 1: Create the component**

Create `packages/server/src/components/client-analysis-progress.tsx`:

```tsx
'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useDripFeed } from '@/hooks/use-drip-feed';
import type { ClientEvent, LeaderboardData } from '@/lib/services/client-event-mapper';
import {
  Loader2, Square, Play, RefreshCw, Pause, AlertCircle, XCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

// ── Elapsed timer ──────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [enabled]);
  return now;
}

// ── Odometer counter ───────────────────────────────────────────────

function AnimatedCounter({ value, label }: { value: number; label: string }) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const start = display;
    const diff = value - start;
    if (diff === 0) return;
    const duration = Math.min(400, Math.abs(diff) * 20);
    const startTime = performance.now();

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / duration);
      setDisplay(Math.round(start + diff * progress));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    }
    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="text-center">
      <div className="text-2xl font-bold tabular-nums">{display.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

// ── Feed event row ─────────────────────────────────────────────────

function FeedEvent({ event, t }: { event: ClientEvent; t: (key: string, params?: Record<string, unknown>) => string }) {
  const message = t(`clientProgress.${event.text.replace('clientProgress.', '')}`, event.params);

  if (event.tier === 'milestone') {
    return (
      <div className="py-2 border-t border-primary/20">
        <p className="text-sm font-semibold text-primary">{message}</p>
      </div>
    );
  }

  if (event.tier === 'micro') {
    return (
      <span className="text-xs text-muted-foreground">{message}</span>
    );
  }

  return (
    <p className="text-sm">{message}</p>
  );
}

// ── Leaderboard bar race ───────────────────────────────────────────

function LeaderboardRace({
  data,
  t,
}: {
  data: LeaderboardData;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  const allParticipants = useMemo(() => {
    const devs = data.developers.map(d => ({
      id: d.id,
      name: d.name,
      hours: d.totalHours,
      isGhost: false,
    }));
    devs.push({
      id: '__ghost__',
      name: t('orders.clientProgress.ghostLabel'),
      hours: data.ghost.totalHours,
      isGhost: true,
    });
    return devs.sort((a, b) => b.hours - a.hours);
  }, [data, t]);

  const maxHours = Math.max(...allParticipants.map(p => p.hours), 1);

  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium mb-2">
        {t('orders.clientProgress.leaderboardTitle')}
      </h3>
      {allParticipants.map((participant, index) => (
        <div
          key={participant.id}
          className="flex items-center gap-2 transition-all duration-500 ease-in-out"
          style={{ transform: `translateY(${index * 0}px)` }}
        >
          <div className="w-24 text-xs truncate text-right">
            {participant.isGhost ? (
              <span className="text-muted-foreground/60 italic">{participant.name}</span>
            ) : (
              participant.name
            )}
          </div>
          <div className="flex-1 h-6 bg-muted/30 rounded-sm overflow-hidden">
            <div
              className={`h-full rounded-sm transition-all duration-700 ease-out ${
                participant.isGhost
                  ? 'bg-primary/15 border border-dashed border-primary/30'
                  : 'bg-primary/70'
              }`}
              style={{ width: `${Math.max(2, (participant.hours / maxHours) * 100)}%` }}
            />
          </div>
          <div className="w-14 text-xs tabular-nums text-right">
            {participant.hours.toFixed(1)}h
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────

interface ClientAnalysisProgressProps {
  progress: {
    jobId: string;
    status: string;
    progress: number;
    currentStep: string | null;
    currentCommit: number | null;
    totalCommits: number | null;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
    isPaused: boolean;
    pauseReason: string | null;
    isRetrying: boolean;
    currentRepoName: string | null;
    clientEvents: ClientEvent[];
    eventCursor: string | null;
    leaderboard: LeaderboardData;
  } | null;
  allClientEvents: ClientEvent[];  // cumulative events accumulated by page
  repoSizeMb?: number | null;
  isAdmin: boolean;
  onToggleView: () => void;
  onCancel: () => void;
  onResume: () => void;
  onRetry: () => void;
  onDrainStart: () => void;
  onComplete: () => void;
  cancelPending?: boolean;
  resumePending?: boolean;
}

export function ClientAnalysisProgress({
  progress,
  allClientEvents,
  repoSizeMb,
  isAdmin,
  onToggleView,
  onCancel,
  onResume,
  onRetry,
  onDrainStart,
  onComplete,
  cancelPending,
  resumePending,
}: ClientAnalysisProgressProps) {
  const t = useTranslations('orders');
  const feedRef = useRef<HTMLDivElement>(null);

  // Derive job status from progress (NOT order status — job has the terminal states)
  const jobStatus = progress?.status ?? 'PENDING';

  const {
    visibleEvents,
    counters,
    leaderboard,
    isDraining,
    isDrained,
  } = useDripFeed({
    rawEvents: allClientEvents,
    rawLeaderboard: progress?.leaderboard ?? { developers: [], ghost: { totalHours: 0 }, scopeWorkDays: 0 },
    pollIntervalMs: 1000,
    jobStatus,
  });

  // Notify parent of drain start
  useEffect(() => {
    if (isDraining) onDrainStart();
  }, [isDraining, onDrainStart]);

  // Notify parent when drain complete
  useEffect(() => {
    if (isDrained) onComplete();
  }, [isDrained, onComplete]);

  // Auto-scroll feed
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [visibleEvents.length]);

  const now = useNow(jobStatus === 'RUNNING' || jobStatus === 'PENDING');
  const startedAt = progress?.startedAt ? new Date(progress.startedAt) : null;
  const elapsed = startedAt ? now - startedAt.getTime() : 0;
  const isPaused = progress?.isPaused ?? false;
  const isRetrying = progress?.isRetrying ?? false;

  // Group micro events for compact display
  const groupedEvents = useMemo(() => {
    const groups: { events: ClientEvent[]; isMicroGroup: boolean }[] = [];
    let currentMicros: ClientEvent[] = [];

    for (const event of visibleEvents) {
      if (event.tier === 'micro') {
        currentMicros.push(event);
      } else {
        if (currentMicros.length > 0) {
          groups.push({ events: currentMicros, isMicroGroup: true });
          currentMicros = [];
        }
        groups.push({ events: [event], isMicroGroup: false });
      }
    }
    if (currentMicros.length > 0) {
      groups.push({ events: currentMicros, isMicroGroup: true });
    }
    return groups;
  }, [visibleEvents]);

  // ── Paused state ───────────────────────────────────────────────
  if (isPaused) {
    return (
      <Card className="border-amber-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Pause className="h-5 w-5 text-amber-600" />
            <span className="text-amber-700">{t('clientProgress.pausedBanner')}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {progress && progress.currentCommit != null && progress.totalCommits != null && (
            <div className="space-y-2">
              <Progress value={progress.progress} />
              <p className="text-xs text-muted-foreground">
                {t('detail.preservedProgress', {
                  current: progress.currentCommit,
                  total: progress.totalCommits,
                })}
              </p>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button onClick={onResume} disabled={resumePending}>
              {resumePending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
              {t('detail.resumeSameRun')}
            </Button>
            <Button variant="outline" onClick={onRetry}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('detail.freshRerun')}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Retrying state ─────────────────────────────────────────────
  if (isRetrying && (jobStatus === 'FAILED_RETRYABLE' || jobStatus === 'FAILED')) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-2 mb-2">
            <Loader2 className="h-5 w-5 animate-spin text-amber-600" />
            <span className="font-medium text-amber-700">{t('clientProgress.retryingAutomatically')}</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Failed state (after drain) ─────────────────────────────────
  if (isDrained && (jobStatus === 'FAILED' || jobStatus === 'FAILED_FATAL')) {
    return (
      <div className="space-y-4">
        <Card className="border-red-200">
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-red-600 mb-2">
              <AlertCircle className="h-5 w-5" />
              <span className="font-medium">{t('clientProgress.analysisFailed')}</span>
            </div>
            <p className="text-sm text-muted-foreground">{progress?.error ?? t('clientProgress.genericError')}</p>
            <Button variant="outline" className="mt-4" onClick={onRetry}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('clientProgress.tryAgain')}
            </Button>
          </CardContent>
        </Card>
        {leaderboard.developers.length > 0 && (
          <Card>
            <CardContent className="pt-6">
              <LeaderboardRace data={leaderboard} t={t} />
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  // ── Cancelled state (after drain) ──────────────────────────────
  if (isDrained && jobStatus === 'CANCELLED') {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-2">
              <XCircle className="h-5 w-5 text-muted-foreground" />
              <span className="font-medium">{t('clientProgress.analysisCancelled')}</span>
            </div>
            <Button variant="outline" className="mt-4" onClick={onRetry}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t('clientProgress.startNewAnalysis')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Main live/draining view ────────────────────────────────────
  const currentPhase = progress?.currentStep ?? t('detail.preparing');

  return (
    <div className="space-y-4">
      {/* Dashboard header */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t('detail.analysisInProgress')}
            </CardTitle>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <Button variant="ghost" size="sm" onClick={onToggleView}>
                  {t('clientProgress.adminViewToggle')}
                </Button>
              )}
              {progress?.jobId && (
                <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelPending}>
                  {cancelPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Square className="h-4 w-4 mr-1" />}
                  {t('detail.cancel')}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Progress value={progress?.progress ?? 0} />
          <div className="flex justify-between text-sm text-muted-foreground">
            <span>{currentPhase}</span>
            <span>{t('detail.commitsProgress', {
              current: progress?.currentCommit ?? 0,
              total: progress?.totalCommits ?? '?',
            })}</span>
          </div>

          {/* Animated counters */}
          <div className="grid grid-cols-3 gap-4 py-2">
            <AnimatedCounter value={counters.commits} label={t('clientProgress.commitsUnit', { count: counters.commits })} />
            <AnimatedCounter value={counters.files} label={t('clientProgress.filesChanged', { fileCount: counters.files })} />
            <AnimatedCounter value={counters.lines} label={t('clientProgress.linesChanged', { lineCount: counters.lines })} />
          </div>

          {/* Timing info */}
          <div className="flex items-center gap-4 text-xs text-muted-foreground font-mono">
            {startedAt && (
              <span>{t('detail.started', { time: startedAt.toLocaleTimeString('en-GB', { hour12: false }) })}</span>
            )}
            {elapsed > 0 && (
              <span className="tabular-nums">{t('detail.elapsed', { time: formatElapsed(elapsed) })}</span>
            )}
            {repoSizeMb != null && repoSizeMb > 0 && (
              <span>{t('detail.repositorySize', { size: repoSizeMb >= 1024 ? `${(repoSizeMb / 1024).toFixed(1)} GB` : `${Math.round(repoSizeMb)} MB` })}</span>
            )}
            {progress?.currentRepoName && (
              <span className="border-l pl-4 ml-2">{progress.currentRepoName}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Event feed */}
      <Card>
        <CardContent className="pt-4">
          <div
            ref={feedRef}
            className="max-h-64 overflow-y-auto space-y-1 scroll-smooth"
          >
            {groupedEvents.map((group, i) => {
              if (group.isMicroGroup) {
                return (
                  <div key={`micro-${i}`} className="flex flex-wrap gap-x-2 gap-y-0.5">
                    {group.events.map(e => (
                      <FeedEvent key={e.id} event={e} t={t} />
                    ))}
                  </div>
                );
              }
              return <FeedEvent key={group.events[0].id} event={group.events[0]} t={t} />;
            })}
            {visibleEvents.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('detail.preparing')}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Leaderboard */}
      {leaderboard.developers.length > 0 && (
        <Card>
          <CardContent className="pt-4">
            <LeaderboardRace data={leaderboard} t={t} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/components/client-analysis-progress.tsx
git commit -m "feat: add ClientAnalysisProgress component

Dashboard with animated counters, scrolling event feed with
tier-based styling, and horizontal bar race leaderboard with
DevGhost. Handles paused, failed, cancelled, and retrying states."
```

---

### Task 7: Wire into order page with admin toggle and state machine

**Files:**
- Modify: `packages/server/src/app/[locale]/(dashboard)/orders/[id]/page.tsx`

- [ ] **Step 1: Add imports and state**

At the top of `page.tsx`, add the import:

```typescript
import { ClientAnalysisProgress } from '@/components/client-analysis-progress';
```

Inside the `OrderPage` component, after the existing state declarations (around line 306), add:

```typescript
  const [adminViewMode, setAdminViewMode] = useState<'admin' | 'client'>(isAdmin ? 'admin' : 'client');
  const [clientProgressState, setClientProgressState] = useState<'processing' | 'draining' | 'done'>('processing');

  // Cumulative client events — the API returns incremental batches, we accumulate here
  const [allClientEvents, setAllClientEvents] = useState<ClientEvent[]>([]);
  const clientEventSeenRef = useRef(new Set<string>());
```

In the progress polling `onSuccess` callback (where `jobEvents` are accumulated), add accumulation for client events:

```typescript
    // Accumulate client events (same pattern as jobEvents)
    if (data.data.clientEvents?.length) {
      setAllClientEvents(prev => {
        const newEvents = data.data.clientEvents.filter(
          (e: { id: string }) => !clientEventSeenRef.current.has(e.id)
        );
        for (const e of newEvents) clientEventSeenRef.current.add(e.id);
        return newEvents.length > 0 ? [...prev, ...newEvents] : prev;
      });
    }
```

- [ ] **Step 2: Modify the PROCESSING section render condition**

Replace the PROCESSING section condition (around line 1339):

```tsx
      {/* ================================================================ */}
      {/* PROCESSING — Progress                                            */}
      {/* ================================================================ */}
      {(order.status === 'PROCESSING' || analysisStarted || (clientProgressState === 'draining' && !(isAdmin && adminViewMode === 'admin'))) && (() => {
```

- [ ] **Step 3: Add admin toggle button and client view branch**

Inside the PROCESSING IIFE, before the existing `progress?.isPaused` ternary, add the client view branch:

```tsx
        // Client view (non-admin, or admin previewing client view)
        if (!isAdmin || adminViewMode === 'client') {
          return (
            <ClientAnalysisProgress
              progress={progress as Parameters<typeof ClientAnalysisProgress>[0]['progress']}
              allClientEvents={allClientEvents}
              repoSizeMb={repoSizeMb}
              isAdmin={isAdmin}
              onToggleView={() => setAdminViewMode('admin')}
              onCancel={() => analysisJobId && cancelJobMutation.mutate(analysisJobId)}
              onResume={() => progress?.jobId && resumeJobMutation.mutate(progress.jobId)}
              onRetry={handleRetryAnalysis}
              onDrainStart={() => setClientProgressState('draining')}
              onComplete={() => {
                setClientProgressState('done');
                queryClient.invalidateQueries({ queryKey: ['order', id] });
                queryClient.invalidateQueries({ queryKey: ['metrics', id] });
                queryClient.invalidateQueries({ queryKey: ['workspace-stage'] });
              }}
              cancelPending={cancelJobMutation.isPending}
              resumePending={resumeJobMutation.isPending}
            />
          );
        }
```

- [ ] **Step 4: Add admin toggle button to existing admin view**

In the existing admin Card header (around line 1412), add a toggle button next to the cancel button:

```tsx
                {isAdmin && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAdminViewMode('client')}
                  >
                    {t('clientProgress.clientViewToggle')}
                  </Button>
                )}
```

- [ ] **Step 5: Reset clientProgressState when analysis restarts**

In the `prepareAnalysisLaunch` callback (around line 475), add:

```typescript
  const prepareAnalysisLaunch = useCallback(() => {
    setAnalysisStarted(true);
    setAnalysisJobId(null);
    setPipelineLog([]);
    logSinceRef.current = 0;
    setJobEvents([]);
    eventCursorRef.current = null;
    setClientProgressState('processing');  // reset state machine
    queryClient.removeQueries({ queryKey: ['progress', id] });
  }, [id, queryClient]);
```

- [ ] **Step 6: Verify the build compiles**

Run: `cd packages/server && pnpm build`
Expected: Build succeeds without type errors

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/app/[locale]/\\(dashboard\\)/orders/[id]/page.tsx
git commit -m "feat: wire ClientAnalysisProgress into order page

Admin toggle between admin/client view. Client progress state machine
prevents premature transition to results during drain. Non-admin users
always see the client view."
```

---

### Task 8: Manual integration test

This task verifies the full flow end-to-end.

- [ ] **Step 1: Run all unit tests**

Run: `cd packages/server && pnpm test`
Expected: All tests pass

- [ ] **Step 2: Start dev server and test with admin account**

Run: `cd packages/server && pnpm dev`

1. Navigate to an order, start analysis
2. Verify admin view shows by default (existing technical UI)
3. Click "Client View" toggle — verify client progress appears
4. Verify events drip in one by one, not all at once
5. Verify leaderboard bars grow with each commit
6. Click "Admin View" toggle — verify switch back to technical UI
7. Wait for analysis to complete — verify fast-forward drain + transition

- [ ] **Step 3: Test with non-admin account**

1. Log in as non-admin user
2. Start analysis
3. Verify only client view is shown (no toggle button)
4. Open DevTools Network tab — verify progress response does NOT contain `events`, `log`, `llmProvider`, `modalCallId`, etc.
5. Verify leaderboard shows DevGhost participant

- [ ] **Step 4: Commit any fixes discovered during testing**

```bash
git add -u
git commit -m "fix: integration test fixes for client progress screen"
```
