/**
 * Async glue between the catalog/products, their stored image fingerprints, and the
 * pure productAttributeResolution policy. Produces a single prompt-ready block of
 * VERIFIED packaging-derived facts that the reply model and the escalation classifier
 * can use to answer attribute questions when the structured catalog fields are empty.
 *
 * This is what closes the Problem #2 gap: catalog image extractions were already
 * stored in product_image_fingerprints but never read back at reply time.
 */
import { findFingerprintsForProducts } from '../db/models/productImageFingerprint';
import type { Product } from '../db/models/product';
import {
  buildImageDerivedBlockForProduct,
  type FingerprintInput,
  type ResolvedAttribute,
  type StructuredAttributeInput,
} from './productAttributeResolution';
import { logEvent } from './analyticsService';

/** Cap how many products contribute an image-derived block to keep prompt size bounded. */
const MAX_PRODUCTS_WITH_IMAGE_CONTEXT = 8;

export interface ProductImageDerivedContext {
  /** Prompt-ready block (already provenance-labeled), or null when nothing usable. */
  block: string | null;
  /** Total usable image-derived attributes across all products in scope. */
  usableCount: number;
  /** Whether any conflicting packaging value was detected. */
  hadConflict: boolean;
  /**
   * Normalized keys of the usable image-derived attributes (e.g. 'brand', 'flavor').
   * Lets callers treat a packaging-read attribute as available even when the
   * structured catalog field is empty, so a missing-attribute escalation is not
   * raised for something we can actually answer from the product's own images.
   */
  usableKeys: string[];
}

function structuredFromProduct(product: Product): StructuredAttributeInput {
  return {
    brand: product.brand,
    category: product.category,
    flavor: product.flavor,
    size: product.size,
    color: product.color,
    variant: product.variant,
    weight: product.weight,
  };
}

/**
 * Fetch fingerprints for the given products and build a combined image-derived
 * attribute context block. Safe to call on any product set; returns an empty result
 * (block=null) when there are no products, no fingerprints, or nothing trustworthy.
 */
export async function getProductImageDerivedContext(
  tenantId: string,
  products: Product[],
  options?: { logTelemetry?: boolean },
): Promise<ProductImageDerivedContext> {
  const empty: ProductImageDerivedContext = {
    block: null,
    usableCount: 0,
    hadConflict: false,
    usableKeys: [],
  };
  if (!products || products.length === 0) return empty;

  const productIds = products.map((p) => p.id);
  let fingerprints;
  try {
    fingerprints = await findFingerprintsForProducts(tenantId, productIds);
  } catch (err) {
    console.warn('[productImageAttributes] Failed to load fingerprints', { tenantId, err });
    return empty;
  }
  if (fingerprints.length === 0) {
    return { block: null, usableCount: 0, hadConflict: false, usableKeys: [] };
  }

  const byProduct = new Map<string, FingerprintInput[]>();
  for (const fp of fingerprints) {
    const list = byProduct.get(fp.product_id) ?? [];
    list.push({ fingerprint_json: fp.fingerprint_json, fingerprint_version: fp.fingerprint_version });
    byProduct.set(fp.product_id, list);
  }

  const blocks: string[] = [];
  const allUsable: ResolvedAttribute[] = [];
  let hadConflict = false;
  let included = 0;

  for (const product of products) {
    if (included >= MAX_PRODUCTS_WITH_IMAGE_CONTEXT) break;
    const productFingerprints = byProduct.get(product.id);
    if (!productFingerprints || productFingerprints.length === 0) continue;

    const result = buildImageDerivedBlockForProduct(
      product.name,
      structuredFromProduct(product),
      productFingerprints,
    );
    if (result.hadConflict) hadConflict = true;
    if (result.text) {
      blocks.push(result.text);
      allUsable.push(...result.usable);
      included += 1;
    }
  }

  const usableKeys = [...new Set(allUsable.map((a) => a.key))];

  if (blocks.length === 0) {
    return { block: null, usableCount: 0, hadConflict, usableKeys };
  }

  const header =
    '[Verified packaging details read from product images — use ONLY to fill gaps the ' +
    'structured catalog above does not cover. These were read by the vision system from ' +
    'the actual product photos.]';
  const block = `${header}\n${blocks.join('\n')}`;

  if (options?.logTelemetry !== false) {
    logEvent(tenantId, 'image_derived_attribute_context', {
      products_in_scope: products.length,
      products_with_context: included,
      usable_attribute_count: allUsable.length,
      attribute_keys: [...new Set(allUsable.map((a) => a.key))].slice(0, 30),
      had_conflict: hadConflict,
    }).catch(() => {});
  }

  return { block, usableCount: allUsable.length, hadConflict, usableKeys };
}
