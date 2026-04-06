import Groq from 'groq-sdk';
import type { ExtractedProductData } from './documents/AttachDocumentService';

const SYSTEM_PROMPT = `You are a product data extraction assistant. Given raw text extracted from a document or image, identify and structure product information.

Return a JSON array of product objects. Each product object should have these fields:
- name (string): The product name
- description (string): A clear product description  
- price (number): The product price as a decimal number
- tags (string[]): Relevant tags/keywords for the product
- category (string): The product category

Rules:
- Extract ALL products found in the text
- If price is not found, omit the field
- If a field cannot be determined, omit it
- Return ONLY valid JSON, no markdown or extra text
- If no products can be identified, return an empty array []`;

export class AIProductProcessingService {
  private client: Groq;
  private model: string;

  constructor() {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('GROQ_API_KEY environment variable is required');
    }
    this.client = new Groq({ apiKey });
    this.model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  }

  async extractProducts(rawText: string): Promise<ExtractedProductData[]> {
    if (!rawText.trim()) return [];

    const truncated = rawText.slice(0, 8000);

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Extract product data from the following text:\n\n${truncated}`,
        },
      ],
      temperature: 0.1,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    });

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
        if (typeof item.description === 'string' && item.description.trim()) {
          product.description = item.description.trim().slice(0, 5000);
        }
        if (typeof item.price === 'number' && item.price >= 0) {
          product.price = item.price;
        } else if (typeof item.price === 'string') {
          const parsed = parseFloat(item.price);
          if (!isNaN(parsed) && parsed >= 0) product.price = parsed;
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

        return product;
      })
      .filter((p) => p.name || p.price !== undefined);
  }

  createEnricher(): (text: string) => Promise<ExtractedProductData[]> {
    return (text: string) => this.extractProducts(text);
  }
}
