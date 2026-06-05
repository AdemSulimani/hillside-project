import { z } from 'zod';

export const createProductSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Product name is required')
      .max(255, 'Product name must be at most 255 characters'),
    brand: z
      .string()
      .max(255, 'Brand must be at most 255 characters')
      .nullable()
      .optional(),
    price: z
      .number()
      .min(0, 'Price must be a positive number'),
    discounted_price: z
      .number()
      .min(0, 'Discounted price must be a positive number')
      .nullable()
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
      .optional()
      .default([]),
    is_active: z
      .boolean()
      .optional()
      .default(true),
    in_stock: z.boolean().optional().default(true),
    flavor: z.string().max(255).nullable().optional(),
    size: z.string().max(255).nullable().optional(),
    color: z.string().max(255).nullable().optional(),
    variant: z.string().max(255).nullable().optional(),
    weight: z.string().max(255).nullable().optional(),
  })
  .refine(
    (data) =>
      data.discounted_price === undefined ||
      data.discounted_price === null ||
      data.discounted_price < data.price,
    {
      message: 'Discounted price must be lower than the regular price',
      path: ['discounted_price'],
    },
  );

export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Product name is required')
      .max(255, 'Product name must be at most 255 characters')
      .optional(),
    brand: z
      .string()
      .max(255, 'Brand must be at most 255 characters')
      .nullable()
      .optional(),
    price: z
      .number()
      .min(0, 'Price must be a positive number')
      .optional(),
    discounted_price: z
      .number()
      .min(0, 'Discounted price must be a positive number')
      .nullable()
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
    in_stock: z.boolean().optional(),
    flavor: z.string().max(255).nullable().optional(),
    size: z.string().max(255).nullable().optional(),
    color: z.string().max(255).nullable().optional(),
    variant: z.string().max(255).nullable().optional(),
    weight: z.string().max(255).nullable().optional(),
    image_urls: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (data) =>
      data.discounted_price === undefined ||
      data.discounted_price === null ||
      data.price === undefined ||
      data.discounted_price < data.price,
    {
      message: 'Discounted price must be lower than the regular price',
      path: ['discounted_price'],
    },
  );

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
