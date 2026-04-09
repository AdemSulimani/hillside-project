import { z, ZodError } from 'zod';

const channelTypeEnum = z.enum(['facebook', 'instagram', 'whatsapp']);

export const conversationListQuerySchema = z.object({
  page: z
    .string()
    .optional()
    .default('1')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  limit: z
    .string()
    .optional()
    .default('20')
    .transform(Number)
    .pipe(z.number().int().min(1).max(100)),
  channel: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v : undefined))
    .pipe(channelTypeEnum.optional()),
  status: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v : undefined))
    .pipe(z.enum(['open', 'closed']).optional()),
});

export type ConversationListQuery = z.infer<typeof conversationListQuerySchema>;

export const conversationIdSchema = z.object({
  id: z.string().uuid('Invalid conversation ID'),
});

export const conversationMessagesQuerySchema = z
  .object({
    limit: z
      .string()
      .optional()
      .default('50')
      .transform(Number)
      .pipe(z.number().int().min(1).max(100)),
    before: z.string().optional(),
  })
  .transform((q) => {
    let before: Date | undefined;
    if (q.before !== undefined && q.before.trim() !== '') {
      const d = new Date(q.before);
      if (Number.isNaN(d.getTime())) {
        throw new ZodError([
          {
            code: 'custom',
            path: ['before'],
            message: 'Invalid cursor datetime',
          },
        ]);
      }
      before = d;
    }
    return { limit: q.limit, before };
  });

export type ConversationMessagesQuery = z.infer<typeof conversationMessagesQuerySchema>;

export const conversationReplyBodySchema = z.object({
  text: z
    .string()
    .min(1, 'Message text is required')
    .max(10000, 'Message must be at most 10000 characters'),
});

export type ConversationReplyBody = z.infer<typeof conversationReplyBodySchema>;
