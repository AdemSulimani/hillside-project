import { z } from 'zod';

export const productFormValuesSchema = z
  .object({
    name: z.string().trim().min(1, 'Emri është i detyrueshëm').max(255),
    brand: z.string().max(255).optional().default(''),
    priceInput: z
      .string()
      .min(1, 'Çmimi është i detyrueshëm')
      .refine((s) => {
        const n = parseFloat(s.replace(/,/g, ''));
        return !Number.isNaN(n) && n >= 0;
      }, 'Vendosni një çmim të vlefshëm'),
    discountedPriceInput: z
      .string()
      .optional()
      .default('')
      .refine((s) => {
        if (!s || s.trim() === '') return true;
        const n = parseFloat(s.replace(/,/g, ''));
        return !Number.isNaN(n) && n >= 0;
      }, 'Vendosni një çmim të zbritur të vlefshëm'),
    description: z.string().max(5000).optional().default(''),
    usage_description: z.string().max(10000).optional().default(''),
    sku: z.string().max(100).optional().default(''),
    category: z.string().max(255).optional().default(''),
    tagsInput: z.string().optional().default(''),
    in_stock: z.boolean(),
    is_active: z.boolean(),
  })
  .refine(
    (data) => {
      const trimmed = data.discountedPriceInput?.trim() ?? '';
      if (trimmed === '') return true;
      const discounted = parseFloat(trimmed.replace(/,/g, ''));
      const price = parseFloat(data.priceInput.replace(/,/g, ''));
      if (!Number.isFinite(discounted) || !Number.isFinite(price)) return true;
      return discounted < price;
    },
    {
      message: 'Çmimi i zbritur duhet të jetë më i ulët se çmimi i rregullt',
      path: ['discountedPriceInput'],
    },
  );

export type ProductFormValues = z.infer<typeof productFormValuesSchema>;

export function parseTags(input: string): string[] {
  return input
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function valuesToApiBody(values: ProductFormValues) {
  const price = parseFloat(values.priceInput.replace(/,/g, ''));

  const discountedRaw = values.discountedPriceInput?.trim() ?? '';
  let discounted_price: number | null = null;
  if (discountedRaw !== '') {
    const n = parseFloat(discountedRaw.replace(/,/g, ''));
    if (Number.isNaN(n) || n < 0) {
      throw new Error('Çmimi i zbritur duhet të jetë një numër pozitiv');
    }
    if (Number.isFinite(price) && n >= price) {
      throw new Error('Çmimi i zbritur duhet të jetë më i ulët se çmimi i rregullt');
    }
    discounted_price = n;
  }

  return {
    name: values.name,
    brand: values.brand.trim() || null,
    price,
    discounted_price,
    description: values.description.trim() || null,
    usage_description: values.usage_description.trim() || null,
    sku: values.sku.trim() || null,
    category: values.category.trim() || null,
    tags: parseTags(values.tagsInput),
    in_stock: values.in_stock,
    is_active: values.is_active,
  };
}
