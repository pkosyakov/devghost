/**
 * Pure utility functions for Effort Timeline aggregation.
 * All filtering and grouping happens client-side.
 */

/* ---------- types ---------- */

export interface EffortRow {
  email: string;
  date: string;   // YYYY-MM-DD
  effort: number;
  type: 'placed' | 'overhead';
}

export type Period = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'all_time';

export interface TimelineDeveloper {
  email: string;
  name: string;
}

export interface AggregatedBucket {
  label: string;
  placedHours: number;
  overheadHours: number;
  totalHours: number;
  avgPlacedByActive: number;
  avgOverheadByActive: number;
  avgByActive: number;
  avgByAll: number;
  activeCount: number;
  selectedCount: number;
}

/* ---------- period key ---------- */

/** Return the bucket key for a date string given a period. */
export function periodKey(dateStr: string, period: Period): string {
  if (period === 'all_time') return 'All Time';
  if (period === 'day') return dateStr;

  const [y, m, d] = dateStr.split('-').map(Number);

  if (period === 'month') return `${y}-${String(m).padStart(2, '0')}`;
  if (period === 'year') return String(y);

  if (period === 'quarter') {
    const q = Math.ceil(m / 3);
    return `${y}-Q${q}`;
  }

  // week: ISO 8601 week number
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayOfWeek = date.getUTCDay() || 7; // Mon=1..Sun=7
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 4 - dayOfWeek); // nearest Thursday
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/* ---------- aggregation ---------- */

/**
 * Filter rows by selectedEmails, group by period, compute metrics.
 * Returns buckets sorted chronologically.
 */
export function aggregateEffort(
  rows: EffortRow[],
  period: Period,
  selectedEmails: string[],
): AggregatedBucket[] {
  if (selectedEmails.length === 0) return [];

  const emailSet = new Set(selectedEmails);
  const filtered = rows.filter(r => emailSet.has(r.email));
  if (filtered.length === 0) return [];

  // Group by period key, tracking developer-days for correct h/day averages
  const buckets = new Map<string, {
    placedHours: number;
    overheadHours: number;
    emails: Set<string>;
    devDays: Set<string>;  // "email|date" pairs
    dates: Set<string>;    // distinct calendar days
  }>();
  for (const r of filtered) {
    const key = periodKey(r.date, period);
    const devDayKey = `${r.email}|${r.date}`;
    const bucket = buckets.get(key);
    if (bucket) {
      if (r.type === 'overhead') {
        bucket.overheadHours += r.effort;
      } else {
        bucket.placedHours += r.effort;
      }
      bucket.emails.add(r.email);
      bucket.devDays.add(devDayKey);
      bucket.dates.add(r.date);
    } else {
      buckets.set(key, {
        placedHours: r.type === 'placed' ? r.effort : 0,
        overheadHours: r.type === 'overhead' ? r.effort : 0,
        emails: new Set([r.email]),
        devDays: new Set([devDayKey]),
        dates: new Set([r.date]),
      });
    }
  }

  // Build result sorted by label (chronological for all period formats)
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, { placedHours, overheadHours, emails, devDays, dates }]) => {
      const totalHours = placedHours + overheadHours;
      return {
        label,
        placedHours: Math.round(placedHours * 100) / 100,
        overheadHours: Math.round(overheadHours * 100) / 100,
        totalHours: Math.round(totalHours * 100) / 100,
        avgPlacedByActive: Math.round((placedHours / devDays.size) * 100) / 100,
        avgOverheadByActive: Math.round((overheadHours / devDays.size) * 100) / 100,
        avgByActive: Math.round((totalHours / devDays.size) * 100) / 100,
        activeCount: emails.size,
        selectedCount: selectedEmails.length,
        avgByAll: Math.round((totalHours / (dates.size * selectedEmails.length)) * 100) / 100,
      };
    });
}
