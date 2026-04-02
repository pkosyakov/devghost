# Budget-Based Drip Feed Pacing

## Problem

The drip feed visualization has dead time between poll batches. The server produces events in bursts (one poll every ~1s returns N new events), the drip loop plays them out with tier-based delays, but it has no awareness of *when the next batch will arrive*. When the queue empties before the next poll, the feed stalls — the user sees a frozen log until new events come in.

```
Poll 1          Poll 2          Poll 3
  |               |               |
  v               v               v
 [batch A]       [batch B]       [batch C]
  ░░░▓▓▓▓▓▓      ░░░▓▓▓▓▓▓      ░░░▓▓▓▓▓▓
              ^^^           ^^^
           DEAD TIME     DEAD TIME
```

### Root cause

The current adaptive pressure model (`queue.length / expectedBatchSize`) is reactive — it only knows the current queue depth, not the *time horizon*. By the time pressure drops below 0.5 and speed decreases to 0.75×, the queue is nearly empty and a stall is inevitable.

### Observed dynamics

The Modal worker processes commits in chunks (`demo_live_chunk_size`, typically 1–10 commits for demo/live mode, full batch for regular). Each chunk writes `LLM_COMMIT_RESULT` events to the DB. The client polls `/progress` every `livePollMs` (1000ms, or 300ms in admin demo mode) and gets all events since `sinceEventId`.

Real-world event counts per poll:
- **Small repos / demo mode**: 1–4 events per poll (chunk_size=1, each commit -> 1 major + 1-3 micro = 2-4 events)
- **Medium repos**: 5–20 events per poll
- **Large repos / fast LLM**: 20–60+ events per poll (multiple chunks complete between polls)
- **Cached results**: Entire repo can return 100+ events in one poll (REPO_FULLY_CACHED)

## Design

### Core idea: per-event stamped delays

Each event gets its delay computed and frozen **at enqueue time**, based on the budget available at that moment. The tick loop reads the pre-stamped delay — it never recomputes. This guarantees that batch B arriving mid-drain of batch A does not retroactively change A's remaining timing.

```
Poll 1          Poll 2          Poll 3
  |    budget    |    budget    |
  v--------------v--------------v
 [A₁ A₂ A₃ A₄ A₅ B₁ B₂ B₃ B₄ B₅ C₁ C₂ C₃ C₄ ...]
  each event carries its own delayMs
```

### Queue item type

The queue no longer holds bare `ClientEvent`. Each entry is a stamped item:

```typescript
type QueueItem = {
  event: ClientEvent;
  delayMs: number;     // pre-computed, frozen at enqueue
};
```

### Signal: measured poll interval

The most reliable signal is the real time between consecutive batch arrivals. This implicitly accounts for server processing time, network latency, and React Query scheduling jitter.

```
measuredInterval = timestamp(batch N arrival) - timestamp(batch N-1 arrival)
budget = measuredInterval × BUDGET_PADDING
```

### Weighted delay distribution

Flat `budget / eventCount` would kill tier differences. Each tier has a weight:

| Tier | Weight | Rationale |
|------|--------|-----------|
| `milestone` | 4.0 | Repos connecting/completing — should breathe |
| `major` | 2.0 | Individual commits — main rhythm |
| `micro` | 0.5 | File/line counts, categories — quick flashes |

**Per-event delay calculation at enqueue:**

```
totalWeight = sum of weights for all events in this batch
msPerWeight = budget / totalWeight
delay(event) = clamp(msPerWeight × TIER_WEIGHT[event.tier], tierMin, tierMax)
```

### Overload handling

The clamp floors create a minimum drip time per batch. If the sum of clamped delays exceeds the budget, the queue will grow — this is the overload scenario.

**Detection:**

```
clampedSum = sum of all clamped delays for this batch
overloaded = clampedSum > budget
```

**Two-phase response:**

1. **Scale-down** (soft): When `clampedSum > budget`, uniformly scale all delays to move the total closer to `budget`:

```
scaleFactor = budget / clampedSum
delay(event) = max(HARD_FLOOR, clampedDelay × scaleFactor)
```

`HARD_FLOOR = 10ms` — absolute minimum to avoid invisible events. Because of the floor, the actual sum may still exceed `budget` (see example below). This is acceptable — the goal is bounded lag, not exact timing.

2. **Catch-up drain** (hard): If the queue depth exceeds a high-water mark (`queue.length > expectedBatchSize × 3`), the batch's events are stamped at `HARD_FLOOR` regardless of tier. This is a controlled flush that prevents unbounded lag. The high-water mark ensures this only triggers under sustained overload, not a single large batch.

**Example: 300ms poll, batch of 10 major + 50 micro:**

| Step | Calculation | Result |
|------|-------------|--------|
| Budget | 300 × 1.2 | 360ms |
| Weighted delays | 10×(360/45×2=16) + 50×(360/45×0.5=4) | 160 + 200 = 360ms |
| Clamped delays | 10×40 + 50×15 | 400 + 750 = 1150ms |
| Overloaded? | 1150 > 360 | Yes |
| Scale factor | 360 / 1150 | 0.313 |
| Scaled major | max(10, 40×0.313) = max(10, 12.5) | 12.5ms |
| Scaled micro | max(10, 15×0.313) = max(10, 4.7) | 10ms |
| Final sum | 10×12.5 + 50×10 | 625ms |

625ms > 360ms budget — the batch takes ~1.7× longer to drip than the poll interval. With each poll adding 60 events and drip consuming them in 625ms, the backlog grows by ~60 events every two polls. This is the sustained overload scenario. After a few polls the queue depth exceeds `avgBatch × CATCH_UP_THRESHOLD`, and catch-up stamps all new events at `HARD_FLOOR (10ms)`. At that point a 60-event batch drips in 600ms (60 × 10ms), which is close enough to the 360ms budget to stabilize the queue. Once the backlog clears, normal budget-weighted pacing resumes.

### Enqueue algorithm

Complete pseudocode for the enqueue effect:

```typescript
useEffect(() => {
  const newEvents: ClientEvent[] = [];
  for (const event of rawEvents) {
    if (!seenIdsRef.current.has(event.id)) {
      seenIdsRef.current.add(event.id);
      newEvents.push(event);
    }
  }
  if (newEvents.length === 0) return;

  // ── Measure interval ──
  const now = performance.now();
  if (lastBatchAtRef.current > 0) {
    measuredIntervalRef.current = now - lastBatchAtRef.current;
  }
  lastBatchAtRef.current = now;

  const budget = measuredIntervalRef.current * BUDGET_PADDING;

  // ── Compute weighted delays ──
  const totalWeight = newEvents.reduce(
    (s, e) => s + (TIER_WEIGHT[e.tier] ?? TIER_WEIGHT.major), 0
  );
  const msPerWeight = totalWeight > 0 ? budget / totalWeight : budget / newEvents.length;

  // ── Clamp per tier ──
  const items: QueueItem[] = newEvents.map(event => {
    const weight = TIER_WEIGHT[event.tier] ?? TIER_WEIGHT.major;
    const raw = msPerWeight * weight;
    const [minD, maxD] = DELAY_CLAMP[event.tier] ?? DELAY_CLAMP.major;
    return { event, delayMs: Math.max(minD, Math.min(maxD, raw)) };
  });

  // ── Overload: scale down if clamped sum exceeds budget ──
  const clampedSum = items.reduce((s, it) => s + it.delayMs, 0);
  if (clampedSum > budget) {
    const scale = budget / clampedSum;
    for (const item of items) {
      item.delayMs = Math.max(HARD_FLOOR, item.delayMs * scale);
    }
  }

  // ── Catch-up: if queue already deep, stamp at HARD_FLOOR ──
  const queueDepth = queueRef.current.length;
  const avgBatch = batchSizeEmaRef.current;
  if (queueDepth > avgBatch * CATCH_UP_THRESHOLD) {
    for (const item of items) {
      item.delayMs = HARD_FLOOR;
    }
  }

  // ── Update EMA for catch-up threshold ──
  batchSizeEmaRef.current = batchSizeEmaRef.current * 0.7 + newEvents.length * 0.3;

  // ── Push to queue ──
  queueRef.current.push(...items);
}, [rawEvents]);
```

### Tick loop

The tick loop simplifies — it just reads the pre-stamped delay:

```typescript
function tick() {
  const queue = queueRef.current;

  if (isPaused) {
    timerRef.current = setTimeout(tick, 250);
    return;
  }

  if (queue.length === 0) {
    if (isDraining) {
      setIsDrained(true);
      return;
    }
    timerRef.current = setTimeout(tick, 50);
    return;
  }

  const { event, delayMs } = queue.shift()!;
  setVisibleEvents(prev => [...prev, event]);

  // ... counter + leaderboard accumulation (unchanged) ...

  const adjustedDelay = isDraining
    ? Math.max(HARD_FLOOR, delayMs / DRAIN_SPEEDUP)
    : delayMs;
  timerRef.current = setTimeout(tick, adjustedDelay);
}
```

### Drain mode

When `isDraining` is set (terminal job status), the tick divides each event's pre-stamped delay by `DRAIN_SPEEDUP (5)`. New events that arrive during drain are also stamped normally at enqueue — the `/5` division happens at dequeue in tick. This keeps the drain path simple and consistent.

### State transitions

**First batch (no prior measurement):**
- `measuredIntervalRef` initialized to `defaultIntervalMs` (passed from caller, typically `livePollMs`)
- Budget = defaultIntervalMs × 1.2
- Pre-stamped delays use this initial budget

**Empty poll (0 new events):**
- Enqueue effect exits early (no new events)
- No budget recalculation, no queue changes
- Tick idles at 50ms

**Large initial load (historical events on first fetch):**
- First fetch can return hundreds of events, no prior measurement
- Budget = defaultIntervalMs × 1.2 (e.g., 1200ms for normal, 360ms for admin demo)
- With 100+ events the overload path activates: delays are scaled down
- If extreme (500+ events), catch-up stamps everything at HARD_FLOOR
- The initial burst plays fast — correct UX for page load

**Pause (EXTERNAL_QUOTA):**
- No change — tick freezes at 250ms idle
- Pre-stamped delays in queue are preserved
- When unpaused, events resume with their original delays

**Resume (FAILED_RETRYABLE -> RUNNING after quota pause):**

Resume continues the **same job** — `allClientEvents` in the parent page stays intact, and the next poll returns only new events (via `sinceEventId` cursor). The hook must NOT clear `queueRef` or `seenIdsRef`, because:
- Clearing `queueRef` drops queued-but-not-yet-shown events (data loss)
- Clearing `seenIdsRef` causes replayed events to be re-enqueued and double-counted

The correct reset is **timing refs only**:
  ```typescript
  lastBatchAtRef.current = 0;
  measuredIntervalRef.current = defaultIntervalMs;
  batchSizeEmaRef.current = 10;
  ```
First post-resume batch uses default budget, subsequent batches measure normally. Any events already in the queue continue dripping with their pre-stamped delays.

Note: the existing guard `(isDraining || isDrained)` is also wrong for quota-pause resume. A quota-paused job has `isPaused=true`, which blocks drain detection (line 87-91 in current code). So a paused `FAILED_RETRYABLE -> RUNNING` transition will have `isDraining=false, isDrained=false`, and the guard won't fire. The correct condition is simply `jobStatus === 'RUNNING' && (prev === 'FAILED_RETRYABLE' || prev === 'PENDING')` — the timing reset is safe regardless of drain state.

**Fresh rerun (new job via prepareAnalysisLaunch):**

A fresh rerun starts a new `AnalysisJob`. The parent clears `allClientEvents` and `clientEventSeenRef` (`page.tsx:510-519`), but `ClientAnalysisProgress` stays mounted (held by `analysisStarted`). This means the `useDripFeed` hook instance survives the rerun — its internal state (`visibleEvents`, `counters`, `leaderboard`, `queueRef`, `seenIdsRef`, timing refs) all carry over from the old run.

This is a problem: old events drip into the new run, counters show stale totals, the leaderboard shows old developer bars. Parent-level state clearing is insufficient because the hook's `useState`/`useRef` values are owned by the component instance, not the parent.

**Solution: forced remount via React key.**

The parent renders `ClientAnalysisProgress` with `key={analysisJobId ?? 'pending'}`. When a new job starts and `analysisJobId` changes, React unmounts the old instance and mounts a fresh one. All hook state initializes from scratch — no stale queue, no stale counters, no stale timing.

```tsx
// page.tsx — in the render block:
<ClientAnalysisProgress
  key={analysisJobId ?? 'pending'}
  progress={...}
  allClientEvents={allClientEvents}
  pollIntervalMs={livePollMs}
  ...
/>
```

This is the cleanest approach because:
- No hook-level reset logic needed for the "new job" path
- All `useState` and `useRef` values reinitialize automatically
- The `useDripFeed` hook doesn't need to know about job identity
- Resume (same job) still works — `analysisJobId` doesn't change on resume, so no remount

The `key` prop addition is a one-line change in `page.tsx`.

### Changes to useDripFeed

**New types:**

```typescript
type QueueItem = {
  event: ClientEvent;
  delayMs: number;
};
```

**New refs (replace speedRef, targetSpeedRef, batchSizesRef):**

```typescript
const lastBatchAtRef = useRef(0);
const measuredIntervalRef = useRef(defaultIntervalMs);
const batchSizeEmaRef = useRef(10);            // EMA of batch sizes for catch-up threshold
```

**Queue type change:**

```typescript
const queueRef = useRef<QueueItem[]>([]);       // was ClientEvent[]
```

**Removed:**
- `speedRef` — no longer needed (delays are pre-stamped)
- `targetSpeedRef` — no longer needed
- `batchSizesRef` — replaced by `batchSizeEmaRef` for catch-up threshold only
- `getExpectedBatchSize` callback — removed
- Entire pressure block (current lines 170–185) — replaced by per-event stamped delays
- `baseDelayFor` function — replaced by budget math (but kept as fallback for edge cases)

**Resume reset (replaces current lines 93–109):**

```typescript
useEffect(() => {
  const prev = prevJobStatusRef.current;
  prevJobStatusRef.current = jobStatus;
  if (
    jobStatus === 'RUNNING' &&
    (prev === 'FAILED_RETRYABLE' || prev === 'PENDING')
  ) {
    // Reset drain state if it was active
    if (isDraining || isDrained) {
      setIsDraining(false);
      setIsDrained(false);
    }
    // Reset timing refs only — queue and seenIds are preserved
    // (resume continues the same job; parent keeps allClientEvents alive)
    lastBatchAtRef.current = 0;
    measuredIntervalRef.current = defaultIntervalMs;
    batchSizeEmaRef.current = 10;
  }
}, [jobStatus, isDraining, isDrained, defaultIntervalMs]);
```

Note: the `(isDraining || isDrained)` guard is removed from the outer condition. A quota-paused `FAILED_RETRYABLE` has `isPaused=true`, which blocks drain detection, so `isDraining` and `isDrained` are both `false` at resume time. The timing reset must fire regardless.

### Constants

```typescript
const TIER_WEIGHT: Record<string, number> = {
  milestone: 4,
  major: 2,
  micro: 0.5,
};

const DELAY_CLAMP: Record<string, [number, number]> = {
  milestone: [100, 800],
  major: [40, 400],
  micro: [15, 80],
};

const BUDGET_PADDING = 1.2;         // 20% buffer over measured interval
const DRAIN_SPEEDUP = 5;            // fast-forward multiplier for terminal drain
const HARD_FLOOR = 10;              // absolute minimum delay (ms) per event
const CATCH_UP_THRESHOLD = 3;       // queue depth / avgBatch triggers catch-up
```

### Interface changes

**`UseDripFeedOpts`** — add `defaultIntervalMs`:

```typescript
interface UseDripFeedOpts {
  rawEvents: ClientEvent[];
  rawLeaderboard: LeaderboardData;
  jobStatus: string;
  isPaused?: boolean;
  defaultIntervalMs?: number;  // initial budget hint (livePollMs from caller)
}
```

Default: `1000` if not provided.

### What stays the same

- Event deduplication by `seenIdsRef`
- Counter accumulation logic (commits, files, lines)
- Per-event leaderboard accumulation via `dripDevMapRef`
- Drain detection (`DRAIN_STATUSES` set) and drain-complete snap
- Pause freeze behavior (250ms idle tick)
- Queue empty -> idle at 50ms
- `isDraining`/`isDrained` state variables

## Prop threading: defaultIntervalMs

`livePollMs` is computed in `page.tsx` (line 342). It needs to reach `useDripFeed` through `ClientAnalysisProgress`.

### page.tsx

`ClientAnalysisProgress` already receives many props. Add `pollIntervalMs`:

```typescript
<ClientAnalysisProgress
  progress={...}
  allClientEvents={allClientEvents}
  repoSizeMb={repoSizeMb}
  pollIntervalMs={livePollMs}       // NEW
  isAdmin={isAdmin}
  ...
/>
```

### ClientAnalysisProgressProps

```typescript
interface ClientAnalysisProgressProps {
  // ... existing props ...
  pollIntervalMs?: number;           // NEW
}
```

### ClientAnalysisProgress -> useDripFeed

```typescript
const { visibleEvents, counters, leaderboard, isDraining, isDrained } = useDripFeed({
  rawEvents: allClientEvents,
  rawLeaderboard: progress?.leaderboard ?? ...,
  jobStatus,
  isPaused,
  defaultIntervalMs: pollIntervalMs,  // NEW
});
```

## Test plan

1. **Per-event stamp isolation**: Enqueue batch A (5 events). Before A finishes draining, enqueue batch B (3 events). Verify that A's remaining events still tick at A's delays, and B's events tick at B's delays. This is the critical regression test.

2. **Budget calculation from measured interval**: Enqueue batch 1 at t=0, batch 2 at t=500ms. Verify batch 2's events have delays summing to ~600ms (500 × 1.2).

3. **Weighted distribution**: Enqueue a batch of 1 milestone + 2 major + 4 micro with budget=1000ms. Verify milestone delay > major delay > micro delay, and sum ~= 1000ms.

4. **Overload scale-down**: Enqueue 10 major + 50 micro with budget=360ms (simulating 300ms admin demo poll). Verify clampedSum > budget triggers scale-down, no delay exceeds clamp max, and total is closer to budget.

5. **Catch-up drain**: Pre-fill queue with 100 items, then enqueue a new batch. Verify new batch events are stamped at HARD_FLOOR.

6. **Drain speedup**: Set jobStatus to 'COMPLETED'. Verify tick applies `/DRAIN_SPEEDUP` to pre-stamped delays.

7. **First batch fallback**: Enqueue events with no prior batch, `defaultIntervalMs=300`. Verify delays use 300 × 1.2 = 360ms budget.

8. **Resume reset (timing only)**: Transition `FAILED_RETRYABLE -> RUNNING`. Verify `lastBatchAtRef`, `measuredIntervalRef`, `batchSizeEmaRef` are reset to defaults. Verify `queueRef` and `seenIdsRef` are **preserved** (not cleared). Verify queued events continue dripping with their original pre-stamped delays.

9. **Resume from quota pause (no drain state)**: Set up a quota-paused state (`FAILED_RETRYABLE` + `isPaused=true`, so `isDraining=false, isDrained=false`). Transition to `RUNNING`. Verify timing refs are reset even though drain was never active. Verify `defaultIntervalMs=300` is applied correctly for admin demo poll rate.

10. **Fresh rerun remount**: Verify that changing the `key` prop on `ClientAnalysisProgress` causes React to unmount/remount, giving `useDripFeed` fresh state. Verify old `visibleEvents`, `counters`, and `leaderboard` do not carry over.

9. **Empty poll**: Call with rawEvents that are all already seen. Verify no budget recalculation, queue unchanged.

## Scope

- **In scope**: `useDripFeed` hook refactor (stamped delays, budget math, overload handling, resume reset), `ClientAnalysisProgress` prop + passthrough, `page.tsx` prop addition, tests
- **Out of scope**: Server-side timing hints, poll interval adjustment, UI changes, leaderboard pacing
- **Files touched**: `use-drip-feed.ts`, `use-drip-feed.test.ts`, `client-analysis-progress.tsx`, `orders/[id]/page.tsx`
- **Risk**: Low — pure client-side timing change, no API changes, no data model changes. The QueueItem type change is internal to the hook. The `key={analysisJobId}` addition is a one-line change that uses React's built-in remount mechanism.
