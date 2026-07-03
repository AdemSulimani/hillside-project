import { z } from 'zod';

export const channelIdSchema = z.object({
  id: z.string().uuid('Invalid channel ID'),
});

export const whatsappEmbeddedSignupSchema = z.object({
  code: z.string().min(1, 'code is required').max(4096, 'code is too long'),
  state: z.string().min(1, 'state is required').max(256, 'state is too long'),
});

export type WhatsAppEmbeddedSignupInput = z.infer<typeof whatsappEmbeddedSignupSchema>;

export const viberConnectSchema = z.object({
  auth_token: z
    .string()
    .min(10, 'auth_token is required')
    .max(512, 'auth_token is too long'),
});

export type ViberConnectInput = z.infer<typeof viberConnectSchema>;
