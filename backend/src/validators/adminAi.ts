import { z } from 'zod';
import { updateAIConfigSchema } from './aiConfig';

export const adminTenantPromptBlockIdParamsSchema = z.object({
  tenantId: z.string().uuid('Invalid tenant ID'),
  blockRowId: z.string().uuid('Invalid block ID'),
});

export const adminAiVersionIdParamsSchema = z.object({
  tenantId: z.string().uuid('Invalid tenant ID'),
  versionId: z.string().uuid('Invalid version ID'),
});

export const adminUpdateTenantAiConfigSchema = updateAIConfigSchema.extend({
  platform_restrictions: z.array(z.string()).optional(),
});

export const adminPatchTenantPromptBlockSchema = z
  .object({
    enabled: z.boolean().optional(),
    content: z.string().min(1).optional(),
    sort_order: z.coerce.number().int().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

export const adminCreateCustomPromptBlockSchema = z.object({
  block_key: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_]+$/i, 'Use letters, numbers, underscore only'),
  title: z.string().min(1).max(255),
  content: z.string().min(1).max(50000),
  sort_order: z.coerce.number().int().min(0).max(100000).default(1000),
});

export const adminAiTestBodySchema = z.object({
  testMessage: z.string().min(1).max(2000),
  language: z.enum(['sq', 'en']).optional(),
  /** When true, include the vision guideline block even without image URLs. */
  include_vision_block: z.boolean().optional(),
});

export type AdminUpdateTenantAiConfigInput = z.infer<typeof adminUpdateTenantAiConfigSchema>;
export type SnapshotPromptBlock = {
  block_key: string;
  prompt_block_id: string | null;
  enabled: boolean;
  content: string;
  sort_order: number;
};

export type TenantAiSnapshot = {
  ai_config: {
    tone: string;
    personality_description: string | null;
    restrictions: string[];
    platform_restrictions: string[];
    sales_strategy: string | null;
    objection_handling: string | null;
    qa_pairs: { question: string; answer: string }[];
    is_active: boolean;
    custom_model_id: string | null;
  };
  prompt_blocks: SnapshotPromptBlock[];
};
