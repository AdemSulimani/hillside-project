import { z } from 'zod';

export const channelIdSchema = z.object({
  id: z.string().uuid('Invalid channel ID'),
});

export const whatsappEmbeddedSignupSchema = z.object({
  code: z.string().min(1, 'code is required').max(4096, 'code is too long'),
  state: z.string().min(1, 'state is required').max(256, 'state is too long'),
  /** Must match the page URL used with FB.login (and Meta OAuth). Validated against env allowlist. */
  redirect_uri: z.string().url().max(2048).optional(),
});

export type WhatsAppEmbeddedSignupInput = z.infer<typeof whatsappEmbeddedSignupSchema>;
