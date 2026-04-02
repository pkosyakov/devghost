# Client-Facing Analysis Progress Screen

**Date:** 2026-04-02
**Status:** Approved

## Problem

The current PROCESSING screen exposes internal system details (event codes, SHA hashes, LLM provider/model, Modal call IDs, heartbeat diagnostics, pipeline log). This is useful for admin debugging but inappropriate for clients:
- Enables reverse-engineering of the analysis architecture
- Overwhelming technical information for non-technical users (managers)
- No engagement factor — users have no reason to stay on the page

## Goals

1. Create an engaging, "addictive" client-facing progress screen that conveys the massive scale of work being done
2. Prevent reverse-engineering: clients must not receive internal system data
3. Build a live leaderboard ("bar race") where real developers compete against DevGhost (the norm)
4. Emulate real-time event flow via client-side adaptive drip-feed without increasing polling frequency
5. Preserve the current admin UI unchanged; allow admins to toggle between views

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Admin/client split | Role-based filtering in one `/progress` endpoint | No duplication, single point of control |
| Layout | Dashboard (top) + scrolling feed (middle) + leaderboard race (bottom) | Dashboard for overview, feed for engagement, leaderboard for drama |
| Event generation | Server maps raw→client events, client formats text + i18n | Server controls data safety, client owns UX |
| Drip-feed | Adaptive speed with smooth lerp acceleration | Feels natural, no jarring jumps |
| Feed tiers | 3 levels: milestone / major / micro | Hierarchy gives managers anchor points, micro-facts fill gaps |
| Leaderboard metric | Cumulative effort-hours | Direct visualization of Ghost% — the core product metric |
| DevGhost baseline | GHOST_NORM * scope work days | Predictable "norm line" computable before analysis completes |
| DevGhost display | Full participant in sorted race, ghostly visual style | Dramatic overtake moments, brand embodiment |
| Completion behavior | Fast-forward remaining queue via lerp, then milestone + transition | Smooth, no abrupt cut |
| Admin toggle | State toggle in card header, instant switch (data already loaded) | Admin always receives both data sets |

## Architecture

### Server: client-event-mapper.ts

New module `lib/services/client-event-mapper.ts`.

Transforms raw `AnalysisJobEvent[]` + pipeline log into `ClientEvent[]` array.

```typescript
type ClientEvent = {
  id: string;
  ts: number;
  tier: 'milestone' | 'major' | 'micro';
  category: 'phase' | 'commit' | 'repo' | 'stat';
  text: string;                              // i18n key
  params: Record<string, string | number>;   // i18n interpolation params
  developer?: string;                        // email — for leaderboard
  effortHours?: number;                      // for leaderboard
};
```

#### Mapping table

| Raw event code | Client tier | i18n key | Params |
|---|---|---|---|
| `REPO_CLONE_START` | milestone | `clientProgress.repoConnecting` | `{ repo }` |
| `REPO_EXTRACT_DONE` | major | `clientProgress.historyExtracted` | `{ commitCount }` |
| `LLM_EVAL_START` | milestone | `clientProgress.aiAnalysisStarted` | `{ commitCount }` |
| `LLM_COMMIT_RESULT` | major | `clientProgress.commitAnalyzed` | `{ subject }` |
| (from LLM_COMMIT_RESULT payload) | micro | `clientProgress.filesChanged` | `{ fileCount }` |
| (from LLM_COMMIT_RESULT payload) | micro | `clientProgress.linesChanged` | `{ lineCount }` |
| (from LLM_COMMIT_RESULT payload) | micro | `clientProgress.changeType` | `{ type }` |
| `REPO_FULLY_CACHED` | major | `clientProgress.cachedResultsFound` | `{ count }` |
| `REPO_PROCESS_DONE` | milestone | `clientProgress.repoCompleted` | `{ repo, commitCount, totalHours }` |
| `CACHE_REUSED` | micro | `clientProgress.cacheReused` | `{ count }` |

One `LLM_COMMIT_RESULT` event expands into 3-5 client events (commit subject + files + lines + change type + estimation done).

#### Worker payload enrichment (prerequisite)

The current `LLM_COMMIT_RESULT` payload in `worker.py` lacks fields needed for client events and leaderboard. The `commit_lookup` dict already contains `author_email`, `author_name`, `additions`, `deletions`, `files_count` from `git_ops.extract_commits()`, but `_emit_commit_live_results()` does not include them in the event payload. Required changes to `worker.py`:

**`_emit_commit_live_results()` — add to payload:**
```python
payload = {
    ...existing fields...,
    # New fields for client event mapper:
    "authorEmail": commit.get("author_email"),
    "authorName": commit.get("author_name"),
    "filesCount": commit.get("files_count"),
    "additions": commit.get("additions"),
    "deletions": commit.get("deletions"),
}
```

All data is already in `commit_lookup` (populated from `extract_commits()` in `git_ops.py`), so this is a pure payload enrichment — no new data sources needed.

**`REPO_PROCESS_DONE` — enrich payload:**

Current payload has `totalAnalyzed` and `durationSec`. Add `totalHours` (sum of estimated hours for the repo). The calling function `_process_single_repo()` already tracks `total_analyzed`; it needs to also accumulate hours from chunk results.

**`REPO_EXTRACT_DONE` — enrich payload for LAST_N_COMMITS:**

Current payload has `commitCount`. Add `earliestDate` and `latestDate` (from `commit[0]["author_date"]` and `commit[-1]["author_date"]` after sorting). Needed to compute scope work days for ghost baseline when analysis mode is `LAST_N_COMMITS`.

#### Filtered out (never sent to client)

- SHA hashes
- `method` field (llm / fd_heuristic / cache / error)
- Modal internals (modalCallId, heartbeat, executionMode)
- LLM provider, model, concurrency
- Token counts, cost
- Clone size, clone saved
- Retry count, max retries, failure class
- Internal event codes (HEARTBEAT_*, WORKER_*, TRIGGER_*, ROLLBACK_*)
- Pipeline log entries (raw log)
- Raw author emails (leaderboard uses display names only; email used server-side for aggregation but not sent to non-admin clients)

#### Leaderboard data

The mapper accumulates effort-hours per developer from `LLM_COMMIT_RESULT` events (using the new `authorEmail`/`authorName`/`estimatedHours` fields) and computes ghost baseline:

```typescript
type LeaderboardData = {
  developers: {
    id: string;         // stable hash of email (not the raw email)
    name: string;       // display name from authorName
    totalHours: number;
    commitCount: number;
  }[];
  ghost: {
    totalHours: number;  // GHOST_NORM * scopeWorkDays * (progress / 100)
  };
  scopeWorkDays: number;
};
```

Developer identity: the mapper groups by `authorEmail` server-side for aggregation, but sends only a stable hash (`id`) and display name to non-admin clients. Raw emails are never exposed in the client response. This prevents leaking contributor email addresses while still allowing the leaderboard to function.

`ghost.totalHours` grows proportionally with analysis progress so the ghost bar advances alongside real developers.

For `LAST_N_COMMITS` analysis mode: scope work days are computed from the date range of extracted commits (earliest to latest), available after the extract phase.

### Server: Progress API changes

File: `api/orders/[id]/progress/route.ts`

**Admin response** — all current fields preserved, plus:
```typescript
{
  ...currentFields,
  clientEvents: ClientEvent[];
  leaderboard: LeaderboardData;
}
```

**Non-admin response** — filtered:
```typescript
{
  jobId: string;
  status: string;
  progress: number;
  currentStep: string;
  currentCommit: number;
  totalCommits: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;          // sanitized, user-friendly
  isPaused: boolean;
  pauseReason: string | null;
  currentRepoName: string;
  orderStatus: string;
  clientEvents: ClientEvent[];
  eventCursor: string;
  leaderboard: LeaderboardData;
}
```

Error sanitization for non-admin: stack traces and internal errors replaced with user-friendly messages ("Analysis error. Please try again." or category-level: "Repository access issue").

### Client: useDripFeed hook

File: `hooks/use-drip-feed.ts`

```typescript
function useDripFeed(opts: {
  rawEvents: ClientEvent[];
  rawLeaderboard: LeaderboardData;
  pollIntervalMs: number;
  isComplete: boolean;
}): {
  visibleEvents: ClientEvent[];
  counters: { commits: number; files: number; lines: number };
  leaderboard: LeaderboardData;
  isDraining: boolean;
  onDrainComplete: () => void;
};
```

#### Base delays per tier

- `micro`: 30-60ms
- `major`: 150-300ms
- `milestone`: 400-600ms

#### Adaptive speed algorithm

The hook maintains a `queue` of events not yet emitted. Each poll appends new events to the queue.

`expectedBatchSize` is a rolling average of the last 5 batch sizes received from polling. Initialized to 10 (conservative default — a typical poll returns 2-4 raw events that expand into 8-15 client events).

```
pressure = queue.length / expectedBatchSize
```

| Pressure | Behavior |
|----------|----------|
| < 0.5 | Slow down (x1.3 delay). "Thoughtful work" feeling |
| 0.5 - 1.5 | Normal speed |
| 1.5 - 3.0 | Speed up smoothly (x0.7, x0.5 delay) |
| > 3.0 | Fast mode, but never below 15ms between events |

**Smooth transitions** — speed coefficient moves via lerp, not jumps:
```
speed = speed + (targetSpeed - speed) * 0.1
```
Applied each tick. User does not perceive tempo changes.

#### Completion state machine

The current page immediately resets `analysisStarted` and switches UI on status change (page.tsx L731-743). The client progress component needs to intercept this transition to drain the queue before showing results.

**State machine for the component (not the hook):**

```
LIVE → DRAINING → DONE
LIVE → FAILED
LIVE → CANCELLED
LIVE → PAUSED
```

- `LIVE`: normal drip-feed operation, polling active
- `DRAINING`: `order.status` changed to `COMPLETED`, but queue still has events. Component stays mounted, fast-forward active. Polling stops.
- `DONE`: queue drained, final milestone emitted. Component calls `onComplete` callback — page transitions to results.
- `FAILED`: `order.status` changed to `FAILED`/`FAILED_FATAL`. Flush remaining queue at fast speed, then show client-friendly error card.
- `CANCELLED`: `order.status` changed to `CANCELLED`. Flush queue, show "Analysis cancelled" card with option to restart.
- `PAUSED`: `isPaused` is true. Feed freezes, amber banner shown.

**Page integration change:** Instead of `order.status === 'COMPLETED'` immediately hiding the PROCESSING section, the page defers to the component's state:

```tsx
// New state: 'processing' | 'draining' | 'done'
const [clientProgressState, setClientProgressState] = useState<'processing' | 'draining' | 'done'>('processing');

// PROCESSING section stays visible during 'draining'
{(order.status === 'PROCESSING' || analysisStarted || clientProgressState === 'draining') && (
  isAdmin && adminViewMode === 'admin'
    ? <current admin UI>
    : <ClientAnalysisProgress
        progress={progress}
        orderStatus={order.status}
        isAdmin={isAdmin}
        onToggleView={() => setAdminViewMode(m => m === 'admin' ? 'client' : 'admin')}
        onCancel={() => cancelJobMutation.mutate(analysisJobId)}
        onResume={() => resumeJobMutation.mutate(progress.jobId)}
        onRetry={handleRetryAnalysis}
        onDrainStart={() => setClientProgressState('draining')}
        onComplete={() => {
          setClientProgressState('done');
          // existing invalidation logic runs here
        }}
      />
)}
```

**Hook fast-forward behavior:**

When the component enters DRAINING state:
1. Hook sets target speed to maximum
2. Lerp accelerates to ~15ms intervals over ~2 seconds
3. After queue drains, hook emits final milestone "Analysis complete"
4. Hook sets `isDrained: true`
5. Component reads `isDrained`, calls `onComplete` callback

The `onDrainComplete` from the original spec is replaced by the `isDrained` boolean return value — the component controls the transition, not the hook.

#### Terminal states — client UX

**FAILED / FAILED_FATAL (client):**
- Flush remaining events at fast speed
- Show error card: "Analysis encountered an issue" (no stack trace, no internal error codes)
- Categorized messages: "Repository access issue", "Analysis service temporarily unavailable", or generic "Unexpected error"
- Button: "Try Again" (same as current retry logic)
- Leaderboard and feed stay visible (showing work done so far)

**CANCELLED (client):**
- Flush remaining events
- Show info card: "Analysis was cancelled"
- Leaderboard and feed stay visible
- Button: "Start New Analysis"

**FAILED_RETRYABLE (non-quota, client):**
- Same as FAILED but with "Retrying automatically..." message if retryCount < maxRetries
- If max retries exhausted, same as FAILED

**LLM_COMPLETE (client):**
- Client sees this as "Finalizing results..." phase in the dashboard
- Feed continues dripping if events remain
- No special UI — just a phase label change

#### Counters and leaderboard sync

Counters (commits, files, lines) update as events drip — not from raw API data. Dashboard binds to hook's `counters`, not API response directly.

Leaderboard updates on each `major` event with `effortHours` — synchronized with feed. No ahead/behind.

### Client: ClientAnalysisProgress component

File: `components/client-analysis-progress.tsx`

Three zones top to bottom:

#### Zone 1: Dashboard header

- Progress bar (animated)
- Current phase label ("Extracting history", "AI commit analysis", "Calculating metrics")
- Animated counters: commits / files / lines — odometer-style number roll
- Started at timestamp + live elapsed timer
- Current repository ("repo 2/5: owner/name") if multi-repo
- Repository size (from GitHub metadata)
- Cancel button

#### Zone 2: Event feed

Scrolling list, auto-scrolls to bottom. Three visual tiers:

| Tier | Style |
|------|-------|
| **milestone** | Large text, horizontal divider line, accent color |
| **major** | Normal row, category icon on left |
| **micro** | Small text, muted gray, compact. Multiple micro events joined with `·` separator |

#### Zone 3: Leaderboard Race

Horizontal bar chart race:
- Each developer = bar, width proportional to `totalHours`
- Right of bar: name + hours value
- Sorted by hours descending (leader on top)
- DevGhost: semi-transparent bar, dashed border, ghost icon, label "DevGhost — the norm"
- Position changes: rows animate via CSS transition on transform (smooth swap)
- Bar growth: CSS transition on width
- Updates synchronized with drip-feed — each major event with `effortHours` moves the corresponding bar

#### Paused state (client)

When `isPaused` is true:
- Feed and leaderboard freeze in place (accumulated data stays visible)
- Amber banner over dashboard: "Analysis paused — waiting for resources. Progress preserved."
- Progress bar shows current value, no animation
- "Resume" button (same logic as current)
- No technical details (quota, failure class, retry count)

### Page integration

File: `app/[locale]/(dashboard)/orders/[id]/page.tsx`

```tsx
// New state for admin toggle
const [adminViewMode, setAdminViewMode] = useState<'admin' | 'client'>('admin');

// In PROCESSING section:
{(order.status === 'PROCESSING' || analysisStarted) && (
  isAdmin && adminViewMode === 'admin'
    ? <current admin UI with toggle button>
    : <ClientAnalysisProgress
        progress={progress}
        isAdmin={isAdmin}
        onToggleView={() => setAdminViewMode(m => m === 'admin' ? 'client' : 'admin')}
        onCancel={() => cancelJobMutation.mutate(analysisJobId)}
        onResume={() => resumeJobMutation.mutate(progress.jobId)}
        onRetry={handleRetryAnalysis}
        isComplete={order.status === 'COMPLETED'}
      />
)}
```

Admin toggle: button in card header, switches `adminViewMode`. Instant — no server request needed since admin response includes both data sets.

## File inventory

### New files

| File | Purpose |
|------|---------|
| `lib/services/client-event-mapper.ts` | Raw events to ClientEvent[] + leaderboard |
| `lib/services/client-event-mapper.test.ts` | Mapper unit tests |
| `components/client-analysis-progress.tsx` | Client progress component (dashboard + feed + leaderboard) |
| `hooks/use-drip-feed.ts` | Adaptive drip-feed hook |
| `hooks/use-drip-feed.test.ts` | Drip-feed hook tests |

### Modified files

| File | Changes |
|------|---------|
| `packages/modal/worker.py` | Enrich `LLM_COMMIT_RESULT` payload (authorEmail, authorName, filesCount, additions, deletions), enrich `REPO_PROCESS_DONE` (totalHours), enrich `REPO_EXTRACT_DONE` (earliestDate, latestDate) |
| `api/orders/[id]/progress/route.ts` | Role-based response: call mapper for all requests, filter fields for non-admin |
| `app/[locale]/(dashboard)/orders/[id]/page.tsx` | Admin toggle state, client progress state machine, conditional render of ClientAnalysisProgress vs current admin UI, deferred COMPLETED transition |
| i18n message files | Keys for client events, dashboard labels, leaderboard labels |

### Unchanged

- Current admin UI components (pipeline-log, analysis-event-log, commit-processing-timeline)
- Pipeline log store
- Progress API admin response format (backward compatible, new fields added)
