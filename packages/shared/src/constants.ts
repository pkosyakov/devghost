// Ghost norm: productive code output hours per working day
// 3h/day baseline aligned with industry research on deep work capacity
export const GHOST_NORM = 3.0;

// Effort spreading constants
export const MAX_DAILY_EFFORT = 5; // Physical max productive coding per day (ceiling for spreading)
export const MAX_SPREAD_DAYS = 5;  // Max working days a single commit can spread across

// Minimum work days (days with commits) to calculate meaningful Ghost %
export const MIN_WORK_DAYS_FOR_GHOST = 1;

// Ghost % color thresholds
export const GHOST_THRESHOLDS = {
  EXCELLENT: 120,  // >= 120% green bold
  GOOD: 100,       // >= 100% green
  WARNING: 80,     // >= 80% yellow
  LOW: 0,          // < 80% red
} as const;

// Period types that support Ghost % calculation
export const GHOST_ELIGIBLE_PERIODS = [
  'ALL_TIME', 'YEAR', 'QUARTER', 'MONTH',
] as const;

// Period types for effort heatmap only (no Ghost %)
export const HEATMAP_ONLY_PERIODS = ['WEEK', 'DAY'] as const;

// Minimum days for custom range to show Ghost %
export const MIN_CUSTOM_RANGE_DAYS = 30;

// Order statuses
export const ORDER_STATUSES = {
  DRAFT: 'DRAFT',
  DEVELOPERS_LOADED: 'DEVELOPERS_LOADED',
  READY_FOR_ANALYSIS: 'READY_FOR_ANALYSIS',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
} as const;
