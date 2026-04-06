import { z } from 'zod';

export const onboardingSchema = z.object({
  name: z
    .string()
    .min(1, 'Business name is required')
    .max(255, 'Business name must be at most 255 characters'),
  niche: z
    .string()
    .min(1, 'Niche is required')
    .max(255, 'Niche must be at most 255 characters'),
  description: z
    .string()
    .max(2000, 'Description must be at most 2000 characters')
    .nullable()
    .optional(),
  delivery_methods: z
    .array(z.string().min(1))
    .min(1, 'At least one delivery method is required'),
  country: z
    .string()
    .min(1, 'Country is required')
    .max(100, 'Country must be at most 100 characters'),
  currency: z
    .string()
    .min(1)
    .max(10)
    .default('USD'),
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;
