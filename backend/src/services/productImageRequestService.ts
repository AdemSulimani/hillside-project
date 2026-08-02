import type { Product } from '../db/models/product';
import {
  findActiveProductsByNameSubstring,
  findActiveProductsByNameSimilarity,
} from '../db/models/product';
import { knobNumber } from '../config/knobs';
import { normalizeText } from './productTitleNormalization';
import { isAlphanumericCodeToken } from './dialectNormalization';
import { IMAGE_REPLY_TEMPLATES } from './cannedReplyText';
import type { ReplyLocale } from './aiService';

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
   * - `all`:      null — means every product under discussion.
   * - `current`:  null — means the most recently discussed / top-ranked product.
   */
  value: string | null;
}

/** Max products one photo request may resolve to; caps the notice/dispatch blast radius. */
const IMAGE_REQUEST_MAX_TARGETS = knobNumber('IMAGE_REQUEST_MAX_TARGETS');
/** Max names the missing-photo notice may enumerate before collapsing to a generic line. */
const IMAGE_REQUEST_MAX_MISSING_NAMES = knobNumber('IMAGE_REQUEST_MAX_MISSING_NAMES');
/** pg_trgm floor for the catalog-recovery similarity rung. */
const IMAGE_REQUEST_NAME_SIMILARITY_THRESHOLD = knobNumber(
  'IMAGE_REQUEST_NAME_SIMILARITY_THRESHOLD',
);

/**
 * Folds text for name matching: lower-case, diacritics stripped, punctuation to spaces,
 * whitespace collapsed. Deliberately NOT foldDialect — Gheg function-word rewriting is for
 * customer sentences; product names must not have their tokens rewritten.
 */
function foldForMatch(text: string): string {
  return normalizeText((text ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' '));
}

/** Word-boundary substring test on already-folded strings. */
function containsPhrase(foldedText: string, foldedPhrase: string): boolean {
  return ` ${foldedText} `.includes(` ${foldedPhrase} `);
}

/**
 * Albanian nominal suffixes (definite/accusative/ablative endings) that customers attach to
 * product names in natural speech: "nitro techIN", "foton e nitro techIT", "limonIN". Folded
 * form only (normalizeText maps ë→e), longest first so "-ave" is tried before "-a".
 */
const ALBANIAN_NOMINAL_SUFFIXES: readonly string[] = [
  'ave', 'eve', 'it', 'in', 'un', 'et', 'en', 'te', 've', 'i', 'u', 'a', 'n', 't',
];

/**
 * Returns the token itself plus every suffix-stripped variant whose stem keeps ≥3 chars.
 * "techin" → ["techin", "tech", "techi"]; "limonin" → ["limonin", "limon", "limoni"];
 * "keks" → ["keks"] (no over-stripping below the stem floor).
 */
export function albanianTokenStems(token: string): string[] {
  const out = [token];
  for (const suffix of ALBANIAN_NOMINAL_SUFFIXES) {
    if (token.length - suffix.length >= 3 && token.endsWith(suffix)) {
      const stem = token.slice(0, -suffix.length);
      if (!out.includes(stem)) out.push(stem);
    }
  }
  return out;
}

/**
 * Inflection-tolerant product-name match: true when EVERY token of the customer's reference
 * (any Albanian stem variant) appears as a token — or shares a ≥3-char prefix with a token —
 * of the product name. Bridges what exact/substring matching cannot:
 *   "nitro techin"  ↔ "Nitro Tech Ripped"
 *   "carbo limonin" ↔ "Carbo one 1kg Limon"
 * while "carbo limonin" ↔ "Carbo One 1kg Orange" stays false (no token matches "limonin").
 */
export function productNameTokenMatch(refValue: string, productName: string): boolean {
  const refTokens = foldForMatch(refValue).split(' ').filter((t) => t.length >= 2);
  if (refTokens.length === 0) return false;
  const nameTokens = foldForMatch(productName).split(' ').filter((t) => t.length > 0);
  if (nameTokens.length === 0) return false;

  return refTokens.every((refToken) => {
    const stems = albanianTokenStems(refToken);
    return nameTokens.some((nameToken) =>
      stems.some(
        (stem) =>
          nameToken === stem ||
          (stem.length >= 3 && nameToken.startsWith(stem)) ||
          (nameToken.length >= 3 && stem.startsWith(nameToken)),
      ),
    );
  });
}

/**
 * Which of `products` were actually NAMED in the given texts (recent AI replies). This is the
 * scope guard for broad photo requests: `messages.product_ids` persists the whole retrieval
 * pool (10-25 rows), but the customer has only ever SEEN the products the AI wrote out — so
 * "send me photos of the products" must resolve against these, never the raw pool.
 *
 * Tier A: the full folded catalog name appears in a text ("nitro tech ripped").
 * Tier B: the name's leading two folded tokens appear ("carbo one" when the reply said
 *         "Carbo One në shije limon" without the size suffix). Tier A hits rank first.
 * Tier C: the name's single leading token, only when it is a letter+digit product code
 *         ("c4") — a reply saying bare "C4" names the whole C4 family. Skipped for any
 *         family a fuller Tier A/B mention already resolved, so a reply that wrote
 *         "C4 Ripped" out does not drag in every other C4 line via its embedded "c4".
 */
export function filterProductsMentionedInTexts(products: Product[], texts: string[]): Product[] {
  const foldedTexts = texts.map(foldForMatch).filter((t) => t.length > 0);
  if (foldedTexts.length === 0) return [];

  const leadOf = (foldedName: string): string =>
    foldedName.split(' ').filter(Boolean).slice(0, 2).join(' ');

  const tierA: Product[] = [];
  const tierACandidatesByLead = new Set<string>();
  const tierB: { product: Product; lead: string }[] = [];
  for (const product of products) {
    const foldedName = foldForMatch(product.name);
    if (!foldedName) continue;
    if (foldedTexts.some((t) => containsPhrase(t, foldedName))) {
      tierA.push(product);
      tierACandidatesByLead.add(leadOf(foldedName));
      continue;
    }
    const lead = leadOf(foldedName);
    if (lead.length >= 4 && lead !== foldedName && foldedTexts.some((t) => containsPhrase(t, lead))) {
      tierB.push({ product, lead });
    }
  }
  // Tier B only fills lead groups Tier A did not already resolve: when the reply wrote out
  // "Nitro Tech Ripped" in full, its "nitro tech" lead must not drag in every sibling
  // variant — but a bare "Carbo One" mention (no variant matched in full) legitimately
  // covers the Carbo One variants.
  const resolved = [
    ...tierA,
    ...tierB.filter((e) => !tierACandidatesByLead.has(e.lead)).map((e) => e.product),
  ];

  const resolvedIds = new Set(resolved.map((p) => p.id));
  const resolvedFirstTokens = new Set(
    [...tierA, ...tierB.map((e) => e.product)].map(
      (p) => foldForMatch(p.name).split(' ').filter(Boolean)[0] ?? '',
    ),
  );
  const tierC: Product[] = [];
  for (const product of products) {
    if (resolvedIds.has(product.id)) continue;
    const first = foldForMatch(product.name).split(' ').filter(Boolean)[0] ?? '';
    if (!isAlphanumericCodeToken(first) || resolvedFirstTokens.has(first)) continue;
    if (foldedTexts.some((t) => containsPhrase(t, first))) tierC.push(product);
  }
  return [...resolved, ...tierC];
}

export type ImageTargetMatchMethod =
  | 'exact'
  | 'substring'
  | 'token'
  | 'position'
  | 'current'
  | 'all_discussed'
  | 'fallback_top';

/** Deterministic record of how each target was chosen — logged for diagnosis. */
export interface ImageTargetTrace {
  refs: ProductImageRef[];
  contextPoolSize: number;
  discussedCount: number;
  matches: { productId: string; name: string; method: ImageTargetMatchMethod }[];
  capped: boolean;
}

export interface ImageTargetResolution {
  targets: Product[];
  trace: ImageTargetTrace;
}

/**
 * Resolves which products the customer wants images of.
 *
 * Candidate pool: [primary … secondary] de-duplicated by id — the products matched THIS turn
 * are primary for specific (name/position) references, the persisted recently-discussed
 * products are primary for bare references (fresh retrieval on a product-less "send me a
 * photo" message keyword-matches unrelated catalog rows).
 *
 * Scope guard (the 9-name-blast fix): broad references (`all`, `current`, positions) resolve
 * against the products actually NAMED in recent AI replies (`recentAiTexts`), never the whole
 * pool — the pool is retrieval fusion output and routinely contains rows the customer has
 * never seen. If nothing was demonstrably discussed, a broad request degrades to the single
 * top-ranked product, and every resolution is capped at `maxTargets`.
 */
export function resolveProductsForImageRequest(
  refs: ProductImageRef[],
  matchedProducts: Product[],
  recentProducts: Product[],
  recentAiTexts: string[],
  maxTargets: number = IMAGE_REQUEST_MAX_TARGETS,
): ImageTargetResolution {
  // Whether the customer pointed at a specific product (by name or position).
  const hasSpecificRef = refs.some((r) => r.type === 'name' || r.type === 'position');

  const primaryPool = hasSpecificRef ? matchedProducts : recentProducts;
  const secondaryPool = hasSpecificRef ? recentProducts : matchedProducts;
  const seenIds = new Set<string>(primaryPool.map((p) => p.id));
  const contextProducts: Product[] = [
    ...primaryPool,
    ...secondaryPool.filter((p) => !seenIds.has(p.id)),
  ];

  const discussed = filterProductsMentionedInTexts(contextProducts, recentAiTexts);

  const trace: ImageTargetTrace = {
    refs,
    contextPoolSize: contextProducts.length,
    discussedCount: discussed.length,
    matches: [],
    capped: false,
  };

  if (contextProducts.length === 0) return { targets: [], trace };

  const addedIds = new Set<string>();
  const result: Product[] = [];

  const addProduct = (product: Product, method: ImageTargetMatchMethod): void => {
    if (!addedIds.has(product.id)) {
      addedIds.add(product.id);
      result.push(product);
      trace.matches.push({ productId: product.id, name: product.name, method });
    }
  };

  refLoop: for (const ref of refs) {
    switch (ref.type) {
      case 'all': {
        // "all of them" / "both" — every product actually under discussion. When nothing was
        // demonstrably discussed, degrade to the top-ranked product; NEVER the whole pool.
        if (discussed.length > 0) {
          for (const p of discussed) addProduct(p, 'all_discussed');
        } else {
          addProduct(contextProducts[0], 'fallback_top');
        }
        break refLoop;
      }

      case 'current': {
        // Vague pronoun ("it", "this one") → most recently discussed product.
        const target = discussed[0] ?? contextProducts[0];
        if (target) addProduct(target, 'current');
        break;
      }

      case 'position': {
        // 1-based positional reference ("the second one" → index 1). Positions index the list
        // the customer has actually seen — the discussed products — falling back to the pool
        // only when no discussion evidence exists.
        const pos = parseInt(ref.value ?? '', 10);
        if (Number.isFinite(pos) && pos >= 1) {
          const pool = discussed.length > 0 ? discussed : contextProducts;
          const product = pool[pos - 1];
          if (product) addProduct(product, 'position');
        }
        break;
      }

      case 'name': {
        if (!ref.value?.trim()) break;
        const nameLower = ref.value.trim().toLowerCase();

        // 1. Exact case-insensitive match. When several catalog variants share the exact same
        //    name, prefer one that actually has an image so an imageless duplicate row can
        //    never shadow the variant the business photographed.
        const exactMatches = contextProducts.filter(
          (p) => p.name.trim().toLowerCase() === nameLower,
        );
        const chosenExact =
          exactMatches.find((p) => p.image_urls.length > 0) ?? exactMatches[0];
        if (chosenExact) {
          addProduct(chosenExact, 'exact');
          break;
        }

        // 2. Substring match in either direction (abbreviations, partial names, the LLM
        //    extracting more/fewer words than the catalog name — "Nitro Tech" vs "Nitro Tech
        //    Ripped"). A family-level name legitimately matches multiple variants; prefer
        //    whichever variant has an image.
        const partialMatches = contextProducts.filter(
          (p) =>
            p.name.toLowerCase().includes(nameLower) ||
            nameLower.includes(p.name.toLowerCase()),
        );
        const chosenPartial =
          partialMatches.find((p) => p.image_urls.length > 0) ?? partialMatches[0];
        if (chosenPartial) {
          addProduct(chosenPartial, 'substring');
          break;
        }

        // 3. Inflection-tolerant token match — the tier that bridges Gheg/Albanian inflected
        //    references ("nitro techin", "carbo limonin") that raw substring matching cannot.
        const tokenMatches = contextProducts.filter((p) =>
          productNameTokenMatch(ref.value!, p.name),
        );
        const chosenToken =
          tokenMatches.find((p) => p.image_urls.length > 0) ?? tokenMatches[0];
        if (chosenToken) addProduct(chosenToken, 'token');
        break;
      }
    }
  }

  // Fallback: only for GENERIC requests ("can I see a photo?") where the customer named no
  // specific product — return the top-ranked context product, since sending one image is
  // better than sending none when there's a clear product in scope.
  //
  // Deliberately skipped when the customer gave a specific (name/position) reference that
  // failed to resolve: substituting an unrelated context product there would send the wrong
  // photo or raise a bogus "image unavailable" alert. Named references that miss the current
  // context are instead recovered by augmentImageTargetsFromCatalog().
  if (result.length === 0 && contextProducts.length > 0 && !hasSpecificRef) {
    addProduct(contextProducts[0], 'fallback_top');
  }

  trace.capped = result.length > maxTargets;
  const targets = result.slice(0, maxTargets);
  trace.matches = trace.matches.slice(0, maxTargets);
  return { targets, trace };
}

/**
 * Stemmed ILIKE search term for an inflected reference: the shortest Albanian stem of the
 * longest token — "nitro techin" → "tech" (specific enough for ILIKE, inflection removed).
 * Null when it would just repeat a raw-substring query. Shared by the image-recovery ladder
 * and the inbound-name pinning ladder (inboundNamePinning.ts).
 */
export function stemmedSearchTerm(ref: string): string | null {
  const tokens = foldForMatch(ref)
    .split(' ')
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);
  const longest = tokens[0];
  if (!longest) return null;
  const stems = albanianTokenStems(longest).filter((s) => s.length >= 3);
  const term = stems.sort((a, b) => a.length - b.length)[0];
  if (!term || term === ref.trim().toLowerCase()) return null;
  return term;
}

/**
 * Sort comparator: exact-name match first, then the shortest name (the most specific base
 * product rather than a longer, more niche variant). Shared with inboundNamePinning.ts.
 */
export const bySpecificity =
  (nameLower: string) =>
  (a: Product, b: Product): number => {
    const aExact = a.name.trim().toLowerCase() === nameLower ? 0 : 1;
    const bExact = b.name.trim().toLowerCase() === nameLower ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return a.name.length - b.name.length;
  };

/** Injectable catalog lookups so the recovery ladder is unit-testable without a database. */
export interface CatalogLookupDeps {
  bySubstring?: typeof findActiveProductsByNameSubstring;
  bySimilarity?: typeof findActiveProductsByNameSimilarity;
}

/**
 * Catalog-level recovery for explicitly NAMED image requests.
 *
 * The context resolver above can only choose among products already loaded for this turn
 * (matched products + recently discussed history). When the customer names a product that
 * either isn't in that context, or resolved to an imageless sibling variant, this augments
 * the target list by looking the name up directly in the catalog and preferring a variant
 * that actually has an image.
 *
 * Recovery ladder per named reference (first rung that yields an imaged row wins):
 *   1. ILIKE on the raw reference ("nitro tech" → "%nitro tech%").
 *   2. ILIKE on the best stemmed token, then in-memory token-match filter — bridges inflected
 *      references ("nitro techin" → ILIKE "%tech%" → token-match keeps only nitro-tech rows).
 *   3. pg_trgm word_similarity at the calibrated threshold (typo tolerance).
 *
 * Safe by construction:
 *   - Only acts on `name` references (what the customer explicitly asked for).
 *   - Only substitutes when a catalog variant with an image genuinely exists; if no image
 *     exists anywhere for that name but the catalog DOES hold a matching imageless row, that
 *     row is surfaced as a target so the honest "we'll send it shortly" notice + alert cover
 *     it (live gap 2026-07-20: "carbo limonin" was absent from the retrieval pool and its
 *     imageless catalog row silently vanished from the reply instead of being noticed).
 *   - Never throws: any lookup failure returns the original targets unchanged.
 */
export async function augmentImageTargetsFromCatalog(
  tenantId: string,
  refs: ProductImageRef[],
  targets: Product[],
  deps: CatalogLookupDeps = {},
): Promise<Product[]> {
  const bySubstring = deps.bySubstring ?? findActiveProductsByNameSubstring;
  const bySimilarity = deps.bySimilarity ?? findActiveProductsByNameSimilarity;

  const nameRefs = refs.filter(
    (r): r is ProductImageRef & { value: string } =>
      r.type === 'name' && typeof r.value === 'string' && r.value.trim().length > 0,
  );
  if (nameRefs.length === 0) return targets;

  const result = [...targets];
  const resultIds = new Set(result.map((p) => p.id));

  const substringMatches = (product: Product, nameLower: string): boolean => {
    const productName = product.name.toLowerCase();
    return productName.includes(nameLower) || nameLower.includes(productName);
  };
  const refMatchesProduct = (product: Product, ref: string): boolean =>
    substringMatches(product, ref.trim().toLowerCase()) ||
    productNameTokenMatch(ref, product.name);

  for (const ref of nameRefs) {
    // Already have an image for this named request — nothing to recover.
    const alreadySatisfied = result.some(
      (p) => p.image_urls.length > 0 && refMatchesProduct(p, ref.value),
    );
    if (alreadySatisfied) continue;

    // Walk the ladder collecting candidates until a rung yields an IMAGED row. Every
    // candidate seen along the way is kept: if no photo exists anywhere, the best matching
    // imageless row still becomes a target so the missing-photo notice + alert cover it.
    let imaged: Product[] = [];
    const allCandidates: Product[] = [];
    try {
      // Rung 1: raw substring.
      const raw = await bySubstring(tenantId, ref.value.trim(), 25);
      allCandidates.push(...raw);
      imaged = raw.filter((p) => p.image_urls.length > 0);

      // Rung 2: stemmed-token substring, filtered to rows that genuinely match the reference.
      if (imaged.length === 0) {
        const term = stemmedSearchTerm(ref.value);
        if (term) {
          const stemmed = (await bySubstring(tenantId, term, 25)).filter((p) =>
            productNameTokenMatch(ref.value, p.name),
          );
          allCandidates.push(...stemmed);
          imaged = stemmed.filter((p) => p.image_urls.length > 0);
        }
      }

      // Rung 3: trigram similarity (typo tolerance) at the calibrated floor.
      if (imaged.length === 0) {
        const similar = await bySimilarity(
          tenantId,
          ref.value.trim(),
          IMAGE_REQUEST_NAME_SIMILARITY_THRESHOLD,
          10,
        );
        allCandidates.push(...similar);
        imaged = similar.filter((p) => p.image_urls.length > 0);
      }
    } catch {
      imaged = [];
    }

    const nameLower = ref.value.trim().toLowerCase();

    if (imaged.length === 0) {
      // Genuinely no photo for this name. If nothing in the target list covers the request
      // yet, surface the best imageless catalog match so the customer is TOLD the photo is
      // coming (and the alert names the product) instead of the request silently vanishing.
      const alreadyCovered = result.some((p) => refMatchesProduct(p, ref.value));
      if (!alreadyCovered) {
        const imageless = allCandidates
          .filter((p) => p.image_urls.length === 0)
          .sort(bySpecificity(nameLower));
        const fallback = imageless[0];
        if (fallback && !resultIds.has(fallback.id)) {
          resultIds.add(fallback.id);
          result.push(fallback);
        }
      }
      continue;
    }

    imaged.sort(bySpecificity(nameLower));
    const chosen = imaged[0];

    // Drop any imageless target that was selected for this SAME named request, so we don't
    // both send the recovered photo AND raise a false "image unavailable" alert for what is
    // effectively the same product.
    for (let i = result.length - 1; i >= 0; i--) {
      const p = result[i];
      if (p.image_urls.length === 0 && refMatchesProduct(p, ref.value)) {
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

export type ImageRequestOutcome = 'send_images' | 'holding_missing_images' | 'holding_unresolved';

export interface ImageRequestDecision {
  outcome: ImageRequestOutcome;
  /** Targets with a stored photo — one image message each is dispatched after the text. */
  withImages: Product[];
  /** Targets without a stored photo — named (capped) in the notice + alerted for follow-up. */
  missingImages: Product[];
}

/**
 * Pure routing decision for a detected photo request (the decideSensitiveDetectorFailureRoute
 * pattern — the pipeline block reduces to wiring around this). `holding_unresolved` is the
 * fall-through fix: a detected photo request must NEVER ship the raw model reply (the model
 * has no photo-sending knowledge and improvises "I can't send photos" apologies).
 */
export function decideImageRequestOutcome(targets: Product[]): ImageRequestDecision {
  const withImages = targets.filter((p) => p.image_urls.length > 0);
  const missingImages = targets.filter((p) => p.image_urls.length === 0);
  if (targets.length === 0) return { outcome: 'holding_unresolved', withImages, missingImages };
  if (withImages.length === 0) {
    return { outcome: 'holding_missing_images', withImages, missingImages };
  }
  return { outcome: 'send_images', withImages, missingImages };
}

/**
 * Builds the canned customer-facing text for a photo request from the templates registered in
 * cannedReplyText.ts. Missing-photo names are enumerated only up to `maxMissingNames`; beyond
 * that the notice collapses to a generic line — enumerating a long product list reads as
 * introducing products the customer never asked about (the original Bug #1 symptom).
 */
export function buildImageReplyText(
  locale: ReplyLocale,
  withImages: Product[],
  missingImages: Product[],
  maxMissingNames: number = IMAGE_REQUEST_MAX_MISSING_NAMES,
): string {
  const t = IMAGE_REPLY_TEMPLATES[locale];

  if (withImages.length === 0) {
    // Nothing to attach — one holding line, regardless of how many rows lack photos (the
    // alert carries the specifics; the customer just needs to know a photo will follow).
    return t.unresolvedHolding;
  }

  let text =
    withImages.length === 1 ? t.singlePhotoIntro(withImages[0].name) : t.multiPhotoIntro;

  if (missingImages.length > 0) {
    const tail =
      missingImages.length <= maxMissingNames && maxMissingNames > 0
        ? t.missingPhotosNamed(missingImages.map((p) => p.name).join(', '))
        : t.missingPhotosGeneric;
    text += `\n${tail}`;
  }
  return text;
}
