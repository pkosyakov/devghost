import { z } from 'zod';

export const activeScopeKindEnum = z.enum(['all_teams', 'team', 'saved_view']);

const dateOnlyStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD date');

const csvStringArraySchema = z.preprocess((value) => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      typeof entry === 'string'
        ? entry.split(',').map((part) => part.trim()).filter(Boolean)
        : [],
    );
  }

  if (typeof value === 'string') {
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }

  return [];
}, z.array(z.string()));

export const activeScopeQuerySchema = z.object({
  scopeKind: activeScopeKindEnum.optional().default('all_teams'),
  scopeId: z.string().optional(),
  from: dateOnlyStringSchema.optional(),
  to: dateOnlyStringSchema.optional(),
  repositoryIds: csvStringArraySchema.optional().default([]),
  contributorIds: csvStringArraySchema.optional().default([]),
}).superRefine((value, ctx) => {
  if (value.scopeKind !== 'all_teams' && !value.scopeId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'scopeId is required for non-default scope',
      path: ['scopeId'],
    });
  }

  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'from must be before or equal to to',
      path: ['to'],
    });
  }
});

export const savedViewScopeDefinitionSchema = z.object({
  teamIds: z.array(z.string()).default([]),
  dateRange: z.object({
    start: dateOnlyStringSchema.nullable().default(null),
    end: dateOnlyStringSchema.nullable().default(null),
  }).default({ start: null, end: null }),
});

export const savedViewFilterDefinitionSchema = z.object({
  repositoryIds: z.array(z.string()).default([]),
  contributorIds: z.array(z.string()).default([]),
}).default({
  repositoryIds: [],
  contributorIds: [],
});

export type ActiveScopeQuery = z.infer<typeof activeScopeQuerySchema>;
export type SavedViewScopeDefinition = z.infer<typeof savedViewScopeDefinitionSchema>;
export type SavedViewFilterDefinition = z.infer<typeof savedViewFilterDefinitionSchema>;

