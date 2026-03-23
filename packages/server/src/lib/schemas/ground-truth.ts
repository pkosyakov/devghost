import { z } from 'zod';

const MAX_AUTHOR_LENGTH = 64;

const groundTruthEntrySchema = z.object({
  commitHash: z.string().trim().min(1, 'Invalid commitHash: non-empty string required'),
  hours: z.number().min(0, 'hours must be >= 0'),
  author: z.string().trim().min(1).max(MAX_AUTHOR_LENGTH).optional(),
  repository: z.string().optional(),
  notes: z.string().optional(),
});

export const createGroundTruthSchema = z.object({
  entries: z.array(groundTruthEntrySchema).min(1, 'entries array required'),
  author: z.string().trim().min(1).max(MAX_AUTHOR_LENGTH).optional(),
});
