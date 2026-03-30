import { z } from 'zod';
import {
  activeScopeQuerySchema,
  savedViewFilterDefinitionSchema,
  savedViewScopeDefinitionSchema,
} from '@/lib/schemas/scope';

export const savedViewVisibilityEnum = z.enum(['PRIVATE', 'WORKSPACE']);

export const savedViewListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  sort: z.enum(['updatedAt', 'createdAt', 'name']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  includeArchived: z.coerce.boolean().optional().default(false),
  search: z.string().optional(),
});

export const createSavedViewBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  visibility: savedViewVisibilityEnum.default('PRIVATE'),
  scopeDefinition: savedViewScopeDefinitionSchema,
  filterDefinition: savedViewFilterDefinitionSchema.default({
    repositoryIds: [],
    contributorIds: [],
  }),
});

export const updateSavedViewBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  visibility: savedViewVisibilityEnum.optional(),
  scopeDefinition: savedViewScopeDefinitionSchema.optional(),
  filterDefinition: savedViewFilterDefinitionSchema.optional(),
});

export const createSavedViewFromScopeBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  visibility: savedViewVisibilityEnum.default('PRIVATE'),
  activeScope: activeScopeQuerySchema,
});

export type SavedViewListQuery = z.infer<typeof savedViewListQuerySchema>;
export type CreateSavedViewBody = z.infer<typeof createSavedViewBodySchema>;
export type UpdateSavedViewBody = z.infer<typeof updateSavedViewBodySchema>;
export type CreateSavedViewFromScopeBody = z.infer<typeof createSavedViewFromScopeBodySchema>;
