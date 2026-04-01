import { describe, it, expect } from 'vitest';
import { calcGhostPercentRaw, calcGhostPercent, calcAutoShare, computeFteDays } from '../utils';

describe('Ghost % calculation (GHOST_NORM=3)', () => {
  it('returns null when work days below minimum', () => {
    // MIN_WORK_DAYS_FOR_GHOST = 1, so 0 days → null
    expect(calcGhostPercentRaw(20, 0)).toBeNull();
  });

  it('calculates correct Ghost % for exact norm', () => {
    // 60h effort / 20 days = 3h/day = 100% Ghost (norm=3)
    expect(calcGhostPercentRaw(60, 20)).toBe(100);
  });

  it('calculates Ghost % above norm', () => {
    // 72h effort / 20 days = 3.6h/day = 120% Ghost (norm=3)
    expect(calcGhostPercentRaw(72, 20)).toBe(120);
  });

  it('calculates Ghost % below norm', () => {
    // 45h effort / 20 days = 2.25h/day = 75% Ghost (norm=3)
    expect(calcGhostPercentRaw(45, 20)).toBe(75);
  });

  it('adjusts for share', () => {
    // 30h effort / 20 days = 1.5h/day, share=0.5 -> norm=1.5h -> 100%
    expect(calcGhostPercent(30, 20, 0.5)).toBe(100);
  });

  it('returns null for zero share', () => {
    expect(calcGhostPercent(40, 20, 0)).toBeNull();
  });
});

describe('Share auto-calculation', () => {
  it('returns 1.0 when only one order', () => {
    expect(calcAutoShare(50, 50)).toBe(1.0);
  });

  it('calculates correct share for multi-order', () => {
    expect(calcAutoShare(60, 100)).toBe(0.6);
  });

  it('returns 1.0 for zero total commits', () => {
    expect(calcAutoShare(0, 0)).toBe(1.0);
  });
});

describe('computeFteDays', () => {
  it('counts weekdays in range plus weekend days in dayMap', () => {
    // Mon 2026-01-05 to Fri 2026-01-09 = 5 weekdays, no weekend days in map
    const dayMapKeys = ['2026-01-05', '2026-01-06', '2026-01-07'];
    const commitDates = [new Date('2026-01-09T12:00:00Z')];
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(5);
  });

  it('includes weekend days that appear in dayMap', () => {
    const dayMapKeys = ['2026-01-05', '2026-01-10']; // Mon + Sat
    const commitDates = [new Date('2026-01-11T12:00:00Z')]; // Sun (not in dayMap)
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(6);
  });

  it('handles spread days before first commit', () => {
    const dayMapKeys = ['2026-01-01', '2026-01-02'];
    const commitDates = [new Date('2026-01-05T12:00:00Z')];
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(3);
  });

  it('returns 1 for single commit on a weekday', () => {
    const dayMapKeys = ['2026-01-05'];
    const commitDates = [new Date('2026-01-05T12:00:00Z')];
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(1);
  });

  it('returns 1 for single commit on a weekend day in dayMap', () => {
    const dayMapKeys = ['2026-01-10'];
    const commitDates = [new Date('2026-01-10T12:00:00Z')];
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(1);
  });

  it('returns 0 for empty inputs', () => {
    expect(computeFteDays([], [])).toBe(0);
  });

  it('uses periodEnd from commitDates even if after last dayMap key', () => {
    const dayMapKeys = ['2026-01-05'];
    const commitDates = [new Date('2026-01-07T12:00:00Z')];
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(3);
  });

  it('handles multi-week period correctly', () => {
    const dayMapKeys = ['2026-01-05', '2026-01-10']; // Mon + Sat
    const commitDates = [new Date('2026-01-16T12:00:00Z')]; // Fri
    expect(computeFteDays(dayMapKeys, commitDates)).toBe(11);
  });
});
