import type OpenAI from 'openai';
import { resolveModel } from '../config/models';
import { withModelRole } from './openaiCallTracker';
import type { ExtractedProductData } from './documents/AttachDocumentService';
import { openai } from './openaiClient';
import { parsePrice } from './documents/priceParsing';

const SYSTEM_PROMPT = `You are a product data extraction assistant. Given raw text extracted from a document or image, identify and structure product information.

Return a JSON array of product objects. Each product object should have these fields:
- name (string): The product name
- brand (string): The product brand or manufacturer
- description (string): A clear product description
- usage_description (string): How to use the product, instructions, or directions
- price (number): The regular product price as a decimal number
- discounted_price (number): Sale or discounted price, if any
- sku (string): Product SKU, code, barcode, or identifier
- tags (string[]): Relevant tags/keywords for the product
- category (string): The product category
- flavor (string): The product flavor, ONLY if explicitly stated in the text (e.g. "Lemon", "Qershi", "pa aromë" for unflavored) — never guess
- size (string): The package size or count, ONLY if explicitly stated (e.g. "1kg", "90 caps") — never guess
- color (string): The product color, ONLY if explicitly stated — never guess
- variant (string): The product variant, ONLY if explicitly stated — never guess
- weight (string): The product weight, ONLY if explicitly stated (e.g. "216gr") — never guess

Rules:
- Extract ALL products found in the text
- If price is not found, omit the field
- If a field cannot be determined, omit it
- flavor/size/color/variant/weight must be copied from the text verbatim — omit them when the text does not state them
- Return ONLY valid JSON, no markdown or extra text
- If no products can be identified, return an empty array []`;

export class AIProductProcessingService {
  private client: OpenAI;
  private model: string;

  constructor() {
    /**
     * P2-7 (RC-17 / P1-5): use the SHARED client, not a private one.
     *
     * This class used to build its own `new OpenAI({ apiKey })`, which meant its product-extraction
     * calls ran with none of the shared resilience config (OPENAI_MAX_RETRIES / OPENAI_TIMEOUT_MS)
     * and — worse — were never passed through `instrumentOpenAIClient`, so every token they burned
     * was INVISIBLE to the P1-5 cost ledger. It also read OPENAI_CHAT_MODEL with a *different*
     * default (`gpt-4o-mini`) than openaiClient gives the same variable (`gpt-4o`): one var, two
     * defaults, which is model-config drift in miniature.
     *
     * The model resolution below preserves the historical behaviour EXACTLY — see the
     * `product_processing` role in config/models.ts, whose terminal default is deliberately
     * `gpt-4o-mini`, not `gpt-4o`. The API-key presence check is now openaiClient's module-load
     * guard, which throws the same way.
     */
    this.client = openai;
    this.model = resolveModel('product_processing');
  }

  async extractProducts(rawText: string): Promise<ExtractedProductData[]> {
    if (!rawText.trim()) return [];

    const truncated = rawText.slice(0, 8000);

    // P3-6: an 8000-char extraction at 4096 max_tokens is the single largest call in the system,
    // and `product_processing` resolves to OPENAI_CHAT_MODEL whenever that is set — so its id is
    // indistinguishable from the reply's. The label is what keeps an import's cost from being
    // silently folded into conversation COGS.
    const response = await withModelRole('product_processing', () =>
      this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Extract product data from the following text:\n\n${truncated}`,
          },
        ],
        // Deterministic extraction so the same source document always yields the same
        // structured product data (names, prices, attributes) instead of drifting per run.
        temperature: 0,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      }),
    );

    const content = response.choices[0]?.message?.content;
    if (!content) return [];

    return this.parseResponse(content);
  }

  private parseResponse(content: string): ExtractedProductData[] {
    try {
      const parsed = JSON.parse(content);

      if (Array.isArray(parsed)) {
        return this.validateProducts(parsed);
      }

      if (parsed.products && Array.isArray(parsed.products)) {
        return this.validateProducts(parsed.products);
      }

      if (parsed.name) {
        return this.validateProducts([parsed]);
      }

      return [];
    } catch {
      return [];
    }
  }

  private validateProducts(items: unknown[]): ExtractedProductData[] {
    return items
      .filter((item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
      )
      .map((item) => {
        const product: ExtractedProductData = {};

        if (typeof item.name === 'string' && item.name.trim()) {
          product.name = item.name.trim().slice(0, 255);
        }
        if (typeof item.brand === 'string' && item.brand.trim()) {
          product.brand = item.brand.trim().slice(0, 255);
        }
        if (typeof item.description === 'string' && item.description.trim()) {
          product.description = item.description.trim().slice(0, 5000);
        }
        if (typeof item.usage_description === 'string' && item.usage_description.trim()) {
          product.usage_description = item.usage_description.trim().slice(0, 10000);
        }
        {
          const parsed = parsePrice(item.price);
          if (parsed !== undefined) product.price = parsed;
        }
        {
          const parsed = parsePrice(item.discounted_price);
          if (parsed !== undefined) product.discounted_price = parsed;
        }
        if (typeof item.sku === 'string' && item.sku.trim()) {
          product.sku = item.sku.trim().slice(0, 100);
        }
        if (Array.isArray(item.tags)) {
          product.tags = item.tags
            .filter((t): t is string => typeof t === 'string')
            .map((t) => t.trim())
            .filter(Boolean);
        }
        if (typeof item.category === 'string' && item.category.trim()) {
          product.category = item.category.trim();
        }
        for (const key of ['flavor', 'size', 'color', 'variant', 'weight'] as const) {
          const value = item[key];
          if (typeof value === 'string' && value.trim()) {
            product[key] = value.trim().slice(0, 255);
          }
        }

        return product;
      })
      .filter((p) => p.name || p.price !== undefined);
  }

  createEnricher(): (text: string) => Promise<ExtractedProductData[]> {
    return (text: string) => this.extractProducts(text);
  }
}
