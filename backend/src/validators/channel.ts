import { z } from 'zod';

export const channelIdSchema = z.object({
  id: z.string().uuid('Invalid channel ID'),
});

export const whatsappConnectSchema = z.object({
  phoneNumberId: z
    .string()
    .min(1, 'phoneNumberId is required')
    .max(255, 'phoneNumberId must be at most 255 characters'),
  accessToken: z
    .string()
    .min(1, 'accessToken is required')
    .max(4096, 'accessToken must be at most 4096 characters'),
  name: z
    .string()
    .max(255, 'name must be at most 255 characters')
    .optional(),
});

export type WhatsAppConnectInput = z.infer<typeof whatsappConnectSchema>;
