// Re-export shared constants for server-side use
export {
  GHOST_NORM,
  MIN_WORK_DAYS_FOR_GHOST,
  GHOST_THRESHOLDS,
  GHOST_ELIGIBLE_PERIODS,
  ORDER_STATUSES,
} from '@devghost/shared';

// Server-only constants
export const METRICS = {
  MAX_DAILY_EFFORT: 4.8,        // Max cap per day (sanity check)
  WORK_HOURS_PER_DAY: 8,
} as const;
