import { createProduct, upsertProductByName, type Product, type CreateProductInput } from '../../db/models/product';
import { repairOptionalUtf8Text } from '../../utils/textEncoding';

export interface ExtractedProductData {
  name?: string;
  brand?: string;
  description?: string;
  usage_description?: string;
  price?: number;
  discounted_price?: number;
  sku?: string;
  tags?: string[];
  category?: string;
}

export function extractedDataToProductInput(
  tenantId: string,
  data: ExtractedProductData,
  sourceType: CreateProductInput['source_type'],
  rawText: string,
  metadata: Record<string, unknown>,
  defaultName = 'Imported Product',
): CreateProductInput {
  const price = data.price ?? 0;
  let discounted_price: number | null = data.discounted_price ?? null;
  if (
    discounted_price != null &&
    Number.isFinite(price) &&
    discounted_price >= price
  ) {
    discounted_price = null;
  }

  const category = repairOptionalUtf8Text(data.category)?.slice(0, 255) ?? null;

  return {
    tenant_id: tenantId,
    name: repairOptionalUtf8Text(data.name) || defaultName,
    brand: repairOptionalUtf8Text(data.brand)?.slice(0, 255) ?? null,
    price,
    discounted_price,
    description: repairOptionalUtf8Text(data.description)?.slice(0, 5000) ?? null,
    usage_description: repairOptionalUtf8Text(data.usage_description)?.slice(0, 10000) ?? null,
    sku: repairOptionalUtf8Text(data.sku)?.slice(0, 100) ?? null,
    category,
    tags: (data.tags ?? (category ? [category] : [])).map((tag) => repairOptionalUtf8Text(tag) ?? tag),
    source_type: sourceType,
    extracted_text: rawText,
    metadata,
  };
}

export interface DocumentParseResult {
  rawText: string;
  products: ExtractedProductData[];
}

export abstract class AttachDocumentService {
  protected tenantId: string;
  protected sourceType: CreateProductInput['source_type'];

  constructor(tenantId: string, sourceType: CreateProductInput['source_type']) {
    this.tenantId = tenantId;
    this.sourceType = sourceType;
  }

  abstract parse(source: Buffer | string): Promise<DocumentParseResult>;

  async process(source: Buffer | string): Promise<Product[]> {
    const result = await this.parse(source);
    const products: Product[] = [];

    if (result.products.length === 0) {
      const product = await createProduct({
        tenant_id: this.tenantId,
        name: 'Imported Product',
        price: 0,
        description: result.rawText.slice(0, 5000) || null,
        source_type: this.sourceType,
        extracted_text: result.rawText,
        metadata: { needs_review: true },
      });
      products.push(product);
      return products;
    }

    for (const data of result.products) {
      const { product } = await upsertProductByName(
        extractedDataToProductInput(this.tenantId, data, this.sourceType, result.rawText, {
          original_data: data,
        }),
      );
      products.push(product);
    }

    return products;
  }

  async processAndEnrich(
    source: Buffer | string,
    aiEnrich?: (text: string) => Promise<ExtractedProductData[]>,
  ): Promise<Product[]> {
    const result = await this.parse(source);

    if (aiEnrich && result.rawText) {
      const enriched = await aiEnrich(result.rawText);
      if (enriched.length > 0) {
        result.products = enriched;
      }
    }

    const products: Product[] = [];
    for (const data of result.products) {
      const { product } = await upsertProductByName(
        extractedDataToProductInput(this.tenantId, data, this.sourceType, result.rawText, {
          original_data: data,
          ai_enriched: !!aiEnrich,
        }),
      );
      products.push(product);
    }

    return products;
  }
}
