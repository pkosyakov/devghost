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
- **Small repos / demo mode**: 1–4 events per poll (chunk_size=1, each commit → 1 major + 1-3 micro = 2-4 events)
- **Medium repos**: 5–20 events per poll
- **Large repos / fast LLM**: 20–60+ events per poll (multiple chunks complete between polls)
- **Cached results**: Entire repo can return 100+ events in one poll (REPO_FULLY_CACHED)

## Design

### Core idea: time-budget pacing

Each batch of events receives a **time budget** — the estimated time until the next batch arrives. Events are spaced to fill this budget completely, preserving tier-based rhythm through weighted delays.

```
Poll 1          Poll 2          Poll 3
  |    budget    |    budget    |
  v--------------v--------------v
 [batch A ~~~~~~][batch B ~~~~~~][batch C ~~~~~~]
  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
              no dead time
```

### Signal: measured poll interval

The most reliable signal is the real time between consecutive batch arrivals. This implicitly accounts for server processing time, network latency, and React Query scheduling jitter.

```
measuredInterval = timestamp(batch N arrival) - timestamp(batch N-1 arrival)
```

We apply a 20% padding factor to prevent the drip from finishing *just* before the next poll:

```
budget = measuredInterval × 1.2
```

### Weighted delay distribution

Flat `budget / eventCount` would kill tier differences — milestones and micro events would play at the same speed. Instead, each tier has a weight:

| Tier | Weight | Rationale |
|------|--------|-----------|
| `milestone` | 4.0 | Repos connecting/completing — should breathe |
| `major` | 2.0 | Individual commits — main rhythm |
| `micro` | 0.5 | File/line counts, categories — quick flashes |

**Per-event delay calculation:**

```
totalWeight = sum of weights for all events in the batch
msPerWeight = budget / totalWeight
delay(event) = msPerWeight × TIER_WEIGHT[event.tier]
```

**Example**: batch of 1 milestone + 5 major + 10 micro events, budget = 1200ms
- totalWeight = 4 + 10 + 5 = 19
- msPerWeight = 1200 / 19 = 63.2ms
- milestone delay: 63.2 × 4 = 253ms
- major delay: 63.2 × 2 = 126ms
- micro delay: 63.2 × 0.5 = 32ms
- total: 253 + 632 + 316 = 1201ms (fills the budget)

### Safety clamps

Budget math can produce extreme values in edge cases. Clamp per-event delay to maintain UX:

| Tier | Min delay | Max delay | Why |
|------|-----------|-----------|-----|
| `milestone` | 100ms | 800ms | Must be visible but not blocking |
| `major` | 40ms | 400ms | Readable commit rhythm |
| `micro` | 15ms | 80ms | Quick but not invisible |

When clamps activate (very small or very large batches), the total drip time won't exactly match the budget — this is acceptable. The budget is a target, not a hard constraint.

### State transitions

**First batch (no prior measurement)**:
- `measuredInterval` defaults to `livePollMs` (1000ms or 300ms for admin demo)
- Budget = default × 1.2
- Falls back gracefully to near-current behavior

**Empty poll (0 new events)**:
- Budget and weights are not recalculated
- Queue is empty, tick idles at 50ms check interval (unchanged)

**Large initial load (historical events on first fetch)**:
- First fetch can return hundreds of events (entire job history)
- Budget for this batch = default interval × 1.2 (no prior measurement)
- Events play at clamp-limited speeds, which is correct — the user just opened the page and the initial burst should play fast
- Subsequent incremental batches will have accurate measured intervals

**Drain mode (job terminal)**:
- Budget is divided by a drain speedup factor (5×)
- `drainDelay = budgetDelay / 5`
- This is the same behavior as current `isDraining ? 5.0 : ...` speed multiplier

**Pause (EXTERNAL_QUOTA)**:
- No change — tick still freezes at 250ms idle (unchanged)

**Resume after pause (FAILED_RETRYABLE → RUNNING)**:
- `measuredInterval` resets to `livePollMs` default
- First post-resume batch uses default budget

### Changes to useDripFeed

**New refs:**

```typescript
const lastBatchAtRef = useRef(0);           // performance.now() of last batch arrival
const measuredIntervalRef = useRef(1000);   // measured ms between batches
const batchBudgetRef = useRef(1200);        // current budget (ms) for drip pacing
const batchTotalWeightRef = useRef(0);      // sum of tier weights in current batch
```

**Enqueue effect (replaces lines 68–82):**

On each new batch, measure the real interval since the previous batch and compute a weighted budget.

```typescript
useEffect(() => {
  let newCount = 0;
  let newWeight = 0;
  for (const event of rawEvents) {
    if (!seenIdsRef.current.has(event.id)) {
      seenIdsRef.current.add(event.id);
      queueRef.current.push(event);
      newCount++;
      newWeight += TIER_WEIGHT[event.tier] ?? TIER_WEIGHT.major;
    }
  }
  if (newCount > 0) {
    const now = performance.now();
    if (lastBatchAtRef.current > 0) {
      measuredIntervalRef.current = now - lastBatchAtRef.current;
    }
    lastBatchAtRef.current = now;
    batchBudgetRef.current = measuredIntervalRef.current * BUDGET_PADDING;
    batchTotalWeightRef.current = newWeight;
  }
}, [rawEvents]);
```

**Tick delay (replaces lines 170–185 pressure + lines 222–225 baseDelayFor):**

```typescript
// Budget-based delay
const weight = TIER_WEIGHT[event.tier] ?? TIER_WEIGHT.major;
const totalW = batchTotalWeightRef.current;
const rawDelay = totalW > 0
  ? (batchBudgetRef.current / totalW) * weight
  : baseDelayFor(event.tier);

const [minD, maxD] = DELAY_CLAMP[event.tier] ?? DELAY_CLAMP.major;
const budgetDelay = Math.max(minD, Math.min(maxD, rawDelay));
const adjustedDelay = isDraining ? Math.max(15, budgetDelay / DRAIN_SPEEDUP) : budgetDelay;
```

**Removed:**
- `speedRef`, `targetSpeedRef` — lerp-based speed control is no longer needed
- `batchSizesRef` — batch size averaging replaced by direct interval measurement
- `getExpectedBatchSize` callback — pressure calculation removed
- Entire pressure block (lines 170–185) — replaced by budget math

### What stays the same

- Event deduplication by `seenIdsRef`
- Counter accumulation logic
- Per-event leaderboard accumulation via `dripDevMapRef`
- Drain detection and drain-complete snap
- Pause freeze behavior
- Resume reset behavior
- Queue empty → idle at 50ms

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

const BUDGET_PADDING = 1.2;   // 20% buffer
const DRAIN_SPEEDUP = 5;      // fast-forward multiplier
```

### Interface changes

**`UseDripFeedOpts`** — add optional `defaultIntervalMs`:

```typescript
interface UseDripFeedOpts {
  rawEvents: ClientEvent[];
  rawLeaderboard: LeaderboardData;
  jobStatus: string;
  isPaused?: boolean;
  defaultIntervalMs?: number;  // NEW: initial budget hint (livePollMs from page)
}
```

The caller passes `livePollMs` so the hook can initialize `measuredIntervalRef` correctly for the first batch instead of hardcoding 1000ms.

### Test plan

1. **Budget calculation**: Feed 2 batches with known timestamps, verify `measuredIntervalRef` equals the difference
2. **Weighted distribution**: Feed a batch with known tier composition, verify per-event delays sum to ~budget
3. **Clamp enforcement**: Feed a 1-event batch (huge budget per event), verify delay is clamped to tier max
4. **Drain speedup**: Trigger terminal status, verify delays are reduced by DRAIN_SPEEDUP factor
5. **First batch fallback**: Feed events without prior batch, verify `defaultIntervalMs` is used
6. **Empty poll**: Verify no budget recalculation, queue stays idle

### Future: server-side timing hint (optional, not in scope)

The `/progress` endpoint could return a `serverProcessingMs` header measuring handler execution time. The client could subtract this from the measured interval to isolate network round-trip time:

```
actualServerTime = serverProcessingMs
networkRoundTrip = measuredInterval - actualServerTime
budget = actualServerTime × 1.2 + networkRoundTrip
```

This would be useful if server processing time varies significantly between polls (e.g., heavy LLM batch vs. idle poll). Not needed for v1 — the 20% padding covers typical jitter.

## Scope

- **In scope**: `useDripFeed` hook refactor (budget math, remove pressure), `ClientAnalysisProgress` passes `defaultIntervalMs`, tests
- **Out of scope**: Server-side timing hints, poll interval adjustment, UI changes, leaderboard pacing (already driven by per-event accumulation)
- **Files touched**: `use-drip-feed.ts`, `use-drip-feed.test.ts`, `client-analysis-progress.tsx`
- **Risk**: Low — pure client-side timing change, no API changes, no data model changes
