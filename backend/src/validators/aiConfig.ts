import { z } from 'zod';

const qaPairSchema = z.object({
  question: z.string().min(1, 'Question is required').max(500, 'Question must be at most 500 characters'),
  answer: z.string().min(1, 'Answer is required').max(2000, 'Answer must be at most 2000 characters'),
});

export const updateAIConfigSchema = z.object({
  tone: z
    .string()
    .min(1, 'Tone is required')
    .max(255, 'Tone must be at most 255 characters')
    .optional(),
  personality_description: z.string().max(2000).nullable().optional(),
  restrictions: z
    .array(z.string().max(5000, 'Each business rule must be at most 5000 characters'))
    .max(50, 'Cannot exceed 50 business rules')
    .optional(),
  sales_strategy: z.string().max(5000).nullable().optional(),
  objection_handling: z.string().max(5000).nullable().optional(),
  qa_pairs: z
    .array(qaPairSchema)
    .max(30, 'Cannot exceed 30 Q&A pairs')
    .optional(),
  is_active: z.boolean().optional(),
  custom_model_id: z.string().max(255).nullable().optional(),
});

export const testAIConfigSchema = z.object({
  testMessage: z.string().min(1, 'Test message is required').max(2000),
  tone: z.string().min(1).max(255).optional(),
  personality_description: z.string().max(2000).nullable().optional(),
  restrictions: z
    .array(z.string().max(5000))
    .max(50)
    .optional(),
  sales_strategy: z.string().max(5000).nullable().optional(),
  objection_handling: z.string().max(5000).nullable().optional(),
  qa_pairs: z.array(qaPairSchema).max(30).optional(),
  is_active: z.boolean().optional(),
  custom_model_id: z.string().max(255).nullable().optional(),
});

export type UpdateAIConfigInput = z.infer<typeof updateAIConfigSchema>;
export type TestAIConfigInput = z.infer<typeof testAIConfigSchema>;
