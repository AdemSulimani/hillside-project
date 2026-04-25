import { createProduct, updateProduct, type Product, type CreateProductInput } from '../../db/models/product';

export interface ExtractedProductData {
  name?: string;
  description?: string;
  price?: number;
  tags?: string[];
  category?: string;
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
      const product = await createProduct({
        tenant_id: this.tenantId,
        name: data.name || 'Imported Product',
        price: data.price ?? 0,
        description: data.description ?? null,
        tags: data.tags ?? (data.category ? [data.category] : []),
        source_type: this.sourceType,
        extracted_text: result.rawText,
        metadata: { original_data: data },
      });
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
      const product = await createProduct({
        tenant_id: this.tenantId,
        name: data.name || 'Imported Product',
        price: data.price ?? 0,
        description: data.description ?? null,
        tags: data.tags ?? (data.category ? [data.category] : []),
        source_type: this.sourceType,
        extracted_text: result.rawText,
        metadata: { original_data: data, ai_enriched: !!aiEnrich },
      });
      products.push(product);
    }

    return products;
  }
}
