# FTE Metrics Mode

## Summary

New display mode for Ghost% metrics that calculates developer efficiency as if they worked full-time for the entire period from first to last commit, instead of only counting days with spread effort.

## Motivation

Current "Spread" mode counts only days where effort was placed by the spreading algorithm. This rewards burst activity — a developer who commits heavily in 3 days looks more productive per-day than one who works steadily across 20 days. FTE mode provides a complementary view: what would Ghost% look like if this developer was a full-time employee for the entire period?

## Scope

FTE mode applies **only to the order results page** (`/orders/[id]`). Public dashboards, developer profiles, explore pages, and publication metrics are out of scope and will not display FTE data.

## Formula

### FTE Days

```
periodStart = min(dayMap keys)        // earliest spread day (includes backward spread from first commit)
periodEnd   = max(commit dates)       // last commit date

fteDays = weekdays(periodStart, periodEnd)
        + weekend days present in dayMap   // weekends when commits were made
```

Weekend days in dayMap = commit dates that fall on weekends (spreading always includes the commit's own date, even on weekends, but does not spread backward onto weekends).

### FTE Ghost%

```
avgDaily_fte     = totalEffortHours / fteDays
ghostRaw_fte     = (avgDaily_fte / GHOST_NORM) * 100
ghostPercent_fte = (avgDaily_fte / (GHOST_NORM * share)) * 100
```

- `totalEffortHours` — full sum of LLM estimates (includes overhead, since it's raw commit effort)
- `GHOST_NORM = 3.0` (unchanged)
- `share` — same as current mode (auto or manual)

## Schema Changes

New fields in `OrderMetric`:

```prisma
fteWorkDays         Int        @default(0)
fteAvgDailyEffort   Decimal    @db.Decimal(10, 4) @default(0)
fteGhostPercentRaw  Decimal?   @db.Decimal(10, 2)
fteGhostPercent     Decimal?   @db.Decimal(10, 2)
```

Nullable Ghost% fields — null when `fteDays = 0` or `share <= 0`.

No new tables. FTE reuses existing DailyEffort and CommitAnalysis data.

## Shared Package

### `computeFteDays()`

New function in `@devghost/shared`:

```ts
computeFteDays(dayMapKeys: string[], commitDates: Date[]): number
```

- `dayMapKeys` — date strings from dayMap (YYYY-MM-DD, UTC)
- `commitDates` — author dates of all commits
- Returns: count of FTE working days

Logic:
1. `periodStart = min(dayMapKeys)`
2. `periodEnd = max(commitDates)` as YYYY-MM-DD UTC
3. Iterate from periodStart to periodEnd:
   - If weekday (Mon-Fri): count it
   - If weekend: count only if date is in dayMapKeys set
4. Return count

### `GhostMetric` type extension

FTE fields are **optional** in `GhostMetric`:

```ts
// existing fields unchanged...

// FTE mode (optional — only populated on order results page)
fteWorkDays?: number;
fteAvgDailyEffort?: number;
fteGhostPercentRaw?: number | null;
fteGhostPercent?: number | null;
```

Optional because `GhostMetric` is used across multiple paths (order page, public profiles via `publication-metrics.ts`, dev profiles). Only the order metrics API guarantees these fields are present; other consumers (publications, explore) do not populate them.

The `GET /api/orders/[id]/metrics` endpoint always returns all four FTE fields (non-optional in that response).

## Service Changes

### New analysis (`saveDeveloperMetric()`)

After `spreadEffort()`:

```
fteDays = computeFteDays(Array.from(dayMap.keys()), commits.map(c => c.authorDate))
avgDaily_fte = totalEffort / fteDays
fteGhostRaw = calcGhostPercentRaw(totalEffort, fteDays)    // reuse existing function with fteDays
fteGhost = calcGhostPercent(totalEffort, fteDays, share)    // reuse existing function with fteDays
```

Note: `calcGhostPercentRaw(totalEffort, fteDays)` works because the function is `(totalEffortHours / days) / GHOST_NORM * 100` — we just pass fteDays instead of workDays.

Save all four FTE fields to OrderMetric alongside existing fields.

### Recalculation (`recalculateFteForOrder(orderId)`)

New method in GhostMetricsService:

1. Use `loadOrderScope()` + `getInScopeCommits()` — identical scope filtering as `calculateAndSaveBatch()` — to get the canonical commit set (excludes benchmark jobs, respects period/date range scope)
2. Load all `OrderMetric` records for order
3. For each metric record (keyed by `email + periodType + year + month` — the full unique identity from schema):
   a. Filter in-scope commits for this developer + period bucket
   b. Load unique dates from `DailyEffort` for this developer + period bucket (these are the dayMap dates)
   c. `fteDays = computeFteDays(dailyEffortDates, commitDates)`
   d. `avgDaily = totalEffortHours / fteDays`
   e. Compute FTE Ghost% using existing calc functions with the metric's existing `share` and `totalEffortHours`
   f. Update OrderMetric FTE fields

## API Changes

### GET `/api/orders/[id]/metrics`

Response gains four fields per metric:

```ts
{
  // existing (unchanged)
  ghostPercent, ghostPercentRaw, actualWorkDays, avgDailyEffort, ...

  // new (always present in this endpoint)
  fteWorkDays: number,
  fteAvgDailyEffort: number,
  fteGhostPercentRaw: number | null,
  fteGhostPercent: number | null,
}
```

Both sets always returned. Client chooses which to display.

### POST `/api/orders/[id]/recalculate-fte`

- Auth: order owner or admin (`getOrderWithAuth()`)
- Calls `recalculateFteForOrder(orderId)`
- Returns: `{ updated: number }` — count of updated OrderMetric records

## UI Changes

### Data transformation approach

Toggle state lives at the page level (`page.tsx`). Instead of modifying each child component, a single transform function swaps FTE values into the standard fields before passing metrics downstream:

```ts
function applyFteView(metrics: GhostMetric[]): GhostMetric[] {
  return metrics.map(m => ({
    ...m,
    actualWorkDays: m.fteWorkDays ?? m.actualWorkDays,
    avgDailyEffort: m.fteAvgDailyEffort ?? m.avgDailyEffort,
    ghostPercentRaw: m.fteGhostPercentRaw ?? m.ghostPercentRaw,
    ghostPercent: m.fteGhostPercent ?? m.ghostPercent,
    hasEnoughData: (m.fteWorkDays ?? 0) >= MIN_WORK_DAYS_FOR_GHOST,
  }));
}
```

`hasEnoughData` is recalculated from `fteWorkDays` so eligibility reflects FTE days, not spread days.

All downstream components (`AnalysisResultsSummary`, `GhostKpiCards`, `AnalysisResultsOverview`, `GhostDistributionPanel`, `GhostBubbleChart`, `GhostStripChart`, `GhostDeveloperTable`) receive already-transformed metrics — **zero changes in child components**.

Median norm calculation in `AnalysisResultsOverview` automatically uses `fteAvgDailyEffort` because it reads from `m.avgDailyEffort` which has been swapped.

### Toggle

- Location: order results page, near period selector (inside `AnalysisResultsOverview` toolbar area)
- States: "Spread" (default) | "FTE"
- Client-side state only (useState), not persisted

### FTE readiness and legacy orders

Toggle is **disabled** when FTE data is not available. Readiness condition:

```ts
const fteReady = metrics.length > 0 && metrics.every(m => (m.fteWorkDays ?? 0) > 0);
```

If `!fteReady`:
- Toggle is disabled with tooltip explaining FTE data is not calculated
- A "Calculate FTE" button is shown next to the toggle
- Button calls `POST /api/orders/[id]/recalculate-fte`, then refetches metrics
- After successful recalc, toggle becomes active

This handles: legacy orders (all zeros), partial backfill (some developers recalculated, others not), and new orders (always have FTE data from analysis).

### Components NOT affected

- **Effort timeline / heatmap** — visualization of effort spreading, remains spread-based even in FTE mode
- **Daily effort drilldown** in developer table — shows placed hours per day, stays spread-based
- **overheadHours display** — remains spread-based (overhead is a property of the spreading algorithm, not FTE)
- **CommitAnalysis / raw commit estimates** — unchanged
- **Share% settings and logic** — unchanged

## Edge Cases

- **Single commit:** fteDays = 1 (just the commit date), same as current workDays
- **All commits on same day:** fteDays = 1
- **Period with no weekday commits:** only weekend days in dayMap counted
- **fteDays = 0:** ghostPercent_fte = null (shouldn't happen if there are commits)
- **Existing orders without FTE fields:** toggle disabled, "Calculate FTE" button shown
- **Partial backfill:** readiness requires ALL metrics to have fteWorkDays > 0
