import { z } from 'zod';

export const productFormValuesSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
  priceInput: z
    .string()
    .min(1, 'Price is required')
    .refine((s) => {
      const n = parseFloat(s.replace(/,/g, ''));
      return !Number.isNaN(n) && n >= 0;
    }, 'Enter a valid price'),
  description: z.string().max(5000).optional().default(''),
  usage_description: z.string().max(10000).optional().default(''),
  sku: z.string().max(100).optional().default(''),
  category: z.string().max(255).optional().default(''),
  tagsInput: z.string().optional().default(''),
  stockInput: z.string().optional().default(''),
  is_active: z.boolean(),
});

export type ProductFormValues = z.infer<typeof productFormValuesSchema>;

export function parseTags(input: string): string[] {
  return input
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function valuesToApiBody(values: ProductFormValues) {
  const price = parseFloat(values.priceInput.replace(/,/g, ''));
  const stockRaw = values.stockInput.trim();
  let stock_quantity: number | null = null;
  if (stockRaw !== '') {
    const n = parseInt(stockRaw, 10);
    if (Number.isNaN(n) || n < 0) {
      throw new Error('Stock must be a whole number ≥ 0');
    }
    stock_quantity = n;
  }

  return {
    name: values.name,
    price,
    description: values.description.trim() || null,
    usage_description: values.usage_description.trim() || null,
    sku: values.sku.trim() || null,
    category: values.category.trim() || null,
    tags: parseTags(values.tagsInput),
    stock_quantity,
    is_active: values.is_active,
  };
}
