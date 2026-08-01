/**
 * Deterministic brand membership for the text lane (brand audit C2/H2).
 *
 * Before this service, "a keni produkte nga Nike?" was answered by the reply model
 * reading catalog lines that all said `Brand: Unknown` — no code path ever asked
 * "which products have brand X?", so brand availability was pure LLM guesswork and
 * a false denial/false yes was unverifiable. This service is the text-lane port of
 * the image lane's working trio (normalize → brand probe → explicit verdict), with
 * the probe widened from the retrieval candidate pool to the FULL tenant catalog —
 * the same window-vs-catalog correction P0-2 applied to the price/name guards.
 *
 * Verdict semantics are deliberately asymmetric with the data reality in mind:
 * the `brand` column is near-empty on real catalogs (1/258 rows on dev), so
 * "no brand-column match" must NOT be read as "brand not carried". A `not_found`
 * verdict is only produced after BOTH probes (brand column + tenant-wide product
 * text) come back empty, and the prompt guidance it produces is phrased by
 * brand-column coverage: honest denial when the column is populated enough to
 * trust, refuse-to-confirm when it is not.
 */
import {
  findActiveProductsByBrandValue,
  listDistinctActiveBrands,
  countActiveBrandCoverage,
  searchProducts,
  type Product,
} from '../db/models/product';

export type BrandMembershipStatus =
  /** The brand column contains this brand — strongest evidence, products enumerated. */
  | 'present_brand_column'
  /** No brand-column hit, but the brand term appears in product name/text — products listed. */
  | 'likely_present_text'
  /** Neither the brand column nor tenant-wide product text matched the brand term. */
  | 'not_found';

export interface BrandMembershipOutcome {
  status: BrandMembershipStatus;
  /** The brand term the verdict is about, as the customer wrote it. */
  brand: string;
  /** Brand-scoped products backing the verdict (empty for not_found). */
  products: Product[];
  /** Active rows with a non-empty brand column vs total active rows. */
  coverage: { with_brand: number; total: number };
}

/** Unicode-aware fold: lowercase, diacritics stripped, non-alphanumerics removed. */
export function foldBrandText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Like foldBrandText but keeps word boundaries, for tokenization and \b regexes. */
function foldKeepingSpaces(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Does the message explicitly ask about a brand/company/manufacturer?
 * Deliberately wider than detectRequestedAttributes' `brand|marka` (which is left
 * untouched — it feeds the gap-gate net, where widening has escalation side
 * effects; see the EV-044 note in processAIReply). This cue only decides whether
 * the deterministic brand probe runs, which has no escalation behavior of its own.
 */
export function hasBrandQuestionCue(message: string): boolean {
  const t = foldKeepingSpaces(message);
  return /\b(brand\w*|brend\w*|mark(a|at|ave|en|es|e)|kompani\w*|compan(y|ies)|prodhues\w*|manufacturer\w*|firm[ae]?)\b/.test(
    t,
  );
}

/**
 * Function words and generic commerce vocabulary that can never be a brand term.
 * Small and bilingual by design — anything not obviously generic stays a candidate,
 * because a missed stopword only costs one cheap indexed probe.
 */
const CANDIDATE_STOPWORDS = new Set([
  // Albanian function/commerce words
  'a', 'e', 'i', 'te', 'me', 'ne', 'nga', 'per', 'dhe', 'ose', 'sa', 'si', 'ju', 'ky', 'kjo',
  'cila', 'cilat', 'cilen', 'cfare', 'qfare', 'qka', 'kete', 'keto', 'ketu', 'aty',
  'keni', 'kini', 'ka', 'kam', 'kemi', 'ke', 'jane', 'eshte', 'osht', 'shes', 'shisni', 'shet',
  'produkt', 'produkte', 'produkti', 'produktet', 'produkteve', 'artikuj', 'artikull',
  'marka', 'marke', 'markat', 'markes', 'brend', 'brendi', 'kompani', 'kompania', 'kompanise',
  'prodhues', 'prodhuesi', 'firma', 'firme', 'gjera', 'dicka', 'tjera', 'tjeter', 'tjetra',
  'ngjashme', 'ngjashem', 'te ngjashme', 'stok', 'gjendje', 'dispozicion',
  // English function/commerce words
  'do', 'you', 'have', 'has', 'any', 'the', 'this', 'that', 'these', 'those', 'from', 'of',
  'sell', 'carry', 'stock', 'got', 'is', 'are', 'there', 'what', 'which', 'brand', 'brands',
  'company', 'companies', 'manufacturer', 'products', 'product', 'items', 'item', 'similar',
  'other', 'more', 'something', 'anything', 'else', 'in', 'available',
]);

/**
 * Candidate brand terms from the message: kept tokens and adjacent-token bigrams
 * (bigrams first — "optimum nutrition" must probe before "optimum"). Pure.
 */
export function extractBrandCandidates(message: string): string[] {
  const tokens = foldKeepingSpaces(message)
    .split(' ')
    .filter((t) => t.length >= 2 && !CANDIDATE_STOPWORDS.has(t));
  const candidates: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    candidates.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  candidates.push(...tokens);
  return [...new Set(candidates)].slice(0, 8);
}

/** Injectable lookups so the membership probe is unit-testable without a database
 * (same idiom as InboundNamePinningDeps). */
export interface BrandMembershipDeps {
  listBrands?: typeof listDistinctActiveBrands;
  byBrand?: typeof findActiveProductsByBrandValue;
  coverage?: typeof countActiveBrandCoverage;
  textSearch?: typeof searchProducts;
}

// 5-minute per-tenant cache of the distinct-brand list: the scan runs on every
// turn (it is what catches "nga Nike" phrasings that carry no brand keyword), so
// it must not cost a query per message. Same idiom as the attribute-availability
// cache; entries are tiny (distinct brands, not products).
const DISTINCT_BRANDS_TTL_MS = 5 * 60 * 1000;
const distinctBrandsCache = new Map<
  string,
  { at: number; rows: Array<{ brand: string; product_count: number }> }
>();

async function loadDistinctBrandsCached(
  tenantId: string,
  listBrands: typeof listDistinctActiveBrands = listDistinctActiveBrands,
): Promise<Array<{ brand: string; product_count: number }>> {
  const hit = distinctBrandsCache.get(tenantId);
  if (hit && Date.now() - hit.at < DISTINCT_BRANDS_TTL_MS) return hit.rows;
  const rows = await listBrands(tenantId);
  distinctBrandsCache.set(tenantId, { at: Date.now(), rows });
  return rows;
}

/** Test seam: clears the distinct-brands cache. */
export function clearBrandMembershipCache(): void {
  distinctBrandsCache.clear();
}

/**
 * The tenant's carried brands (distinct non-empty brand values), 5-min cached.
 * Shared with inbound-name pinning so the brand rung and the membership lane read
 * one list instead of maintaining two caches.
 */
export async function listCarriedBrandsCached(
  tenantId: string,
): Promise<Array<{ brand: string; product_count: number }>> {
  return loadDistinctBrandsCached(tenantId);
}

const BRAND_PRODUCT_LIMIT = 25;

/**
 * Resolve a deterministic brand-membership verdict for an inbound message.
 *
 * Returns null when the turn has no brand signal at all (no known brand mentioned
 * and no brand-question cue) — the caller skips the brand lane entirely, so
 * ordinary turns pay only the cached distinct-brand scan.
 */
export async function resolveBrandMembershipForMessage(
  tenantId: string,
  message: string,
  opts: { attributeIntentBrand?: boolean } = {},
  deps: BrandMembershipDeps = {},
): Promise<BrandMembershipOutcome | null> {
  const byBrand = deps.byBrand ?? findActiveProductsByBrandValue;
  const coverageOf = deps.coverage ?? countActiveBrandCoverage;
  const textSearch = deps.textSearch ?? searchProducts;
  const trimmed = message.trim();
  if (!trimmed) return null;

  const cue = hasBrandQuestionCue(trimmed) || opts.attributeIntentBrand === true;
  const messageFold = foldBrandText(trimmed);
  const candidates = extractBrandCandidates(trimmed);

  // 1. Known-brand scan: catches any phrasing that names a carried brand, cue or not.
  const distinct = await loadDistinctBrandsCached(tenantId, deps.listBrands);
  const matchedBrands = distinct.filter((row) => {
    const brandFold = foldBrandText(row.brand);
    if (!brandFold) return false;
    if (brandFold.length >= 3 && messageFold.includes(brandFold)) return true;
    // Partial brand mention ("Optimum" for "Optimum Nutrition") — candidate token
    // contained in the brand value. ≥3 chars so folded noise can't match.
    return candidates.some((c) => {
      const candidateFold = foldBrandText(c);
      return candidateFold.length >= 3 && brandFold.includes(candidateFold);
    });
  });

  if (matchedBrands.length > 0) {
    const products: Product[] = [];
    const seen = new Set<string>();
    for (const row of matchedBrands.slice(0, 2)) {
      const rows = await byBrand(tenantId, row.brand, BRAND_PRODUCT_LIMIT);
      for (const p of rows) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          products.push(p);
        }
      }
      if (products.length >= BRAND_PRODUCT_LIMIT) break;
    }
    const coverage = await coverageOf(tenantId);
    return {
      status: 'present_brand_column',
      brand: matchedBrands[0].brand,
      products: products.slice(0, BRAND_PRODUCT_LIMIT),
      coverage,
    };
  }

  // No known brand named. Without an explicit brand cue there is nothing to verdict —
  // we cannot know an arbitrary token is a brand.
  if (!cue) return null;

  const coverage = await coverageOf(tenantId);

  // 2. Text-evidence probe: tenant-wide, so a brand that lives only inside product
  // names/descriptions (the near-empty-column reality) is still found. Bounded to the
  // first 3 candidates — bigrams first — each an indexed ILIKE.
  for (const candidate of candidates.slice(0, 3)) {
    const candidateFold = foldBrandText(candidate);
    if (candidateFold.length < 3) continue;
    let rows: Product[] = [];
    try {
      rows = await textSearch(tenantId, candidate, 8);
    } catch (err) {
      console.warn('[brandMembership] Text-evidence probe failed', { tenantId, err });
      continue;
    }
    if (rows.length > 0) {
      return {
        status: 'likely_present_text',
        brand: candidate,
        products: rows,
        coverage,
      };
    }
  }

  // 3. Both probes empty. A not_found verdict is only meaningful when the customer
  // actually NAMED a brand term we could probe. An anaphoric brand question ("Do you
  // have this brand?", "a keni produkte nga kjo marka?") leaves no candidates after
  // stopword folding — "this brand" refers to the previously discussed product, which
  // the contextual resolver owns. Verdicting those turns would inject "no product
  // matches the brand '<question text>'" over a brand we may well carry. Step back
  // instead: null means the brand lane has nothing to say this turn.
  if (candidates.length === 0) return null;

  // The verdict names the most plausible brand term the customer used (first
  // bigram/token candidate) so the guidance can quote it.
  return {
    status: 'not_found',
    brand: candidates[0],
    products: [],
    coverage,
  };
}

/**
 * Catalog-wide brand presence check for the image lane (audit H2).
 *
 * The vision pipeline's `brandLikelyAbsent` was computed against the retrieval
 * CANDIDATE POOL — if fingerprint + text retrieval both missed, a stocked brand was
 * declared "not in catalog" from an empty/irrelevant set (the window-vs-catalog
 * defect P0-2 fixed for the price/name guards). This verifies against the whole
 * tenant catalog before an absent verdict is allowed to stand.
 */
export async function isBrandCarriedInCatalog(
  tenantId: string,
  brand: string,
  deps: BrandMembershipDeps = {},
): Promise<boolean> {
  const textSearch = deps.textSearch ?? searchProducts;
  const brandFold = foldBrandText(brand);
  // Too short to verify safely tenant-wide ("ON" would substring-match everywhere);
  // the caller keeps its narrower pool-based verdict.
  if (brandFold.length < 3) return false;
  const distinct = await loadDistinctBrandsCached(tenantId, deps.listBrands);
  const columnHit = distinct.some((row) => {
    const rowFold = foldBrandText(row.brand);
    return rowFold.includes(brandFold) || (rowFold.length >= 3 && brandFold.includes(rowFold));
  });
  if (columnHit) return true;
  const rows = await textSearch(tenantId, brand.trim(), 1);
  return rows.length > 0;
}

/**
 * Prompt-section text for a brand verdict. The brand-accuracy rules here are the
 * text-lane counterpart of `guidelines.vision_product_images` — which is dropped
 * (`vision_absent`) on every non-image turn, so before this section a typed brand
 * question was answered with no brand rules in the prompt at all.
 */
export function buildBrandMembershipContext(outcome: BrandMembershipOutcome): string {
  const rules = `Brand accuracy rules (IMPORTANT):
- Only confirm carrying a brand when the verdict above says the catalog contains it; name the brand and the matching products when you confirm.
- A different brand of the same product type is NOT the requested brand — never present it as if it were.
- You may name the requested brand to honestly say you do not carry it, and then offer up to 2-3 similar catalog products (clearly as a different brand).
- Never invent a brand name, and never guess which brand a catalog product belongs to.`;

  if (outcome.status === 'present_brand_column') {
    return `
Brand availability (verified against the full catalog):
- The catalog CONTAINS products from the brand "${outcome.brand}" (${outcome.products.length} shown in the product catalog above).
- Confirm availability for this brand using only the listed products.
${rules}`;
  }

  if (outcome.status === 'likely_present_text') {
    return `
Brand availability (verified against the full catalog):
- The term "${outcome.brand}" appears in the catalog product text; the matching products are included in the product catalog above.
- Confirm availability only for those specific products, by name — the catalog's brand labels are incomplete, so do not make broader claims about the brand's range.
${rules}`;
  }

  const coverageRatio =
    outcome.coverage.total > 0 ? outcome.coverage.with_brand / outcome.coverage.total : 0;
  if (coverageRatio >= 0.5) {
    return `
Brand availability (verified against the full catalog):
- No catalog product matches the brand "${outcome.brand}" — the store does not appear to carry it.
- Say so honestly and briefly; you may offer 2-3 similar products from the catalog above, clearly as different brands.
${rules}`;
  }

  return `
Brand availability (verified against the full catalog):
- No catalog product matched the brand "${outcome.brand}", but the catalog's brand labels are largely missing, so absence could not be fully verified.
- Do NOT confirm carrying this brand, and do not firmly deny it either — say you cannot confirm carrying that brand right now, and offer the closest products from the catalog above by name (without attributing them to that brand).
${rules}`;
}