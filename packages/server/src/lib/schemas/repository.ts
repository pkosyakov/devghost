import { z } from 'zod';

export const repositoryListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  sort: z.enum(['fullName', 'lastAnalyzedAt', 'lastCommitAt', 'totalCommits', 'contributorCount']).default('fullName'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  language: z.string().optional(),
  search: z.string().optional(),
  freshness: z.enum(['fresh', 'stale', 'never']).optional(),
});
