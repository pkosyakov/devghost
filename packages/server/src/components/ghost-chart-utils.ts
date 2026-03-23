/**
 * Pure utility functions shared across ghost chart components.
 * Extracted from ghost-bubble-chart, ghost-strip-chart, and ghost-heatmap
 * for testability and reuse.
 */

import { GHOST_THRESHOLDS } from '@devghost/shared';

/* ---------- constants ---------- */

/** Developer count threshold above which charts switch to compact rendering. */
export const LARGE_SET_THRESHOLD = 30;

/* ---------- hash / seeded random ---------- */

/** Simple hash from string to number for stable per-developer jitter. */
export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function seededRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 49297;
  return x - Math.floor(x);
}

/* ---------- jitter ---------- */

/** Spread overlapping points using stable email-based jitter. */
export function applyJitter<T extends { x: number; y: number; email: string }>(
  points: T[],
  count: number,
): T[] {
  const isLarge = count >= LARGE_SET_THRESHOLD;
  const jitterX = isLarge ? 0.3 : 0.08;
  const jitterY = isLarge ? 3 : 0.4;
  return points.map(p => {
    const h = hashString(p.email);
    return {
      ...p,
      x: p.x + (seededRandom(h) - 0.5) * 2 * jitterX,
      y: p.y + (seededRandom(h + 1) - 0.5) * 2 * jitterY,
    };
  });
}

/* ---------- bubble radius ---------- */

/** Map totalEffortHours to bubble radius (px). For large sets use a fixed small radius. */
export function effortToRadius(effort: number, maxEffort: number, isLarge: boolean): number {
  if (isLarge) return 5;
  if (maxEffort <= 0) return 8;
  const MIN_R = 6;
  const MAX_R = 40;
  const ratio = Math.sqrt(effort / maxEffort);
  return MIN_R + ratio * (MAX_R - MIN_R);
}

/* ---------- beeswarm layout ---------- */

/**
 * Bin points by ghostPercent, stack within each bin vertically.
 * Returns layout coordinates where x = ghostPercent and y = stacking offset.
 */
export function beeswarmLayout(
  points: { ghostPercent: number }[],
  binWidth: number = 5,
): { x: number; y: number }[] {
  const bins = new Map<number, number>();
  return points.map(p => {
    const bin = Math.round(p.ghostPercent / binWidth) * binWidth;
    const count = bins.get(bin) ?? 0;
    bins.set(bin, count + 1);
    // Alternate above/below center: 0, 1, -1, 2, -2...
    const offset = count % 2 === 0 ? count / 2 : -(Math.ceil(count / 2));
    return { x: p.ghostPercent, y: offset };
  });
}

/* ---------- ghost color ---------- */

/** Return a fill color for a ghost-percent dot/bubble: green >= 100, yellow 80-99, red < 80. */
export function ghostFill(percent: number): string {
  if (percent >= GHOST_THRESHOLDS.GOOD) return '#22c55e';
  if (percent >= GHOST_THRESHOLDS.WARNING) return '#eab308';
  return '#ef4444';
}

/* ---------- heatmap color ---------- */

/** Return an rgba color string for a ghost-percent cell background. */
export function heatColor(percent: number): string {
  if (percent >= 100) {
    const intensity = Math.min((percent - 100) / 100, 1);
    return `rgba(34, 197, 94, ${0.2 + intensity * 0.6})`;
  }
  if (percent >= 80) {
    const intensity = Math.min((100 - percent) / 20, 1);
    return `rgba(234, 179, 8, ${0.2 + intensity * 0.4})`;
  }
  const intensity = Math.min((80 - percent) / 80, 1);
  return `rgba(239, 68, 68, ${0.2 + intensity * 0.6})`;
}
