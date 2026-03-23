import { describe, it, expect } from 'vitest';
import { periodKey, aggregateEffort, type EffortRow, type Period } from '../effort-timeline-utils';

/* ================================================================
 * periodKey
 * ================================================================ */

describe('periodKey', () => {
  it('returns YYYY-MM-DD for day', () => {
    expect(periodKey('2024-03-15', 'day')).toBe('2024-03-15');
  });

  it('returns ISO week for week', () => {
    // 2024-03-15 is Friday of ISO week 11
    expect(periodKey('2024-03-15', 'week')).toBe('2024-W11');
  });

  it('returns YYYY-MM for month', () => {
    expect(periodKey('2024-03-15', 'month')).toBe('2024-03');
  });

  it('returns YYYY-Qq for quarter', () => {
    expect(periodKey('2024-01-15', 'quarter')).toBe('2024-Q1');
    expect(periodKey('2024-04-01', 'quarter')).toBe('2024-Q2');
    expect(periodKey('2024-07-31', 'quarter')).toBe('2024-Q3');
    expect(periodKey('2024-10-01', 'quarter')).toBe('2024-Q4');
  });

  it('returns YYYY for year', () => {
    expect(periodKey('2024-06-15', 'year')).toBe('2024');
  });

  it('returns "All Time" for all_time', () => {
    expect(periodKey('2024-06-15', 'all_time')).toBe('All Time');
  });

  it('handles Jan 1 week boundary correctly', () => {
    // 2024-01-01 is Monday of ISO week 1
    expect(periodKey('2024-01-01', 'week')).toBe('2024-W01');
  });

  it('assigns Dec 31 to next year ISO week when applicable', () => {
    // 2024-12-31 is Tuesday, ISO week 1 of 2025
    expect(periodKey('2024-12-31', 'week')).toBe('2025-W01');
  });

  it('assigns Jan 1 to previous year ISO week when applicable', () => {
    // 2023-01-01 is Sunday, ISO week 52 of 2022
    expect(periodKey('2023-01-01', 'week')).toBe('2022-W52');
  });
});

/* ================================================================
 * aggregateEffort
 * ================================================================ */

const sampleRows: EffortRow[] = [
  { email: 'alice@co.com', date: '2024-03-11', effort: 3.0, type: 'placed' },
  { email: 'alice@co.com', date: '2024-03-12', effort: 4.0, type: 'placed' },
  { email: 'bob@co.com',   date: '2024-03-11', effort: 2.0, type: 'placed' },
  { email: 'bob@co.com',   date: '2024-03-13', effort: 1.5, type: 'placed' },
  { email: 'carol@co.com', date: '2024-03-11', effort: 5.0, type: 'placed' },
];

describe('aggregateEffort', () => {
  it('filters by selectedEmails', () => {
    const result = aggregateEffort(sampleRows, 'day', ['alice@co.com']);
    const totalHours = result.reduce((sum, b) => sum + b.totalHours, 0);
    expect(totalHours).toBe(7.0); // 3.0 + 4.0
  });

  it('groups by day', () => {
    const result = aggregateEffort(sampleRows, 'day', ['alice@co.com', 'bob@co.com']);
    expect(result).toHaveLength(3); // 3-11, 3-12, 3-13
    const mar11 = result.find(b => b.label === '2024-03-11')!;
    expect(mar11.totalHours).toBe(5.0); // alice 3 + bob 2
    expect(mar11.activeCount).toBe(2);
    expect(mar11.selectedCount).toBe(2);
    expect(mar11.avgByActive).toBeCloseTo(2.5); // 5/2
    expect(mar11.avgByAll).toBeCloseTo(2.5); // 5/2 (both active)
  });

  it('groups by week', () => {
    // All dates 2024-03-11..13 are in ISO week 11
    const result = aggregateEffort(sampleRows, 'week', ['alice@co.com', 'bob@co.com']);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('2024-W11');
    expect(result[0].totalHours).toBe(10.5); // 3+4+2+1.5
    expect(result[0].activeCount).toBe(2);
    // alice: 2 dev-days (3-11, 3-12), bob: 2 dev-days (3-11, 3-13) = 4 total
    expect(result[0].avgByActive).toBeCloseTo(10.5 / 4); // 2.625 h/day
  });

  it('groups by month', () => {
    const result = aggregateEffort(sampleRows, 'month', ['alice@co.com', 'bob@co.com', 'carol@co.com']);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('2024-03');
    expect(result[0].totalHours).toBe(15.5);
    expect(result[0].activeCount).toBe(3);
  });

  it('groups by all_time', () => {
    const all = ['alice@co.com', 'bob@co.com', 'carol@co.com'];
    const result = aggregateEffort(sampleRows, 'all_time', all);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('All Time');
    expect(result[0].totalHours).toBe(15.5);
  });

  it('computes avgByAll using selectedEmails.length', () => {
    // Select 3 devs, but carol only has 1 day of data
    const all = ['alice@co.com', 'bob@co.com', 'carol@co.com'];
    const result = aggregateEffort(sampleRows, 'day', all);
    const mar12 = result.find(b => b.label === '2024-03-12')!;
    // Only alice is active on 3-12 (4.0h)
    expect(mar12.activeCount).toBe(1);
    expect(mar12.avgByActive).toBeCloseTo(4.0); // 4/1
    expect(mar12.avgByAll).toBeCloseTo(4.0 / 3); // 4/3
    expect(mar12.selectedCount).toBe(3);
  });

  it('returns empty array for empty rows', () => {
    expect(aggregateEffort([], 'day', ['a@b.com'])).toEqual([]);
  });

  it('returns empty array for empty selectedEmails', () => {
    expect(aggregateEffort(sampleRows, 'day', [])).toEqual([]);
  });

  it('computes avgByActive as h/day for multi-day periods', () => {
    // One dev working 3.0 h/day for 5 days in same week
    const rows: EffortRow[] = [
      { email: 'a@b.com', date: '2024-03-11', effort: 3.0, type: 'placed' },
      { email: 'a@b.com', date: '2024-03-12', effort: 3.0, type: 'placed' },
      { email: 'a@b.com', date: '2024-03-13', effort: 3.0, type: 'placed' },
      { email: 'a@b.com', date: '2024-03-14', effort: 3.0, type: 'placed' },
      { email: 'a@b.com', date: '2024-03-15', effort: 3.0, type: 'placed' },
    ];
    const result = aggregateEffort(rows, 'week', ['a@b.com']);
    expect(result[0].totalHours).toBe(15.0);
    // avgByActive must be 3.0 h/day (not 15.0 = total/devCount)
    expect(result[0].avgByActive).toBeCloseTo(3.0);
  });

  it('computes avgByAll using developer-days across all selected', () => {
    // 2 devs selected, 3 active days, but bob only active on 1 day
    const rows: EffortRow[] = [
      { email: 'alice@co.com', date: '2024-03-11', effort: 3.0, type: 'placed' },
      { email: 'alice@co.com', date: '2024-03-12', effort: 3.0, type: 'placed' },
      { email: 'alice@co.com', date: '2024-03-13', effort: 3.0, type: 'placed' },
      { email: 'bob@co.com',   date: '2024-03-11', effort: 2.0, type: 'placed' },
    ];
    const result = aggregateEffort(rows, 'week', ['alice@co.com', 'bob@co.com']);
    // totalHours = 11.0, 3 distinct dates, 2 selected devs
    // avgByAll = 11.0 / (3 * 2) = 1.833...
    expect(result[0].avgByAll).toBeCloseTo(11.0 / 6);
  });

  it('sorts buckets chronologically', () => {
    const rows: EffortRow[] = [
      { email: 'a@b.com', date: '2024-03-15', effort: 1, type: 'placed' },
      { email: 'a@b.com', date: '2024-01-10', effort: 2, type: 'placed' },
      { email: 'a@b.com', date: '2024-06-20', effort: 3, type: 'placed' },
    ];
    const result = aggregateEffort(rows, 'month', ['a@b.com']);
    expect(result.map(b => b.label)).toEqual(['2024-01', '2024-03', '2024-06']);
  });

  it('placed-only rows have overheadHours=0', () => {
    const result = aggregateEffort(sampleRows, 'all_time', ['alice@co.com']);
    expect(result[0].placedHours).toBe(7.0);
    expect(result[0].overheadHours).toBe(0);
    expect(result[0].totalHours).toBe(7.0);
  });

  it('stacked aggregation: placed + overhead sum correctly per bucket', () => {
    const rows: EffortRow[] = [
      { email: 'alice@co.com', date: '2024-03-11', effort: 3.0, type: 'placed' },
      { email: 'alice@co.com', date: '2024-03-11', effort: 1.5, type: 'overhead' },
      { email: 'bob@co.com',   date: '2024-03-11', effort: 2.0, type: 'placed' },
      { email: 'bob@co.com',   date: '2024-03-11', effort: 0.5, type: 'overhead' },
    ];
    const result = aggregateEffort(rows, 'day', ['alice@co.com', 'bob@co.com']);
    expect(result).toHaveLength(1);
    expect(result[0].placedHours).toBe(5.0);
    expect(result[0].overheadHours).toBe(2.0);
    expect(result[0].totalHours).toBe(7.0);
  });

  it('overhead-only rows aggregate correctly', () => {
    const rows: EffortRow[] = [
      { email: 'alice@co.com', date: '2024-03-11', effort: 2.0, type: 'overhead' },
      { email: 'alice@co.com', date: '2024-03-12', effort: 3.0, type: 'overhead' },
    ];
    const result = aggregateEffort(rows, 'week', ['alice@co.com']);
    expect(result).toHaveLength(1);
    expect(result[0].placedHours).toBe(0);
    expect(result[0].overheadHours).toBe(5.0);
    expect(result[0].totalHours).toBe(5.0);
  });

  it('avgByActive uses totalHours (placed + overhead) for h/day', () => {
    const rows: EffortRow[] = [
      { email: 'a@b.com', date: '2024-03-11', effort: 3.0, type: 'placed' },
      { email: 'a@b.com', date: '2024-03-11', effort: 1.0, type: 'overhead' },
      { email: 'a@b.com', date: '2024-03-12', effort: 2.0, type: 'placed' },
      { email: 'a@b.com', date: '2024-03-12', effort: 0.5, type: 'overhead' },
    ];
    const result = aggregateEffort(rows, 'week', ['a@b.com']);
    // totalHours = 6.5, devDays = 2 (2 distinct dates for 1 dev)
    expect(result[0].avgByActive).toBeCloseTo(6.5 / 2);
  });

  it('avgPlacedByActive and avgOverheadByActive split correctly', () => {
    const rows: EffortRow[] = [
      { email: 'a@b.com', date: '2024-03-11', effort: 3.0, type: 'placed' },
      { email: 'a@b.com', date: '2024-03-11', effort: 1.0, type: 'overhead' },
      { email: 'a@b.com', date: '2024-03-12', effort: 2.0, type: 'placed' },
      { email: 'a@b.com', date: '2024-03-12', effort: 0.5, type: 'overhead' },
    ];
    const result = aggregateEffort(rows, 'week', ['a@b.com']);
    // placedHours = 5.0, overheadHours = 1.5, devDays = 2
    expect(result[0].avgPlacedByActive).toBeCloseTo(5.0 / 2);   // 2.5
    expect(result[0].avgOverheadByActive).toBeCloseTo(1.5 / 2);  // 0.75
    // sum should equal avgByActive
    expect(result[0].avgPlacedByActive + result[0].avgOverheadByActive)
      .toBeCloseTo(result[0].avgByActive);
  });
});
