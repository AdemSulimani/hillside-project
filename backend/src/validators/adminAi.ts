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
  platform_restrictions: z
    .array(z.string().max(5000, 'Each platform policy bullet must be at most 5000 characters'))
    .max(50, 'Cannot exceed 50 platform policy bullets')
    .optional(),
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

export const adminCatalogBlockIdParamsSchema = z.object({
  blockId: z.string().uuid('Invalid block ID'),
});

export const adminCreateCatalogBlockSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9_.]+$/, 'Use lowercase letters, numbers, dots, and underscores only'),
  title: z.string().min(1).max(255),
  description: z.string().max(1000).nullable().optional(),
  default_content: z.string().min(1).max(50000),
  category: z.enum(['guidelines', 'vision']),
  sort_order: z.coerce.number().int().min(0).max(100000).default(1000),
  is_platform_locked: z.boolean().default(false),
  is_active: z.boolean().default(true),
  /** When true, immediately sync this new block to all existing businesses. */
  sync_to_existing: z.boolean().default(false),
});

export const adminUpdateCatalogBlockSchema = z
  .object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).nullable().optional(),
    default_content: z.string().min(1).max(50000).optional(),
    category: z.enum(['guidelines', 'vision']).optional(),
    sort_order: z.coerce.number().int().min(0).max(100000).optional(),
    is_platform_locked: z.boolean().optional(),
    is_active: z.boolean().optional(),
    /** When true, immediately sync any new/updated content to businesses missing this block. */
    sync_to_existing: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

export const adminSyncAllCatalogBlocksBodySchema = z.object({
  tenantIds: z
    .array(z.string().uuid('Each tenantId must be a valid UUID'))
    .max(500, 'Cannot sync more than 500 tenants in a single request')
    .optional(),
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
