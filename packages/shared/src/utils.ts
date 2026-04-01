import Decimal from 'decimal.js';
import { GHOST_NORM, MIN_WORK_DAYS_FOR_GHOST, GHOST_THRESHOLDS, MIN_CUSTOM_RANGE_DAYS, MAX_DAILY_EFFORT, MAX_SPREAD_DAYS } from './constants';
import type { GhostEligiblePeriod, PeriodType } from './types';

export function calcGhostPercentRaw(
  totalEffortHours: number,
  actualWorkDays: number,
): number | null {
  if (actualWorkDays < MIN_WORK_DAYS_FOR_GHOST) return null;
  const avgDaily = totalEffortHours / actualWorkDays;
  return (avgDaily / GHOST_NORM) * 100;
}

export function calcGhostPercent(
  totalEffortHours: number,
  actualWorkDays: number,
  share: number,
): number | null {
  if (actualWorkDays < MIN_WORK_DAYS_FOR_GHOST) return null;
  if (share <= 0) return null;
  const avgDaily = totalEffortHours / actualWorkDays;
  return (avgDaily / (GHOST_NORM * share)) * 100;
}

export function ghostColor(percent: number | null): 'green' | 'yellow' | 'red' | 'gray' {
  if (percent === null) return 'gray';
  if (percent >= GHOST_THRESHOLDS.GOOD) return 'green';
  if (percent >= GHOST_THRESHOLDS.WARNING) return 'yellow';
  return 'red';
}

export function formatGhostPercent(percent: number | null): string {
  if (percent === null) return 'N/A';
  return `${Math.round(percent)}%`;
}

export function isGhostEligiblePeriod(period: PeriodType): period is GhostEligiblePeriod {
  return ['ALL_TIME', 'YEAR', 'QUARTER', 'MONTH'].includes(period);
}

export function isCustomRangeEligible(startDate: Date, endDate: Date): boolean {
  const diffMs = endDate.getTime() - startDate.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= MIN_CUSTOM_RANGE_DAYS;
}

export function calcAutoShare(
  commitsInThisOrder: number,
  totalCommitsAcrossAllOrders: number,
): number {
  if (totalCommitsAcrossAllOrders === 0) return 1.0;
  if (commitsInThisOrder >= totalCommitsAcrossAllOrders) return 1.0;
  return commitsInThisOrder / totalCommitsAcrossAllOrders;
}

/**
 * Compute FTE (Full-Time Employee) working days for a developer.
 *
 * Period: min(dayMapKeys) to max(commitDates).
 * Counts all weekdays in that range + weekend days present in dayMapKeys.
 */
export function computeFteDays(dayMapKeys: string[], commitDates: Date[]): number {
  if (dayMapKeys.length === 0 || commitDates.length === 0) return 0;

  const dayMapSet = new Set(dayMapKeys);

  const sortedKeys = [...dayMapKeys].sort();
  const periodStart = sortedKeys[0];

  const maxCommitMs = Math.max(...commitDates.map(d => d.getTime()));
  const maxCommitDate = new Date(maxCommitMs);
  const periodEnd = maxCommitDate.toISOString().slice(0, 10);

  const effectiveEnd = sortedKeys[sortedKeys.length - 1] > periodEnd
    ? sortedKeys[sortedKeys.length - 1]
    : periodEnd;

  let count = 0;
  const current = new Date(periodStart + 'T00:00:00Z');
  const endDate = new Date(effectiveEnd + 'T00:00:00Z');

  while (current <= endDate) {
    const dow = current.getUTCDay();
    const dateStr = current.toISOString().slice(0, 10);

    if (dow !== 0 && dow !== 6) {
      count++;
    } else if (dayMapSet.has(dateStr)) {
      count++;
    }

    current.setUTCDate(current.getUTCDate() + 1);
  }

  return count;
}

// ==================== Effort Spreading Algorithm ====================

/** Input commit for spreading */
export interface SpreadCommit {
  sha: string;
  authorDate: Date;
  effortHours: number;
}

/** Output: a single DailyEffort row */
export interface DailyEffortRow {
  date: string;           // YYYY-MM-DD
  effortHours: number;    // placed hours (2 decimal places)
  sourceCommitHash: string;
  sourceCommitDate: Date;
}

/** Full result of spreadEffort */
export interface SpreadResult {
  dayMap: Map<string, number>;       // date -> total placed hours
  totalOverhead: number;             // hours that couldn't be placed
  dailyEffortRows: DailyEffortRow[]; // rows for DB storage
}

/** Day-aggregated entry (internal) */
interface DayEntry {
  date: string;             // YYYY-MM-DD (UTC)
  effortHours: Decimal;
  commits: SpreadCommit[];
}

/** Tracks per-entry allocation to calendar days (for Phase 2 attribution) */
interface EntryAllocation {
  entry: DayEntry;
  dayAlloc: Map<string, Decimal>; // calendar day -> hours from THIS entry
}

// ---- Helper: UTC date string from Date ----

function toUTCDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ---- Helper: Parse YYYY-MM-DD to Date (UTC midnight) ----

function parseDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// ---- Helper: Add days to a date string ----

function addDays(dateStr: string, days: number): string {
  const d = parseDateStr(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return toUTCDateStr(d);
}

// ---- Helper: Is weekend (0=Sun, 6=Sat) ----

function isWeekend(dateStr: string): boolean {
  const d = parseDateStr(dateStr);
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Collect candidate days going backwards from entryDate.
 * Boundary check has STRICT PRIORITY over weekend logic.
 *
 * Rules:
 * 1. Entry's own date is ALWAYS included (even weekends)
 * 2. Boundary check runs BEFORE weekend skip — never walk past boundary
 * 3. Boundary is exclusive (stop if candidate <= boundary), except own day
 */
export function collectDaysBack(
  entryDate: string,
  boundary: string | null,
  maxCount: number,
): string[] {
  const days: string[] = [];
  let candidate = entryDate;
  let isFirst = true;

  while (days.length < maxCount) {
    // PRIORITY 1: Boundary check (always first)
    // String comparison is safe: YYYY-MM-DD format sorts lexicographically = chronologically
    if (boundary !== null && candidate <= boundary && !isFirst) {
      break;
    }

    // PRIORITY 2: Weekend filtering (only after boundary is clear)
    if (!isFirst) {
      if (isWeekend(candidate)) {
        candidate = addDays(candidate, -1);
        continue;
      }
    }

    days.push(candidate);
    isFirst = false;
    candidate = addDays(candidate, -1);
  }

  return days;
}

/**
 * Distribute total evenly across n buckets with penny-spread remainder.
 * Any bucket > MAX_DAILY_EFFORT gets clamped; excess is overflow.
 */
export function distributeEvenly(
  total: Decimal,
  n: number,
  maxDaily: Decimal = new Decimal(MAX_DAILY_EFFORT),
): { allocations: Decimal[]; overflow: Decimal } {
  const base = total.div(n).toDecimalPlaces(2, Decimal.ROUND_FLOOR);
  const result: Decimal[] = Array.from({ length: n }, () => new Decimal(base));

  // Remainder in cents (integer 0..n-1)
  const remainderCents = total.minus(base.times(n)).times(100).round().toNumber();

  // Spread remainder: +0.01 to first remainderCents buckets
  for (let i = 0; i < remainderCents; i++) {
    result[i] = result[i].plus('0.01');
  }

  // Clamp: any bucket > maxDaily -> excess is real overhead
  let overflow = new Decimal(0);
  for (let i = 0; i < n; i++) {
    if (result[i].gt(maxDaily)) {
      overflow = overflow.plus(result[i].minus(maxDaily));
      result[i] = new Decimal(maxDaily);
    }
  }

  return { allocations: result, overflow };
}

/**
 * Distribute total pro-rata among commits based on their effort shares.
 * Commits sorted by SHA ASC; last commit absorbs rounding remainder.
 */
export function distributeProRata(
  total: Decimal,
  shares: { sha: string; effort: Decimal }[],
): { sha: string; hours: Decimal }[] {
  if (shares.length === 0) return [];
  if (shares.length === 1) {
    return [{ sha: shares[0].sha, hours: total }];
  }

  const sorted = [...shares].sort((a, b) => a.sha.localeCompare(b.sha));
  const totalEffort = sorted.reduce((sum, s) => sum.plus(s.effort), new Decimal(0));

  if (totalEffort.isZero()) {
    // Edge case: all efforts are zero — distribute equally
    const each = total.div(sorted.length).toDecimalPlaces(2, Decimal.ROUND_FLOOR);
    const result: { sha: string; hours: Decimal }[] = [];
    let allocated = new Decimal(0);
    for (let i = 0; i < sorted.length - 1; i++) {
      result.push({ sha: sorted[i].sha, hours: each });
      allocated = allocated.plus(each);
    }
    result.push({ sha: sorted[sorted.length - 1].sha, hours: total.minus(allocated) });
    return result;
  }

  const result: { sha: string; hours: Decimal }[] = [];
  let allocated = new Decimal(0);

  for (let i = 0; i < sorted.length - 1; i++) {
    const hours = total.times(sorted[i].effort).div(totalEffort).toDecimalPlaces(2, Decimal.ROUND_FLOOR);
    result.push({ sha: sorted[i].sha, hours });
    allocated = allocated.plus(hours);
  }

  // Last commit absorbs remainder (guaranteed non-negative by floor rounding, defensive guard)
  const remainder = Decimal.max(new Decimal(0), total.minus(allocated));
  result.push({ sha: sorted[sorted.length - 1].sha, hours: remainder });

  return result;
}

/**
 * Main entry point: spread effort for a list of commits (single developer).
 *
 * Phase 1: Aggregate by UTC date, spread via dayMap
 * Phase 2: Attribute back to commits via distributeProRata
 *
 * Returns dayMap, totalOverhead, and DailyEffort rows.
 */
export function spreadEffort(commits: SpreadCommit[]): SpreadResult {
  if (commits.length === 0) {
    return { dayMap: new Map(), totalOverhead: 0, dailyEffortRows: [] };
  }

  const maxDaily = new Decimal(MAX_DAILY_EFFORT);

  // ---- Pre-processing: group commits by UTC date ----
  const grouped = new Map<string, SpreadCommit[]>();
  for (const c of commits) {
    const dateStr = toUTCDateStr(c.authorDate);
    if (!grouped.has(dateStr)) grouped.set(dateStr, []);
    grouped.get(dateStr)!.push(c);
  }

  // Build entries sorted by date ASC
  const entries: DayEntry[] = [];
  for (const [date, groupCommits] of grouped) {
    const effortHours = groupCommits.reduce(
      (sum, c) => sum.plus(new Decimal(c.effortHours)),
      new Decimal(0),
    );
    entries.push({ date, effortHours, commits: groupCommits });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));

  // ---- Phase 1: Spreading (dayMap computation) ----
  const dayMap = new Map<string, Decimal>();
  let totalOverhead = new Decimal(0);
  const entryAllocations: EntryAllocation[] = [];

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx];
    const effort = entry.effortHours;

    // Guard: skip zero/negative effort
    if (effort.lte(0)) {
      entryAllocations.push({ entry, dayAlloc: new Map() });
      continue;
    }

    const boundary = idx > 0 ? entries[idx - 1].date : null;

    // A+ soft boundary: get full 5-day window, then split into
    // priority (after boundary) and spillover (at/before boundary)
    const allDays = collectDaysBack(entry.date, null, MAX_SPREAD_DAYS);
    const priorityDays = boundary === null
      ? allDays
      : allDays.filter(d => d > boundary);
    const spilloverDays = boundary === null
      ? []
      : allDays.filter(d => d <= boundary);

    const entryDayAlloc = new Map<string, Decimal>();
    let remaining = new Decimal(effort);

    // ---- Step 1: Priority days (even distribution preferred) ----
    if (priorityDays.length > 0 && remaining.gt(0)) {
      const hasOverlap = priorityDays.some(d => {
        const val = dayMap.get(d);
        return val !== undefined && val.gt(0);
      });

      if (!hasOverlap) {
        let n = remaining.div(maxDaily).ceil().toNumber();
        n = Math.min(n, priorityDays.length);
        const perDay = remaining.div(n);

        if (perDay.gt(maxDaily)) {
          // Fill all priority days to max, remaining spills over
          for (const d of priorityDays) {
            dayMap.set(d, new Decimal(maxDaily));
            entryDayAlloc.set(d, new Decimal(maxDaily));
          }
          remaining = remaining.minus(maxDaily.times(priorityDays.length));
        } else {
          const { allocations, overflow } = distributeEvenly(remaining, n, maxDaily);
          for (let i = 0; i < n; i++) {
            dayMap.set(priorityDays[i], allocations[i]);
            entryDayAlloc.set(priorityDays[i], allocations[i]);
          }
          remaining = overflow;
        }
      } else {
        // Greedy fill priority days (defensive — shouldn't happen in normal flow)
        for (const d of priorityDays) {
          const current = dayMap.get(d) ?? new Decimal(0);
          const available = maxDaily.minus(current);
          if (available.lte(0)) continue;
          const fill = Decimal.min(remaining, available);
          dayMap.set(d, current.plus(fill));
          entryDayAlloc.set(d, (entryDayAlloc.get(d) ?? new Decimal(0)).plus(fill));
          remaining = remaining.minus(fill);
          if (remaining.lte(0)) break;
        }
      }
    }

    // ---- Step 2: Spillover into days at/before boundary (greedy fill) ----
    if (remaining.gt(0) && spilloverDays.length > 0) {
      for (const d of spilloverDays) {
        const current = dayMap.get(d) ?? new Decimal(0);
        const available = maxDaily.minus(current);
        if (available.lte(0)) continue;
        const fill = Decimal.min(remaining, available);
        dayMap.set(d, current.plus(fill));
        entryDayAlloc.set(d, (entryDayAlloc.get(d) ?? new Decimal(0)).plus(fill));
        remaining = remaining.minus(fill);
        if (remaining.lte(0)) break;
      }
    }

    // ---- Remaining = real overhead (capacity exhausted in full window) ----
    if (remaining.gt(0)) {
      totalOverhead = totalOverhead.plus(remaining);
    }

    entryAllocations.push({ entry, dayAlloc: entryDayAlloc });
  }

  // ---- Phase 2: Attribution (commit-level DailyEffort rows) ----
  const dailyEffortRows: DailyEffortRow[] = [];

  for (const { entry, dayAlloc } of entryAllocations) {
    if (dayAlloc.size === 0) continue;

    const shares = entry.commits.map(c => ({
      sha: c.sha,
      effort: new Decimal(c.effortHours),
    }));

    for (const [day, allocHours] of dayAlloc) {
      if (allocHours.lte(0)) continue;

      if (shares.length === 1) {
        // Single commit — no pro-rata needed
        dailyEffortRows.push({
          date: day,
          effortHours: allocHours.toDecimalPlaces(2).toNumber(),
          sourceCommitHash: shares[0].sha,
          sourceCommitDate: entry.commits[0].authorDate,
        });
      } else {
        // Multi-commit — distribute pro-rata
        const attributed = distributeProRata(allocHours, shares);
        for (const { sha, hours } of attributed) {
          if (hours.lte(0)) continue;
          const commit = entry.commits.find(c => c.sha === sha)!;
          dailyEffortRows.push({
            date: day,
            effortHours: hours.toDecimalPlaces(2).toNumber(),
            sourceCommitHash: sha,
            sourceCommitDate: commit.authorDate,
          });
        }
      }
    }
  }

  // Convert dayMap from Decimal to number for output
  const dayMapOut = new Map<string, number>();
  for (const [k, v] of dayMap) {
    dayMapOut.set(k, v.toDecimalPlaces(2).toNumber());
  }

  return {
    dayMap: dayMapOut,
    totalOverhead: totalOverhead.toDecimalPlaces(2).toNumber(),
    dailyEffortRows,
  };
}
