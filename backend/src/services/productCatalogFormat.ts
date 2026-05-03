import type { Product } from '../db/models/product';

/** Max characters per product description in AI catalog strings (0 = omit descriptions). */
const CATALOG_DESCRIPTION_MAX_CHARS = (() => {
  const raw = process.env.CATALOG_DESCRIPTION_MAX_CHARS;
  if (raw === undefined || raw.trim() === '') return 320;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.warn('[productCatalogFormat] Invalid CATALOG_DESCRIPTION_MAX_CHARS; using default 320');
    return 320;
  }
  return Math.min(n, 50000);
})();

/**
 * When usage is not shown in full (`includeFullUsage` false), include at most this many characters
 * of usage as a preview (0 = omit usage entirely unless `includeFullUsage` is true).
 */
const CATALOG_USAGE_PREVIEW_MAX_CHARS = (() => {
  const raw = process.env.CATALOG_USAGE_PREVIEW_MAX_CHARS;
  if (raw === undefined || raw.trim() === '') return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.warn('[productCatalogFormat] Invalid CATALOG_USAGE_PREVIEW_MAX_CHARS; using default 0');
    return 0;
  }
  return Math.min(n, 50000);
})();

function getProductBrand(product: Product): string | null {
  const b = product.brand;
  return typeof b === 'string' && b.trim().length > 0 ? b.trim() : null;
}

export type FormatProductCatalogOptions = {
  includePrice?: boolean;
  includeDiscount?: boolean;
  /** Max chars for each product description; 0 = omit. When unset, uses env `CATALOG_DESCRIPTION_MAX_CHARS`. */
  descriptionMaxChars?: number;
  /** When true, include full `usage_description` (required for verbatim usage replies). */
  includeFullUsage?: boolean;
  /**
   * When `includeFullUsage` is false, cap for a short usage preview (0 = omit usage).
   * When unset, uses env `CATALOG_USAGE_PREVIEW_MAX_CHARS` (default 0).
   */
  usageMaxChars?: number;
};

/** Trims and truncates catalog text with a trailing ellipsis; returns null when empty or maxChars <= 0. */
export function truncateCatalogText(
  text: string | null | undefined,
  maxChars: number,
): string | null {
  const raw = typeof text === 'string' ? text : '';
  const t = raw.trim();
  if (!t) return null;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return null;
  if (t.length <= maxChars) return t;
  const ellipsis = '…';
  const reserve = ellipsis.length;
  if (maxChars <= reserve) return ellipsis.slice(0, maxChars);
  return `${t.slice(0, maxChars - reserve).trimEnd()}${ellipsis}`;
}

export function formatProductCatalog(products: Product[], options?: FormatProductCatalogOptions): string {
  const includePrice = options?.includePrice ?? true;
  const includeDiscount = options?.includeDiscount ?? false;
  const descLimit =
    options?.descriptionMaxChars !== undefined
      ? options.descriptionMaxChars
      : CATALOG_DESCRIPTION_MAX_CHARS;
  const includeFullUsage = options?.includeFullUsage === true;
  const usagePreviewLimit =
    options?.usageMaxChars !== undefined ? options.usageMaxChars : CATALOG_USAGE_PREVIEW_MAX_CHARS;

  if (products.length === 0) return 'No matching products found in the catalog.';

  return products
    .map((p) => {
      const typeText = p.tags.length > 0 ? p.tags.join(', ') : 'N/A';
      const parts = [
        `- Brand: ${getProductBrand(p) ?? 'Unknown'}, Product: ${p.name}, Type: ${typeText}`,
      ];
      if (includePrice) {
        parts.push(`  Price: €${Number(p.price).toFixed(2)}`);
      }
      if (includeDiscount || includePrice) {
        const discounted = p.discounted_price;
        if (discounted !== null && discounted !== undefined) {
          const discountedNum = Number(discounted);
          if (Number.isFinite(discountedNum)) {
            parts.push(
              `  Discounted price (maximum offer when customer asks for a discount): €${discountedNum.toFixed(2)}`,
            );
          }
        } else if (includeDiscount) {
          parts.push('  Discounted price: not configured (no discount available)');
        }
      }
      const descriptionLine = truncateCatalogText(p.description, descLimit);
      if (descriptionLine) {
        parts.push(`  ${descriptionLine}`);
      }
      const usageRaw = typeof p.usage_description === 'string' ? p.usage_description.trim() : '';
      if (usageRaw) {
        if (includeFullUsage) {
          parts.push('  Usage description:');
          parts.push(`  ${usageRaw}`);
        } else {
          const preview = truncateCatalogText(usageRaw, usagePreviewLimit);
          if (preview) {
            parts.push('  Usage description (truncated):');
            parts.push(`  ${preview}`);
          }
        }
      }
      if (p.category) parts.push(`  Category: ${p.category}`);
      if (p.tags.length > 0) parts.push(`  Tags: ${p.tags.join(', ')}`);
      parts.push(
        `  Stock status (agent-only; do not mention unless the customer asks about availability/stock): ${p.in_stock === false ? 'out of stock' : 'in stock'}`,
      );
      return parts.join('\n');
    })
    .join('\n');
}
