import { z } from 'zod';

export const createProductSchema = z.object({
  name: z
    .string()
    .min(1, 'Product name is required')
    .max(255, 'Product name must be at most 255 characters'),
  price: z
    .number()
    .min(0, 'Price must be a positive number'),
  description: z
    .string()
    .max(5000, 'Description must be at most 5000 characters')
    .nullable()
    .optional(),
  usage_description: z
    .string()
    .max(10000, 'Usage description must be at most 10000 characters')
    .nullable()
    .optional(),
  sku: z
    .string()
    .max(100, 'SKU must be at most 100 characters')
    .nullable()
    .optional(),
  category: z
    .string()
    .max(255, 'Category must be at most 255 characters')
    .nullable()
    .optional(),
  tags: z
    .array(z.string().min(1))
    .optional()
    .default([]),
  is_active: z
    .boolean()
    .optional()
    .default(true),
  stock_quantity: z
    .number()
    .int('Stock quantity must be a whole number')
    .min(0, 'Stock quantity must be non-negative')
    .nullable()
    .optional(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z.object({
  name: z
    .string()
    .min(1, 'Product name is required')
    .max(255, 'Product name must be at most 255 characters')
    .optional(),
  price: z
    .number()
    .min(0, 'Price must be a positive number')
    .optional(),
  description: z
    .string()
    .max(5000, 'Description must be at most 5000 characters')
    .nullable()
    .optional(),
  usage_description: z
    .string()
    .max(10000, 'Usage description must be at most 10000 characters')
    .nullable()
    .optional(),
  sku: z
    .string()
    .max(100, 'SKU must be at most 100 characters')
    .nullable()
    .optional(),
  category: z
    .string()
    .max(255, 'Category must be at most 255 characters')
    .nullable()
    .optional(),
  tags: z
    .array(z.string().min(1))
    .optional(),
  is_active: z
    .boolean()
    .optional(),
  stock_quantity: z
    .number()
    .int('Stock quantity must be a whole number')
    .min(0, 'Stock quantity must be non-negative')
    .nullable()
    .optional(),
});

export type UpdateProductInput = z.infer<typeof updateProductSchema>;

export const productQuerySchema = z.object({
  search: z.string().optional(),
  tags: z.string().optional(),
  is_active: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  page: z
    .string()
    .optional()
    .default('1')
    .transform(Number)
    .pipe(z.number().int().min(1)),
  limit: z
    .string()
    .optional()
    .default('20')
    .transform(Number)
    .pipe(z.number().int().min(1).max(100)),
});

export type ProductQuery = z.infer<typeof productQuerySchema>;

export const productIdSchema = z.object({
  id: z.string().uuid('Invalid product ID'),
});
