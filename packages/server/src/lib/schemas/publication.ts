import { z } from 'zod';

export const createPublicationSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
  repository: z.string().min(1, 'repository is required').regex(/^[^/]+\/[^/]+$/, 'Invalid repository format. Expected owner/repo'),
  visibleDevelopers: z.array(z.string()).optional(),
});

export const updatePublicationSchema = z.object({
  isActive: z.boolean().optional(),
  visibleDevelopers: z.array(z.string()).optional(),
  regenerateToken: z.boolean().optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'No valid fields to update' },
);

export const adminCreatePublicationSchema = z.object({
  orderId: z.string().min(1, 'orderId is required'),
  repository: z.string().min(1, 'repository is required').regex(/^[^/]+\/[^/]+$/, 'Invalid repository format'),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  isFeatured: z.boolean().optional(),
});

export const adminUpdatePublicationSchema = z.object({
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  title: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  sortOrder: z.number().int().optional(),
  visibleDevelopers: z.array(z.string()).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'No valid fields to update' },
);
