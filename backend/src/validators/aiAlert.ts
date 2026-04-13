import { z } from 'zod';

const uuid = z.string().uuid('Invalid id');

export const aiAlertIdParamsSchema = z.object({
  id: uuid,
});

export const aiAlertListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['unread', 'read', 'resolved']).optional(),
});

export type AIAlertListQuery = z.infer<typeof aiAlertListQuerySchema>;

export const resolveAIAlertBodySchema = z.object({
  resume_ai: z.boolean().optional(),
});

export type ResolveAIAlertBody = z.infer<typeof resolveAIAlertBodySchema>;
