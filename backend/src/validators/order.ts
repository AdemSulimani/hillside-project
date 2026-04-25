import { z } from 'zod';

const uuid = z.string().uuid('Invalid id');

export const orderIdParamsSchema = z.object({
  id: uuid,
});

export const orderStatusFilterSchema = z.enum([
  'draft',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
]);

export const orderListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: orderStatusFilterSchema.optional(),
  conversation_id: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
  created_from: z.coerce.date().optional(),
  created_to: z.coerce.date().optional(),
  sort: z
    .enum(['created_at', 'customer_name', 'total_price', 'quantity', 'status'])
    .optional(),
  sort_dir: z.enum(['asc', 'desc']).default('desc'),
});

export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export const updateDraftOrderBodySchema = z
  .object({
    quantity: z.number().int().min(1).optional(),
    delivery_address: z.string().max(8000).nullable().optional(),
    notes: z.string().max(10000).nullable().optional(),
  })
  .refine(
    (body) =>
      body.quantity !== undefined ||
      body.delivery_address !== undefined ||
      body.notes !== undefined,
    { message: 'At least one of quantity, delivery_address, or notes is required' },
  );

export type UpdateDraftOrderBody = z.infer<typeof updateDraftOrderBodySchema>;

export const orderActionRequiredResolutionStatusSchema = z.enum([
  'approved',
  'rejected',
  'store_credit_offered',
]);

export const orderIdWithOrderIdParamsSchema = z.object({
  orderId: uuid,
});

export const resolveOrderActionBodySchema = z.object({
  resolution_status: orderActionRequiredResolutionStatusSchema,
  resolution_notes: z.string().max(10000),
  resume_ai: z.boolean().optional(),
});

export const sendResolutionMessageBodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
});

export type ResolveOrderActionBody = z.infer<typeof resolveOrderActionBodySchema>;
export type SendResolutionMessageBody = z.infer<typeof sendResolutionMessageBodySchema>;
