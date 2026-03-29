import { z } from 'zod';

const analysisPeriodModes = ['ALL_TIME', 'SELECTED_YEARS', 'DATE_RANGE', 'LAST_N_COMMITS'] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSONB fields stored as-is in Prisma
const jsonObject = z.record(z.any());
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonArray = z.array(z.any());

export const createOrderSchema = z.object({
  name: z.string().max(200).optional(),
  selectedRepos: z.array(jsonObject).min(1, 'At least one repository is required'),
  analysisPeriodMode: z.enum(analysisPeriodModes).optional(),
  analysisStartDate: z.string().optional(),
  analysisEndDate: z.string().optional(),
  analysisCommitLimit: z.number().int().positive().optional().nullable(),
}).refine(
  (data) => {
    if (data.analysisPeriodMode === 'DATE_RANGE') {
      return !!data.analysisStartDate && !!data.analysisEndDate;
    }
    return true;
  },
  { message: 'Start and end dates are required for DATE_RANGE mode' },
).refine(
  (data) => {
    if (data.analysisPeriodMode === 'LAST_N_COMMITS') {
      return data.analysisCommitLimit != null && data.analysisCommitLimit > 0;
    }
    return true;
  },
  { message: 'A positive integer commit limit is required for LAST_N_COMMITS mode' },
);

export const updateOrderSchema = z.object({
  name: z.string().max(200).optional(),
  selectedRepos: jsonArray.optional(),
  selectedDevelopers: jsonArray.optional(),
  developerMapping: jsonObject.optional(),
  analysisPeriodMode: z.enum(analysisPeriodModes).optional(),
  analysisYears: z.array(z.number().int()).optional(),
  analysisStartDate: z.string().nullable().optional(),
  analysisEndDate: z.string().nullable().optional(),
  analysisCommitLimit: z.number().int().positive().nullable().optional(),
}).refine(
  (data) => {
    if (data.analysisPeriodMode === 'SELECTED_YEARS') {
      return data.analysisYears && data.analysisYears.length > 0;
    }
    return true;
  },
  { message: 'At least one year is required for SELECTED_YEARS mode' },
).refine(
  (data) => {
    if (data.analysisPeriodMode === 'LAST_N_COMMITS') {
      return data.analysisCommitLimit != null && data.analysisCommitLimit > 0;
    }
    return true;
  },
  { message: 'A positive integer commit limit is required for LAST_N_COMMITS mode' },
);

export const analyzeOrderSchema = z.object({
  cacheMode: z.enum(['any', 'model', 'off']).optional(),
  forceRecalculate: z.boolean().optional(),
  analysisPeriodMode: z.enum(analysisPeriodModes).optional(),
  analysisStartDate: z.string().optional(),
  analysisEndDate: z.string().optional(),
  analysisCommitLimit: z.number().int().positive().nullable().optional(),
  analysisYears: z.array(z.number().int()).optional(),
}).refine(
  (data) => {
    if (data.analysisPeriodMode === 'DATE_RANGE') {
      return !!data.analysisStartDate && !!data.analysisEndDate;
    }
    return true;
  },
  { message: 'Start and end dates are required for DATE_RANGE mode' },
).refine(
  (data) => {
    if (data.analysisPeriodMode === 'SELECTED_YEARS') {
      return data.analysisYears && data.analysisYears.length > 0;
    }
    return true;
  },
  { message: 'At least one year is required for SELECTED_YEARS mode' },
).refine(
  (data) => {
    if (data.analysisPeriodMode === 'LAST_N_COMMITS') {
      return data.analysisCommitLimit != null && data.analysisCommitLimit > 0;
    }
    return true;
  },
  { message: 'A positive integer commit limit is required for LAST_N_COMMITS mode' },
);

export const mappingSchema = z.object({
  developerMapping: jsonObject.default({}),
  excludedDevelopers: z.array(z.string()).default([]),
});

export const developerSettingsSchema = z.object({
  developerEmail: z.string().min(1, 'developerEmail is required'),
  share: z.number().min(0.01).max(1).optional(),
  isExcluded: z.boolean().optional(),
  shareAutoCalculated: z.boolean().optional(),
});

export const benchmarkSchema = z.object({
  profile: z.enum(['target_rollout'], { required_error: 'profile is required' }),
});
