import { z } from 'zod';

const uuid = z.string().uuid('Invalid id');

export const contactIdParamsSchema = z.object({
  id: uuid,
});

export const contactListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().max(200).optional(),
  sort: z.enum(['last_seen', 'name', 'message_count', 'order_count']).optional(),
  sort_dir: z.enum(['asc', 'desc']).default('desc'),
});

export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

export const contactShowQuerySchema = z.object({
  conversations_page: z.coerce.number().int().min(1).default(1),
  conversations_limit: z.coerce.number().int().min(1).max(50).default(10),
  orders_page: z.coerce.number().int().min(1).default(1),
  orders_limit: z.coerce.number().int().min(1).max(100).default(20),
  messages_limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type ContactShowQuery = z.infer<typeof contactShowQuerySchema>;

export const updateContactBodySchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    notes: z.string().max(20000).nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.notes !== undefined, {
    message: 'At least one of name or notes is required',
  });

export type UpdateContactBody = z.infer<typeof updateContactBodySchema>;
