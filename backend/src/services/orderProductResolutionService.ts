import type { Product } from '../db/models/product';
import {
  findActiveProductsByNameSubstring,
  findProductByNameCaseInsensitive,
  findVariantSiblingProducts,
} from '../db/models/product';
import {
  extractSelectionAttributes,
  normalizeText,
  type SelectionAttributes,
} from './productTitleNormalization';

// Re-exported so existing importers (and tests) keep a single, stable entry point even
// though the implementation now lives in the shared productTitleNormalization module.
export { extractSelectionAttributes, type SelectionAttributes } from './productTitleNormalization';

/**
 * Order-product resolution.
 *
 * Background: the AI reply pipeline and the order-creation pipeline are decoupled. When a
 * customer selects one of several recommended variants (e.g. "the 50 servings one"), order
 * creation previously re-derived the product purely from the intent LLM's free-text
 * `product_name` and a fuzzy DB lookup that silently tie-broke between equally-matching
 * variants. That allowed orders to be created for the wrong variant (50 vs 60 servings).
 *
 * This module re-anchors the decision on the CUSTOMER's own wording. It gathers the full
 * variant family, then picks the single variant whose distinguishing attributes (serving
 * count, size, weight, flavor, colour) match what the customer actually said. If the family
 * cannot be narrowed to exactly one product, it reports `ambiguous` so the caller can refuse
 * to guess rather than risk attaching the wrong product to an order.
 */

function productSelectionAttributes(product: Product): SelectionAttributes {
  const haystack = [
    product.name,
    product.size ?? '',
    product.weight ?? '',
    product.flavor ?? '',
    product.color ?? '',
    product.variant ?? '',
  ].join(' ');
  return extractSelectionAttributes(haystack);
}

function hasIntersection(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setB = new Set(b);
  return a.some((x) => setB.has(x));
}

export type OrderProductResolutionReason =
  | 'no_candidates'
  | 'unique'
  | 'size_match'
  | 'flavor_match'
  | 'color_match'
  | 'bare_number_match'
  | 'intent_exact'
  | 'ambiguous';

export interface OrderProductResolution {
  /** The resolved product, or null when nothing matched or the choice is ambiguous. */
  product: Product | null;
  /** True when multiple variants remain plausible and we refuse to guess. */
  ambiguous: boolean;
  /** Machine-readable reason for the outcome (used in logs). */
  reason: OrderProductResolutionReason;
  /** The full candidate set considered (for observability). */
  candidates: Product[];
}

function uniqueMatch(candidates: Product[], predicate: (p: Product) => boolean): Product | null {
  const matches = candidates.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Given a set of variant candidates and the customer's selection wording, pick the single
 * variant the customer referred to. Pure function — no DB access — so it is fully testable.
 *
 * Matching is tiered from strongest to weakest signal. At each tier we only accept a result
 * when it narrows the candidates to EXACTLY one product; otherwise we fall through. If no
 * tier yields a unique product, we fall back to an exact name match against the intent
 * string, and finally report `ambiguous`.
 */
export function disambiguateVariants(
  candidates: Product[],
  customerSelectionText: string,
  intentProductName: string | null,
): OrderProductResolution {
  if (candidates.length === 0) {
    return { product: null, ambiguous: false, reason: 'no_candidates', candidates };
  }
  if (candidates.length === 1) {
    return { product: candidates[0], ambiguous: false, reason: 'unique', candidates };
  }

  // The customer's own wording is the authoritative selection signal. We deliberately
  // include the intent product_name only as a last-resort tiebreaker, because the intent
  // LLM is the component that can pick the wrong variant in the first place.
  const selection = extractSelectionAttributes(customerSelectionText);

  const bySize = uniqueMatch(candidates, (p) =>
    hasIntersection(productSelectionAttributes(p).sizeSignatures, selection.sizeSignatures),
  );
  if (bySize) return { product: bySize, ambiguous: false, reason: 'size_match', candidates };

  const byFlavor = uniqueMatch(candidates, (p) =>
    hasIntersection(productSelectionAttributes(p).flavors, selection.flavors),
  );
  if (byFlavor) return { product: byFlavor, ambiguous: false, reason: 'flavor_match', candidates };

  const byColor = uniqueMatch(candidates, (p) =>
    hasIntersection(productSelectionAttributes(p).colors, selection.colors),
  );
  if (byColor) return { product: byColor, ambiguous: false, reason: 'color_match', candidates };

  const byBareNumber = uniqueMatch(candidates, (p) => {
    const attrs = productSelectionAttributes(p);
    const productNumbers = [
      ...attrs.bareNumbers,
      ...attrs.sizeSignatures.map((s) => s.match(/^\d+(?:\.\d+)?/)?.[0] ?? ''),
    ].filter(Boolean);
    return hasIntersection(productNumbers, selection.bareNumbers);
  });
  if (byBareNumber) {
    return { product: byBareNumber, ambiguous: false, reason: 'bare_number_match', candidates };
  }

  // Last resort: the intent string is an exact (case-insensitive) name of one candidate and
  // the customer gave no distinguishing attribute we could use. Trust it, but flag nothing.
  if (intentProductName) {
    const normIntent = normalizeText(intentProductName);
    const exact = uniqueMatch(candidates, (p) => normalizeText(p.name) === normIntent);
    if (exact) return { product: exact, ambiguous: false, reason: 'intent_exact', candidates };
  }

  return { product: null, ambiguous: true, reason: 'ambiguous', candidates };
}

function dedupeById(products: Product[]): Product[] {
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const p of products) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

export interface ResolveOrderProductArgs {
  tenantId: string;
  /** Free-text product name produced by the intent classifier (may be wrong/ambiguous). */
  intentProductName: string | null;
  /** Recent customer wording that expresses the selection, e.g. "the 50 servings one". */
  customerSelectionText: string;
}

/**
 * Resolve the exact product a customer selected for an order.
 *
 * Steps:
 *  1. Seed from the intent name (exact-or-fuzzy single match) and expand to the full variant
 *     family, plus any direct name-substring matches. This guarantees that BOTH "Creatine 50
 *     Servings" and "Creatine 60 Servings" are present as candidates even if the intent LLM
 *     named only one of them.
 *  2. Disambiguate the candidate family against the customer's own wording.
 */
export async function resolveOrderProduct(
  args: ResolveOrderProductArgs,
): Promise<OrderProductResolution> {
  const { tenantId, intentProductName, customerSelectionText } = args;
  const trimmedIntent = intentProductName?.trim() || null;

  if (!trimmedIntent) {
    return { product: null, ambiguous: false, reason: 'no_candidates', candidates: [] };
  }

  const seed = await findProductByNameCaseInsensitive(tenantId, trimmedIntent);
  const directMatches = await findActiveProductsByNameSubstring(tenantId, trimmedIntent);
  const siblings = seed ? await findVariantSiblingProducts(tenantId, seed) : [];

  // Note: out-of-stock products are intentionally kept in the candidate set so that the
  // downstream out-of-stock guard in processAIReply can emit its specific skip log instead
  // of this resolver silently substituting a different (in-stock) variant.
  const candidates = dedupeById([...(seed ? [seed] : []), ...directMatches, ...siblings]);

  return disambiguateVariants(candidates, customerSelectionText, trimmedIntent);
}
