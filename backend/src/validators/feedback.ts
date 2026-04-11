import { z } from 'zod';

const uuid = z.string().uuid('Invalid id');

export const feedbackLogStatusSchema = z.enum(['pending', 'included_in_training']);

export const storeFeedbackBodySchema = z.object({
  message_id: uuid,
  corrected_response: z.string().max(16000).nullable().optional(),
  reason: z.string().max(2000).nullable().optional(),
});

export type StoreFeedbackBody = z.infer<typeof storeFeedbackBodySchema>;

export const feedbackListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: feedbackLogStatusSchema.optional(),
});

export type FeedbackListQuery = z.infer<typeof feedbackListQuerySchema>;
