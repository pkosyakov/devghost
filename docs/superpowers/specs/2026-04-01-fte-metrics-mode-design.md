# FTE Metrics Mode

## Summary

New display mode for Ghost% metrics that calculates developer efficiency as if they worked full-time for the entire period from first to last commit, instead of only counting days with spread effort.

## Motivation

Current "Spread" mode counts only days where effort was placed by the spreading algorithm. This rewards burst activity — a developer who commits heavily in 3 days looks more productive per-day than one who works steadily across 20 days. FTE mode provides a complementary view: what would Ghost% look like if this developer was a full-time employee for the entire period?

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

1. Load all `OrderMetric` records for order
2. For each developer (by email + periodType):
   a. Load unique dates from `DailyEffort` (these are the dayMap dates)
   b. Load commit dates from `CommitAnalysis`
   c. `fteDays = computeFteDays(dailyEffortDates, commitDates)`
   d. `avgDaily = totalEffortHours / fteDays`
   e. Compute FTE Ghost% using existing calc functions
   f. Update OrderMetric record

## API Changes

### GET `/api/orders/[id]/metrics`

Response gains four fields per metric:

```ts
{
  // existing (unchanged)
  ghostPercent, ghostPercentRaw, actualWorkDays, avgDailyEffort, ...

  // new
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

### Toggle

- Location: order results page, near period selector
- States: "Spread" (default) | "FTE"
- Client-side state only (useState), not persisted

### Components affected

**GhostKpiCards:** When FTE active, display `fteGhostPercent` / `fteWorkDays` instead of `ghostPercent` / `workDays`.

**GhostDeveloperTable:** Columns Ghost%, work days, avg daily switch to FTE variants.

**Color thresholds:** Same `ghostColor()` function, same thresholds (EXCELLENT >= 120%, GOOD >= 100%, WARNING >= 80%, LOW < 80%).

### Components NOT affected

- Effort timeline / heatmap — visualization of spreading, stays as-is
- CommitAnalysis / raw commit estimates
- Share% settings and logic

## Edge Cases

- **Single commit:** fteDays = 1 (just the commit date), same as current workDays
- **All commits on same day:** fteDays = 1
- **Period with no weekday commits:** only weekend days in dayMap counted
- **fteDays = 0:** ghostPercent_fte = null (shouldn't happen if there are commits)
- **Existing orders without FTE fields:** all default to 0/null until recalculated
