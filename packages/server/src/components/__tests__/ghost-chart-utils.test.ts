import { describe, it, expect } from 'vitest';
import {
  hashString,
  seededRandom,
  applyJitter,
  effortToRadius,
  beeswarmLayout,
  ghostFill,
  heatColor,
  LARGE_SET_THRESHOLD,
} from '../ghost-chart-utils';

/* ================================================================
 * hashString
 * ================================================================ */

describe('hashString', () => {
  it('returns same value for same input', () => {
    expect(hashString('test@example.com')).toBe(hashString('test@example.com'));
  });

  it('returns different values for different inputs', () => {
    expect(hashString('a@b.com')).not.toBe(hashString('c@d.com'));
  });

  it('returns 0 for empty string', () => {
    expect(hashString('')).toBe(0);
  });
});

/* ================================================================
 * seededRandom
 * ================================================================ */

describe('seededRandom', () => {
  it('returns value between 0 and 1', () => {
    const val = seededRandom(42);
    expect(val).toBeGreaterThanOrEqual(0);
    expect(val).toBeLessThan(1);
  });

  it('is deterministic', () => {
    expect(seededRandom(42)).toBe(seededRandom(42));
  });

  it('produces different values for different seeds', () => {
    expect(seededRandom(1)).not.toBe(seededRandom(2));
  });
});

/* ================================================================
 * applyJitter
 * ================================================================ */

describe('applyJitter', () => {
  it('same email produces same offset regardless of array position', () => {
    const p1 = [
      { x: 1, y: 50, email: 'a@b.com' },
      { x: 2, y: 60, email: 'c@d.com' },
    ];
    const p2 = [
      { x: 2, y: 60, email: 'c@d.com' },
      { x: 1, y: 50, email: 'a@b.com' },
    ];
    const j1 = applyJitter(p1, 10);
    const j2 = applyJitter(p2, 10);
    // a@b.com should have same jitter in both arrays
    expect(j1[0].x).toBe(j2[1].x);
    expect(j1[0].y).toBe(j2[1].y);
  });

  it('uses stronger jitter for large sets', () => {
    const points = [{ x: 5, y: 100, email: 'test@example.com' }];
    const small = applyJitter(points, 10);
    const large = applyJitter(points, 50);
    // Large set jitter should produce different offset than small set
    const smallDx = Math.abs(small[0].x - 5);
    const largeDx = Math.abs(large[0].x - 5);
    // We can at least verify the function runs without error and returns correct length
    expect(small).toHaveLength(1);
    expect(large).toHaveLength(1);
    // Large jitter range is wider (0.3 vs 0.08), so displacement should differ
    // unless seeded random produces exactly 0.5
    expect(largeDx).not.toBe(smallDx);
  });

  it('preserves extra properties on points', () => {
    const points = [{ x: 1, y: 2, email: 'a@b.com', extra: 'kept' }];
    const result = applyJitter(points, 5);
    expect(result[0].extra).toBe('kept');
  });

  it('returns empty array for empty input', () => {
    expect(applyJitter([], 0)).toEqual([]);
  });
});

/* ================================================================
 * effortToRadius
 * ================================================================ */

describe('effortToRadius', () => {
  it('returns fixed 5 when isLarge is true', () => {
    expect(effortToRadius(100, 200, true)).toBe(5);
    expect(effortToRadius(0, 200, true)).toBe(5);
  });

  it('returns sqrt-scaled radius when isLarge is false', () => {
    const r = effortToRadius(100, 100, false);
    // At max effort, ratio = sqrt(1) = 1, so radius = 6 + 1 * 34 = 40
    expect(r).toBe(40);
  });

  it('returns 8 when maxEffort is 0', () => {
    expect(effortToRadius(0, 0, false)).toBe(8);
  });

  it('returns MIN_R for zero effort', () => {
    const r = effortToRadius(0, 100, false);
    // ratio = sqrt(0/100) = 0, so radius = 6 + 0 = 6
    expect(r).toBe(6);
  });

  it('scales between MIN_R and MAX_R', () => {
    const r = effortToRadius(25, 100, false);
    // ratio = sqrt(0.25) = 0.5, so radius = 6 + 0.5 * 34 = 23
    expect(r).toBe(23);
  });
});

/* ================================================================
 * LARGE_SET_THRESHOLD
 * ================================================================ */

describe('LARGE_SET_THRESHOLD', () => {
  it('is 30', () => {
    expect(LARGE_SET_THRESHOLD).toBe(30);
  });
});

/* ================================================================
 * beeswarmLayout
 * ================================================================ */

describe('beeswarmLayout', () => {
  it('returns center y=0 for single point', () => {
    const result = beeswarmLayout([{ ghostPercent: 50 }]);
    expect(result).toEqual([{ x: 50, y: 0 }]);
  });

  it('alternates above/below for points in same bin', () => {
    const points = [
      { ghostPercent: 100 },
      { ghostPercent: 101 },
      { ghostPercent: 102 },
    ];
    const result = beeswarmLayout(points, 5);
    // All fall in bin 100
    expect(result[0].y).toBe(0);      // first: center
    // second and third alternate around center
    expect(Math.abs(result[1].y)).toBe(1);
    expect(Math.abs(result[2].y)).toBe(1);
  });

  it('preserves original x values (ghostPercent)', () => {
    const points = [
      { ghostPercent: 100 },
      { ghostPercent: 101 },
      { ghostPercent: 102 },
    ];
    const result = beeswarmLayout(points, 5);
    expect(result[0].x).toBe(100);
    expect(result[1].x).toBe(101);
    expect(result[2].x).toBe(102);
  });

  it('separates points in different bins', () => {
    const points = [
      { ghostPercent: 50 },
      { ghostPercent: 150 },
    ];
    const result = beeswarmLayout(points, 5);
    expect(result[0].x).toBe(50);
    expect(result[1].x).toBe(150);
    expect(result[0].y).toBe(0);
    expect(result[1].y).toBe(0);
  });

  it('handles empty array', () => {
    expect(beeswarmLayout([])).toEqual([]);
  });

  it('uses default binWidth of 5', () => {
    // Points 0 and 2 both round to bin 0 with binWidth=5
    const points = [{ ghostPercent: 0 }, { ghostPercent: 2 }];
    const result = beeswarmLayout(points);
    // Both in bin 0, second point should be offset
    expect(result[0].y).toBe(0);
    expect(result[1].y).toBe(-1);
  });
});

/* ================================================================
 * ghostFill
 * ================================================================ */

describe('ghostFill', () => {
  it('returns green for percent >= 100', () => {
    expect(ghostFill(100)).toBe('#22c55e');
    expect(ghostFill(150)).toBe('#22c55e');
  });

  it('returns yellow for percent 80-99', () => {
    expect(ghostFill(80)).toBe('#eab308');
    expect(ghostFill(99)).toBe('#eab308');
  });

  it('returns red for percent < 80', () => {
    expect(ghostFill(79)).toBe('#ef4444');
    expect(ghostFill(0)).toBe('#ef4444');
  });
});

/* ================================================================
 * heatColor
 * ================================================================ */

describe('heatColor', () => {
  it('returns green rgba for percent >= 100', () => {
    const color = heatColor(150);
    expect(color).toContain('34, 197, 94');
  });

  it('returns yellow rgba for percent 80-99', () => {
    const color = heatColor(90);
    expect(color).toContain('234, 179, 8');
  });

  it('returns red rgba for percent < 80', () => {
    const color = heatColor(50);
    expect(color).toContain('239, 68, 68');
  });

  it('clamps green intensity at max', () => {
    const color200 = heatColor(200);
    const color300 = heatColor(300);
    expect(color200).toBe(color300);
  });

  it('returns minimum green opacity at boundary 100', () => {
    const color = heatColor(100);
    expect(color).toBe('rgba(34, 197, 94, 0.2)');
  });

  it('returns yellow at boundary 80', () => {
    // intensity = (100-80)/20 = 1, alpha = 0.2 + 1*0.4 = 0.6
    const color = heatColor(80);
    expect(color).toContain('234, 179, 8');
  });

  it('returns red with max alpha for percent = 0', () => {
    // intensity = (80-0)/80 = 1, alpha = 0.2 + 1*0.6 = 0.8
    const color = heatColor(0);
    expect(color).toBe('rgba(239, 68, 68, 0.8)');
  });

  it('returns green with max alpha for percent = 200', () => {
    const color = heatColor(200);
    expect(color).toBe('rgba(34, 197, 94, 0.8)');
  });
});
