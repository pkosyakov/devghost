import { z } from 'zod';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

export const createProfileSchema = z.object({
  slug: z.string({ required_error: 'slug and displayName are required' }).regex(SLUG_RE, 'Slug must be 3-30 chars, lowercase alphanumeric and hyphens'),
  displayName: z.string({ required_error: 'slug and displayName are required' }).min(1, 'displayName is required').max(100),
  bio: z.string().max(500).optional(),
  avatarUrl: z.string().url().optional(),
  includedOrderIds: z.array(z.string()).optional(),
});

export const updateProfileSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'Invalid slug format').optional(),
  displayName: z.string().min(1).max(100).optional(),
  bio: z.string().max(500).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
  includedOrderIds: z.array(z.string()).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'No valid fields to update' },
);
