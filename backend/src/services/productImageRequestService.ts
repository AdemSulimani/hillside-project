import type { Product } from '../db/models/product';
import { findActiveProductsByNameSubstring } from '../db/models/product';

/**
 * A parsed reference to a product in a customer's image request.
 * Produced by classifyProductImageRequest (aiService.ts) and consumed here.
 *
 * Examples:
 *   "the first one"              → { type: 'position', value: '1' }
 *   "the second and third"       → [{ type: 'position', value: '2' }, { type: 'position', value: '3' }]
 *   "Gold Standard Whey"         → { type: 'name',     value: 'Gold Standard Whey' }
 *   "all of them" / "both"       → { type: 'all',      value: null }
 *   "it" / "this" / "that one"   → { type: 'current',  value: null }
 */
export interface ProductImageRef {
  type: 'position' | 'name' | 'all' | 'current';
  /**
   * - `position`: 1-based index as a string ("1", "2", "3", …).
   * - `name`:     product name as written by the customer.
   * - `all`:      null — means every product in the current context.
   * - `current`:  null — means the most recently discussed / top-ranked product.
   */
  value: string | null;
}

/**
 * Resolves which products the customer wants images of, based on the ordered
 * products currently in context for this conversation turn.
 *
 * Candidate pool is built as:
 *   [matchedProducts (current turn, primary)  …  recentProducts (history, fallback)]
 * de-duplicated by id, so positional references ("the second one") count correctly
 * across the full set the customer has seen.
 *
 * Fallback: when all refs fail to resolve (e.g. customer said "it" but context
 * is ambiguous) the function returns the single top product from context — this
 * is always better than returning nothing when there is exactly one product in
 * scope (by far the common case).
 */
export function resolveProductsForImageRequest(
  refs: ProductImageRef[],
  matchedProducts: Product[],
  recentProducts: Product[],
): Product[] {
  // Whether the customer pointed at a specific product (by name or position).
  //
  // This drives BOTH the candidate ordering below and the generic fallback:
  //   - Specific reference ("the second one", "Nitro Tech Ripped"): the products
  //     matched THIS turn are the primary pool — they are what the AI is presenting.
  //   - Bare reference ("send me a photo", "it", "this one"): the customer is pointing
  //     at the product ALREADY under discussion. The fresh retrieval on such a
  //     product-less message is unreliable — it keyword-matches unrelated catalog rows
  //     (e.g. "A muni me ma qu foto" fuzzily matched pre-workout / BCAA rows) — so the
  //     persisted recently-discussed products are the authoritative anchor and must come
  //     first, otherwise a noisy fresh match shadows the real product and we wrongly
  //     report "image unavailable" for a product the business actually photographed.
  const hasSpecificRef = refs.some((r) => r.type === 'name' || r.type === 'position');

  // Build the ordered de-duplicated candidate list, primary pool first.
  const primaryPool = hasSpecificRef ? matchedProducts : recentProducts;
  const secondaryPool = hasSpecificRef ? recentProducts : matchedProducts;
  const seenIds = new Set<string>(primaryPool.map((p) => p.id));
  const contextProducts: Product[] = [
    ...primaryPool,
    ...secondaryPool.filter((p) => !seenIds.has(p.id)),
  ];

  if (contextProducts.length === 0) return [];

  const addedIds = new Set<string>();
  const result: Product[] = [];

  const addProduct = (product: Product): void => {
    if (!addedIds.has(product.id)) {
      addedIds.add(product.id);
      result.push(product);
    }
  };

  for (const ref of refs) {
    switch (ref.type) {
      case 'all': {
        // "all of them" / "both" — return the entire context, stop processing.
        for (const p of contextProducts) addProduct(p);
        return result;
      }

      case 'current': {
        // Vague pronoun ("it", "this one") → most recently discussed product.
        const first = contextProducts[0];
        if (first) addProduct(first);
        break;
      }

      case 'position': {
        // 1-based positional reference ("the second one" → index 1).
        const pos = parseInt(ref.value ?? '', 10);
        if (Number.isFinite(pos) && pos >= 1) {
          const product = contextProducts[pos - 1];
          if (product) addProduct(product);
        }
        break;
      }

      case 'name': {
        if (!ref.value?.trim()) break;
        const nameLower = ref.value.trim().toLowerCase();

        // 1. Exact case-insensitive match. When several catalog variants share the
        //    exact same name, prefer one that actually has an image so an imageless
        //    duplicate row can never shadow the variant the business photographed.
        const exactMatches = contextProducts.filter(
          (p) => p.name.trim().toLowerCase() === nameLower,
        );
        const chosenExact =
          exactMatches.find((p) => p.image_urls.length > 0) ?? exactMatches[0];
        if (chosenExact) { addProduct(chosenExact); break; }

        // 2. Substring match in either direction (handles abbreviations, partial
        //    names, and cases where the LLM extracted more/fewer words than the
        //    catalog name — e.g. "Nitro Tech" vs "Nitro Tech Ripped"). A family-level
        //    name ("Whey Gold") legitimately matches multiple size/flavor variants;
        //    prefer whichever variant has an image so we don't report "unavailable"
        //    while a sibling of the SAME requested product carries the photo.
        const partialMatches = contextProducts.filter(
          (p) =>
            p.name.toLowerCase().includes(nameLower) ||
            nameLower.includes(p.name.toLowerCase()),
        );
        const chosenPartial =
          partialMatches.find((p) => p.image_urls.length > 0) ?? partialMatches[0];
        if (chosenPartial) addProduct(chosenPartial);
        break;
      }
    }
  }

  // Fallback: only for GENERIC requests ("can I see a photo?") where the customer
  // named no specific product — return the top-ranked context product, since sending
  // one image is better than sending none when there's a clear product in scope.
  //
  // Deliberately skipped when the customer gave a specific (name/position) reference
  // that failed to resolve: substituting an unrelated context product there would send
  // the wrong photo or raise a bogus "image unavailable" alert. Named references that
  // miss the current context are instead recovered by augmentImageTargetsFromCatalog().
  if (result.length === 0 && contextProducts.length > 0 && !hasSpecificRef) {
    addProduct(contextProducts[0]);
  }

  return result;
}

/**
 * Catalog-level recovery for explicitly NAMED image requests.
 *
 * The context resolver above can only choose among products already loaded for this
 * turn (matched products + recently discussed history). When the customer names a
 * product that either isn't in that context, or resolved to an imageless sibling
 * variant, this augments the target list by looking the name up directly in the
 * catalog and preferring a variant that actually has an image.
 *
 * This is what closes the reported bug: "I asked for a product that already has an
 * image, but the AI said it would send it shortly." That happens when the resolved
 * product row has no image even though the business uploaded one to the real product
 * (a different variant, or a product not currently in conversation context). Here we
 * fetch the actual catalog match so the image is sent instead of a holding message.
 *
 * Safe by construction:
 *   - Only acts on `name` references (what the customer explicitly asked for).
 *   - Only substitutes when a catalog variant with an image genuinely exists; if no
 *     image exists anywhere for that name, the imageless target is left untouched so
 *     the honest "we'll send it shortly" notice + alert still fire.
 *   - Never throws: any lookup failure returns the original targets unchanged.
 */
export async function augmentImageTargetsFromCatalog(
  tenantId: string,
  refs: ProductImageRef[],
  targets: Product[],
): Promise<Product[]> {
  const nameRefs = refs.filter(
    (r): r is ProductImageRef & { value: string } =>
      r.type === 'name' && typeof r.value === 'string' && r.value.trim().length > 0,
  );
  if (nameRefs.length === 0) return targets;

  const result = [...targets];
  const resultIds = new Set(result.map((p) => p.id));

  const nameMatches = (product: Product, nameLower: string): boolean => {
    const productName = product.name.toLowerCase();
    return productName.includes(nameLower) || nameLower.includes(productName);
  };

  for (const ref of nameRefs) {
    const nameLower = ref.value.trim().toLowerCase();

    // Already have an image for this named request — nothing to recover.
    const alreadySatisfied = result.some(
      (p) => p.image_urls.length > 0 && nameMatches(p, nameLower),
    );
    if (alreadySatisfied) continue;

    let candidates: Product[] = [];
    try {
      candidates = await findActiveProductsByNameSubstring(tenantId, ref.value.trim(), 25);
    } catch {
      candidates = [];
    }

    const imaged = candidates.filter((p) => p.image_urls.length > 0);
    if (imaged.length === 0) continue; // genuinely no photo for this product → leave as-is

    // Prefer an exact-name match, then the shortest name (the most specific base
    // product rather than a longer, more niche variant).
    imaged.sort((a, b) => {
      const aExact = a.name.trim().toLowerCase() === nameLower ? 0 : 1;
      const bExact = b.name.trim().toLowerCase() === nameLower ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.name.length - b.name.length;
    });
    const chosen = imaged[0];

    // Drop any imageless target that was selected for this SAME named request, so we
    // don't both send the recovered photo AND raise a false "image unavailable" alert
    // for what is effectively the same product.
    for (let i = result.length - 1; i >= 0; i--) {
      const p = result[i];
      if (p.image_urls.length === 0 && nameMatches(p, nameLower)) {
        resultIds.delete(p.id);
        result.splice(i, 1);
      }
    }

    if (!resultIds.has(chosen.id)) {
      resultIds.add(chosen.id);
      result.push(chosen);
    }
  }

  return result;
}
