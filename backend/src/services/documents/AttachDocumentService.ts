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
  image_urls?: string[];
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

  const validImageUrls = (data.image_urls ?? []).filter((url) => /^https?:\/\/.+/.test(url));

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
    image_urls: validImageUrls.length > 0 ? validImageUrls : undefined,
    source_type: sourceType,
    extracted_text: rawText,
    metadata,
  };
}

export interface DocumentParseResult {
  rawText: string;
  products: ExtractedProductData[];
}

/**
 * Build a per-product `extracted_text` blob from a SINGLE product's own extracted
 * fields.
 *
 * Why this exists: a multi-product import (PDF/spreadsheet/AI enrichment) produces one
 * `rawText` that contains EVERY product in the document. Previously that whole blob was
 * stored as `extracted_text` on every imported SKU, so the retrieval layer
 * (`inferAttributeFromText`, `buildProductKnowledgeContext`, the attribute-availability
 * classifier) read product B/C/D's prices, flavors, and descriptions as if they belonged
 * to product A — a direct cause of the AI "mixing information between products". Scoping the
 * stored text to the product's own fields removes that cross-product bleed while keeping a
 * useful per-SKU text record for downstream attribute inference.
 */
export function buildExtractedTextForProduct(data: ExtractedProductData): string {
  const parts = [
    data.name,
    data.brand,
    data.category,
    data.sku ? `SKU: ${data.sku}` : null,
    data.description,
    data.usage_description,
    data.tags && data.tags.length > 0 ? `Tags: ${data.tags.join(', ')}` : null,
  ];
  return parts
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p.length > 0)
    .join('\n');
}

/**
 * Choose the `extracted_text` for an imported product:
 * - When the document yielded exactly ONE product, the full `rawText` genuinely belongs to
 *   that product (e.g. a single-label OCR), so it is retained verbatim.
 * - When MULTIPLE products were parsed from one document, fall back to a per-product blob so
 *   no SKU carries another SKU's text. If the product has no usable own-field text, return
 *   null rather than poisoning it with the whole-document dump.
 */
function resolveExtractedTextForProduct(
  data: ExtractedProductData,
  rawText: string,
  totalProducts: number,
): string {
  if (totalProducts <= 1) return rawText;
  return buildExtractedTextForProduct(data);
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

    const total = result.products.length;
    for (const data of result.products) {
      const extractedText = resolveExtractedTextForProduct(data, result.rawText, total);
      const { product } = await upsertProductByName(
        extractedDataToProductInput(this.tenantId, data, this.sourceType, extractedText, {
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
    const total = result.products.length;
    for (const data of result.products) {
      const extractedText = resolveExtractedTextForProduct(data, result.rawText, total);
      const { product } = await upsertProductByName(
        extractedDataToProductInput(this.tenantId, data, this.sourceType, extractedText, {
          original_data: data,
          ai_enriched: !!aiEnrich,
        }),
      );
      products.push(product);
    }

    return products;
  }
}
