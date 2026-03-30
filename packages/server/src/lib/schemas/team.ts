import { z } from 'zod';

export const teamListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  sort: z.enum(['name', 'memberCount', 'activeRepositoryCount', 'lastActivityAt', 'createdAt']).default('name'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  search: z.string().optional(),
});

export const createTeamBodySchema = z.object({
  name: z.string().min(1).max(100).trim(),
  description: z.string().max(500).optional(),
});

export const createTeamFromRepositoryBodySchema = z.object({
  name: z.string().min(1).max(100).trim(),
  description: z.string().max(500).optional(),
  contributorIds: z.array(z.string().min(1)).max(200).default([]),
});

export const updateTeamBodySchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  description: z.string().max(500).nullable().optional(),
});

export const addMemberBodySchema = z.object({
  contributorId: z.string().min(1),
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  isPrimary: z.boolean().optional().default(false),
  role: z.string().max(100).optional(),
}).refine(
  (d) => !d.effectiveFrom || !d.effectiveTo || d.effectiveFrom < d.effectiveTo,
  { message: 'effectiveFrom must be before effectiveTo', path: ['effectiveTo'] },
);

export const updateMemberBodySchema = z.object({
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  isPrimary: z.boolean().optional(),
  role: z.string().max(100).nullable().optional(),
}).refine(
  (d) => !d.effectiveFrom || !d.effectiveTo || d.effectiveFrom < d.effectiveTo,
  { message: 'effectiveFrom must be before effectiveTo', path: ['effectiveTo'] },
);

export const teamRepositoriesQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
}).refine(
  (d) => !d.from || !d.to || d.from <= d.to,
  { message: 'from must be before or equal to to', path: ['to'] },
);

export const teamMemberCandidatesQuerySchema = z.object({
  search: z.string().optional(),
  repository: z.string().optional(),
  classification: z.enum(['INTERNAL', 'EXTERNAL', 'BOT', 'FORMER_EMPLOYEE']).optional(),
  sort: z.enum(['activity', 'commits', 'name', 'repositories']).default('activity'),
});
