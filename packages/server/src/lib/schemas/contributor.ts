import { z } from 'zod';

// ─── Enums ───

export const contributorClassificationEnum = z.enum([
  'INTERNAL',
  'EXTERNAL',
  'BOT',
  'FORMER_EMPLOYEE',
]);

export const identityHealthEnum = z.enum(['healthy', 'attention', 'unresolved']);

// ─── Query schemas ───

export const contributorListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  sort: z.enum(['displayName', 'primaryEmail', 'lastActivityAt']).default('displayName'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  classification: z.string().optional(), // comma-separated: "INTERNAL,EXTERNAL"
  identityHealth: identityHealthEnum.optional(),
  search: z.string().optional(),
});

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

// ─── Body schemas ───

export const mergeBodySchema = z.object({
  fromContributorId: z.string().min(1),
  toContributorId: z.string().min(1),
}).refine((data) => data.fromContributorId !== data.toContributorId, {
  message: 'Cannot merge a contributor into itself',
});

export const unmergeBodySchema = z.object({
  contributorId: z.string().min(1),
  aliasIds: z.array(z.string().min(1)).min(1),
});

export const excludeBodySchema = z.object({
  reason: z.string().optional(),
});

export const classifyContributorBodySchema = z.object({
  classification: contributorClassificationEnum,
});

export const classifyAliasBodySchema = z.object({
  classificationHint: contributorClassificationEnum,
});

export const resolveAliasBodySchema = z.object({
  contributorId: z.string().min(1),
});
