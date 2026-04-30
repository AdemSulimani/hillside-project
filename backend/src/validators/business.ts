import { z } from 'zod';

export const updateBusinessSchema = z.object({
  name: z
    .string()
    .min(1, 'Business name is required')
    .max(255, 'Business name must be at most 255 characters')
    .optional(),
  niche: z
    .string()
    .min(1, 'Niche is required')
    .max(255, 'Niche must be at most 255 characters')
    .optional(),
  description: z
    .string()
    .max(2000, 'Description must be at most 2000 characters')
    .nullable()
    .optional(),
  delivery_methods: z
    .array(z.string().min(1))
    .min(1, 'At least one delivery method is required')
    .optional(),
  delivery_time: z
    .enum(['24h', '48h', '72h'], {
      message: 'Delivery time must be one of 24h, 48h, or 72h',
    })
    .nullable()
    .optional(),
  plan: z
    .string()
    .max(50, 'Plan must be at most 50 characters')
    .optional(),
});

export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;
