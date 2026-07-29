/**
 * Pure, import-safe helpers for the vocabulary-independent attribute-availability
 * classifier (productAttributeAvailabilityService.ts).
 *
 * Kept separate from the service so the prompt-building, response-parsing, and cache-key
 * logic can be unit-tested without importing the OpenAI client (which is not import-safe
 * in tests). Mirrors the productInformationGapHelpers / productInformationGapService split.
 */
import crypto from 'crypto';
import type { Product } from '../db/models/product';
import {
  ALL_STRUCTURED_ATTRIBUTE_KEYS,
  getProductStructuredAttributes,
  type StructuredAttributeKey,
} from './productRetrievalService';

export const VALID_ATTRIBUTE_KEYS = new Set<string>(ALL_STRUCTURED_ATTRIBUTE_KEYS);

/** Cap on products per call so the prompt stays bounded for large category matches. */
export const MAX_PRODUCTS_IN_PROMPT = 25;

/**
 * Build the per-product description block included in the classifier prompt.
 *
 * extracted_text is deliberately excluded: it is a raw document dump that in practice
 * is shared across the whole imported catalog (not product-specific), so including it
 * lets the classifier confirm an attribute for a product using ANOTHER product's text —
 * a false "specified" verdict that suppresses genuine gaps and grounds fabrications.
 */
export function buildProductAvailabilityBlock(product: Product, index: number): string {
  const attrs = getProductStructuredAttributes(product);
  const structured = Object.entries(attrs)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return [
    `Product ${index + 1}:`,
    `  name: ${product.name}`,
    product.brand ? `  brand: ${product.brand}` : null,
    product.category ? `  category: ${product.category}` : null,
    structured ? `  structured fields: ${structured}` : null,
    product.description ? `  description: ${product.description}` : null,
    product.tags.length ? `  tags: ${product.tags.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Stable cache key over the requested keys + the product set (id + updated_at). */
export function buildAvailabilityCacheKey(
  requestedKeys: StructuredAttributeKey[],
  products: Product[],
): string {
  const keysPart = [...requestedKeys].sort().join(',');
  const productsPart = products
    .map((p) => `${p.id}:${new Date(p.updated_at).getTime()}`)
    .sort()
    .join('|');
  return crypto.createHash('sha1').update(`${keysPart}#${productsPart}`).digest('hex');
}

/**
 * Parse the classifier's JSON output into the set of confirmed-specified keys.
 *
 * Hardened: only keys that are BOTH valid AND were actually requested are accepted, so
 * the model can never widen the answered/missing decision beyond the customer's request.
 * Returns an empty set on any malformed output.
 */
export function parseSpecifiedAttributes(
  raw: string,
  requestedKeys: StructuredAttributeKey[],
): Set<StructuredAttributeKey> {
  const requestedSet = new Set<string>(requestedKeys);
  const out = new Set<StructuredAttributeKey>();
  try {
    const parsed = JSON.parse(raw) as { specified?: unknown };
    if (!Array.isArray(parsed.specified)) return out;
    for (const item of parsed.specified) {
      if (typeof item !== 'string') continue;
      const key = item.trim().toLowerCase();
      if (VALID_ATTRIBUTE_KEYS.has(key) && requestedSet.has(key)) {
        out.add(key as StructuredAttributeKey);
      }
    }
  } catch {
    return new Set();
  }
  return out;
}
