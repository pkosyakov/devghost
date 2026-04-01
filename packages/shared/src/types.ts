import type { GHOST_ELIGIBLE_PERIODS, HEATMAP_ONLY_PERIODS } from './constants';

export type GhostEligiblePeriod = typeof GHOST_ELIGIBLE_PERIODS[number];
export type HeatmapOnlyPeriod = typeof HEATMAP_ONLY_PERIODS[number];
export type PeriodType = GhostEligiblePeriod | HeatmapOnlyPeriod;

export type OrderStatus =
  | 'DRAFT'
  | 'DEVELOPERS_LOADED'
  | 'READY_FOR_ANALYSIS'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED'
  | 'INSUFFICIENT_CREDITS';

export type AnalysisJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'LLM_COMPLETE'
  | 'COMPLETED'
  | 'FAILED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_FATAL'
  | 'CANCELLED';

export interface GhostMetric {
  developerId: string;
  developerName: string;
  developerEmail: string;
  periodType: PeriodType;
  periodStart?: string;
  periodEnd?: string;
  totalEffortHours: number;
  actualWorkDays: number;
  avgDailyEffort: number;
  ghostPercentRaw: number | null;
  ghostPercent: number | null;
  share: number;
  shareAutoCalculated: boolean;
  commitCount: number;
  hasEnoughData: boolean;
  overheadHours?: number;
  // FTE mode (optional — only populated on order results page)
  fteWorkDays?: number;
  fteAvgDailyEffort?: number;
  fteGhostPercentRaw?: number | null;
  fteGhostPercent?: number | null;
}

export interface OrderSummary {
  id: string;
  name: string;
  status: OrderStatus;
  avgGhostPercent: number | null;
  developerCount: number;
  commitCount: number;
  totalWorkDays: number;
  createdAt: string;
  completedAt?: string;
}

export interface AnalysisProgress {
  jobId: string;
  status: AnalysisJobStatus;
  progress: number;
  currentStep: string;
  currentCommit?: number;
  totalCommits?: number;
  startedAt?: string;
  eta?: string;
}

export interface DeveloperSettings {
  developerId: string;
  share: number;
  shareAutoCalculated: boolean;
  isExcluded: boolean;
}

export interface PushNotificationPayload {
  type: 'analysis_complete' | 'ghost_alert' | 'weekly_digest';
  orderId?: string;
  orderName?: string;
  avgGhostPercent?: number;
  message: string;
}
