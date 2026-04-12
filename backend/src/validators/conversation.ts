import { z, ZodError } from 'zod';
import { decodeMessageCursor } from '../utils/messageCursor';
import type { DecodedMessageCursor } from '../utils/messageCursor';

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
    /** Cursor-based pagination (created_at + id). Preferred over `before`. */
    cursor: z.string().optional(),
    /** @deprecated Use `cursor`. ISO timestamp only; use `cursor` for stable pages when timestamps collide. */
    before: z.string().optional(),
  })
  .transform((q) => {
    const raw =
      q.cursor !== undefined && q.cursor.trim() !== ''
        ? q.cursor.trim()
        : q.before !== undefined && q.before.trim() !== ''
          ? q.before.trim()
          : undefined;

    let cursor: DecodedMessageCursor | null = null;
    if (raw !== undefined) {
      const decoded = decodeMessageCursor(raw);
      if (!decoded) {
        throw new ZodError([
          {
            code: 'custom',
            path: ['cursor'],
            message: 'Invalid message cursor',
          },
        ]);
      }
      cursor = decoded;
    }

    return { limit: q.limit, cursor };
  });

export type ConversationMessagesQuery = z.infer<typeof conversationMessagesQuerySchema>;

export const conversationReplyBodySchema = z
  .object({
    text: z.string().max(10000, 'Message must be at most 10000 characters').default(''),
    attachment_urls: z.array(z.string().min(1)).max(10).default([]),
  })
  .refine(
    (data) => data.text.trim().length > 0 || data.attachment_urls.length > 0,
    {
      message: 'Message text or at least one image attachment is required',
      path: ['text'],
    },
  );

export type ConversationReplyBody = z.infer<typeof conversationReplyBodySchema>;
