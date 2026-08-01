/**
 * Inbound-name pinning — deterministic recovery of products the customer EXPLICITLY NAMED
 * in their message, so they can be force-included in the retrieval context pool.
 *
 * Why this exists (live bug, conv ee183c2e, 2026-07-20): "Sa kushton nitro tech ripped?"
 * was classified as a price-only follow-up, so the context pool was the PREVIOUS turn's
 * persisted products (10 pre-workout rows) and fresh retrieval never ran. "Nitro Tech
 * Ripped" — an exact active catalog name — was not in the injected pool, and platform rule
 * R6 ("if a product is not in the catalog, say it is unavailable") turned the retrieval
 * miss into a confident FALSE "we don't carry it". Pinning makes that impossible for any
 * product the customer names: a deterministic catalog lookup on the inbound text runs
 * before the pool is finalized, and its hits can never be evicted by stale context.
 *
 * Second live gap, closed the same day: a FRESH (non-contextual) query naming a product in
 * Albanianized/inflected single-token form — "A e keni kreatinen?" — missed every fusion
 * source (ILIKE can't bridge k↔c, the variants map covers lemmas only, embeddings fell
 * short) and produced a blind "Po." over an EMPTY pool. The ladder therefore also runs as
 * a gap detector on the fresh path (aiService), and carries a dialect-variant rung plus a
 * trigram rung. Deliberately NOT done: adding inflected forms to ALBANIAN_CONTENT_VARIANTS
 * (whack-a-mole per form — the stem ladder is the systematic bridge) or any change to
 * extractDialectKeywords/fusion itself.
 *
 * Pure and DB-injectable, mirroring productImageRequestService.ts: unit tests stub
 * `bySubstring` and never touch a database or the OpenAI client.
 */
import type { Product } from '../db/models/product';
import {
  findActiveProductsByNameSubstring,
  findActiveProductsByNameSimilarity,
  findActiveProductsByBrandValue,
} from '../db/models/product';
import { foldBrandText, listCarriedBrandsCached } from './brandMembershipService';
import { knobNumber } from '../config/knobs';
import { normalizeText } from './productTitleNormalization';
import { RETRIEVAL_STOPWORDS, expandDialectVariants } from './dialectNormalization';
import {
  albanianTokenStems,
  productNameTokenMatch,
  stemmedSearchTerm,
  bySpecificity,
  filterProductsMentionedInTexts,
} from './productImageRequestService';

/** Max products one inbound message may pin into the context pool. */
const INBOUND_PIN_MAX_PRODUCTS = 3;
/** Hard budget of catalog lookups per turn (all rungs incl. trigram) — pinning must stay cheap. */
const INBOUND_PIN_MAX_LOOKUPS = 8;
/** Max candidate n-grams considered per message. */
const INBOUND_PIN_MAX_GRAMS = 8;
/** Per-gram cap on dialect-variant lookups (rung 3). */
const INBOUND_PIN_MAX_VARIANT_LOOKUPS = 2;
/** pg_trgm floor for the typo-recovery trigram rung. */
const INBOUND_PIN_SIMILARITY_THRESHOLD = knobNumber('INBOUND_PIN_SIMILARITY_THRESHOLD');

/**
 * Price/quantity cue words that are NOT in RETRIEVAL_STOPWORDS but must never anchor a
 * name gram — "sa kushton nitro tech ripped" should produce grams about the product, not
 * about the question ("kushtojn"/"kushtojne" are already stopwords; the singular forms and
 * the English price words are not).
 */
const PIN_EXTRA_STOPWORDS: ReadonlySet<string> = new Set([
  'sa', 'kushton', 'kushtoi', 'kushtuan', 'kushto',
  'cmim', 'cmimi', 'qmim', 'qmimi', 'qmimin', 'cmimin',
  'price', 'cost', 'costs', 'much', 'how',
  // "other options" words — "a keni tjera?" must never burn ladder budget as a uni-gram.
  'tjera', 'tjeter', 'tjetra',
]);

/** Lower-case, diacritic-free, punctuation-to-space fold (same shape as productImageRequestService). */
function foldForMatch(text: string): string {
  return normalizeText((text ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' '));
}

function isStopToken(token: string): boolean {
  return RETRIEVAL_STOPWORDS.has(token) || PIN_EXTRA_STOPWORDS.has(token);
}

/**
 * Candidate product-name n-grams from a folded inbound message: tri- and bi-grams with
 * stopword edges trimmed (question filler never anchors a gram) and interior-stopword
 * grams dropped ("kreatinen edhe nitro" can never token-match a catalog name — every
 * gram token must appear in the name — so it would only burn lookup budget), plus
 * GUARDED uni-grams (length ≥5, non-stopword) for tokens no surviving multi-gram
 * covers — this is what lets a lone Albanianized name ("kreatinen") reach the ladder.
 *
 * Two-tier order: multi-grams (highest precision) longest-first, then uni-grams.
 *
 * "sa kushton nitro tech ripped" → ["nitro tech ripped", "tech ripped", "nitro tech"]
 * "A e keni kreatinen?"          → ["kreatinen"]
 * "sa kushton?" / "a e keni kete?" / "a keni tjera?" → []
 */
export function extractCandidateNameGrams(inbound: string): string[] {
  const tokens = foldForMatch(inbound)
    .split(' ')
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return [];

  const multiGrams: string[] = [];
  const seen = new Set<string>();
  const coveredTokens = new Set<string>();
  const push = (slice: string[]): void => {
    let start = 0;
    let end = slice.length;
    while (start < end && isStopToken(slice[start])) start++;
    while (end > start && isStopToken(slice[end - 1])) end--;
    const trimmed = slice.slice(start, end);
    if (trimmed.length < 2) return; // uni-grams handled separately below
    if (trimmed.some(isStopToken)) return; // interior stopword → can never match a name
    const gram = trimmed.join(' ');
    if (gram.length < 5) return;
    if (!seen.has(gram)) {
      seen.add(gram);
      multiGrams.push(gram);
      for (const t of trimmed) coveredTokens.add(t);
    }
  };

  for (let size = 3; size >= 2; size--) {
    for (let i = 0; i + size <= tokens.length; i++) {
      push(tokens.slice(i, i + size));
    }
  }

  const uniGrams: string[] = [];
  for (const token of tokens) {
    if (
      token.length >= 5 &&
      !isStopToken(token) &&
      !coveredTokens.has(token) &&
      !seen.has(token)
    ) {
      seen.add(token);
      uniGrams.push(token);
    }
  }

  multiGrams.sort((a, b) => b.length - a.length);
  uniGrams.sort((a, b) => b.length - a.length);
  return [...multiGrams, ...uniGrams].slice(0, INBOUND_PIN_MAX_GRAMS);
}

/**
 * Availability-denial wording (folded form: lower-case, diacritics stripped, punctuation →
 * spaces, so "s'kemi" is "s kemi" and "don't" is "don t"). Substring-matched against a
 * single folded CLAUSE, never the whole reply.
 */
const DENIAL_MARKERS: readonly string[] = [
  'nuk e kemi', 'nuk i kemi', 'nuk kemi', 's kemi', 'ska ne dispozicion',
  'nuk eshte ne dispozicion', 'nuk jane ne dispozicion', 'nuk gjendet', 'nuk gjenden',
  'nuk e mbajme', 'nuk mbajme', 'nuk e ofrojme', 'nuk ofrojme', 'nuk e shesim', 'nuk shesim',
  'not available', 'no longer available', 'unavailable',
  'do not carry', 'don t carry', 'do not have', 'don t have',
  'do not sell', 'don t sell', 'do not stock', 'do not offer', 'don t offer',
];

/** Contrast conjunctions that start a new clause ("X nuk e kemi, POR ju sugjerojmë Y"). */
const CLAUSE_CONJUNCTION_RE = /\b(?:por|mirepo|megjithate|ndersa|kurse|but|however)\b/;

/**
 * Which of `products` the reply actually DENIES — i.e. mentions inside a clause that
 * carries availability-denial wording. Clause-scoped on purpose: an R13-compliant reply
 * routinely denies one product and OFFERS others in the same breath ("X nuk e kemi, por
 * ju sugjerojmë Y"), and a whole-reply mention check would wrongly count the offered Y
 * as denied. Sentences split on terminal punctuation and newlines, then on contrast
 * conjunctions, so the denial clause and the offer clause are scored separately.
 */
export function productsDeniedInReply(products: Product[], replyText: string): Product[] {
  if (products.length === 0 || !replyText?.trim()) return [];

  const clauses = replyText
    .split(/[.!?;\n]+/)
    .map(foldForMatch)
    .flatMap((folded) => folded.split(CLAUSE_CONJUNCTION_RE))
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  const denialClauses = clauses.filter((clause) =>
    DENIAL_MARKERS.some((marker) => clause.includes(marker)),
  );
  if (denialClauses.length === 0) return [];

  const denied: Product[] = [];
  const seen = new Set<string>();
  for (const clause of denialClauses) {
    for (const product of filterProductsMentionedInTexts(products, [clause])) {
      if (!seen.has(product.id)) {
        seen.add(product.id);
        denied.push(product);
      }
    }
    // Audit H1: brand-level denial. "Nuk kemi produkte nga Nike" names no product, so
    // the name matcher above can never trip — but if a pinned product's BRAND appears
    // inside the denial clause, the denial covers that product all the same. ≥3-char
    // folded brands only, so noise folds can't match.
    for (const product of products) {
      if (seen.has(product.id)) continue;
      const brandFold = product.brand ? foldForMatch(product.brand).trim() : '';
      if (brandFold.length >= 3 && clause.includes(brandFold)) {
        seen.add(product.id);
        denied.push(product);
      }
    }
  }
  return denied;
}

/** Injectable lookups so the resolution ladder is unit-testable without a database. */
export interface InboundNamePinningDeps {
  bySubstring?: typeof findActiveProductsByNameSubstring;
  bySimilarity?: typeof findActiveProductsByNameSimilarity;
  byBrand?: typeof findActiveProductsByBrandValue;
  carriedBrands?: typeof listCarriedBrandsCached;
}

/**
 * The resolution ladder over pre-extracted grams. Deterministic and bounded — per gram:
 *   1. raw ILIKE + token filter ("nitro tech" hits every Nitro Tech variant);
 *   2. stemmed-token ILIKE + token filter (inflections: "nitro techin" → "%tech%");
 *   3. dialect-variant ILIKE + token filter — the Albanianized-orthography bridge
 *      ("kreatinen" → stem "kreatine" → curated variant "creatine" → ILIKE hit); this
 *      rung, not trigram similarity, is what covers the k↔c spelling class
 *      (word_similarity('kreatinen','Creatine …') ≈ 0.36, inside the fabrication band);
 *   4. pg_trgm word_similarity at the calibrated floor — real TYPOS only, no token
 *      filter (trgm bridges exactly the shapes the token filter would reject).
 * Capped at INBOUND_PIN_MAX_PRODUCTS results and INBOUND_PIN_MAX_LOOKUPS queries across
 * all rungs; never throws — pinning is an enhancement and must never break a reply.
 *
 * Exported separately from `resolveInboundNamedProducts` so the fresh-retrieval gap
 * detector in aiService can resolve ONLY the grams its fused pool failed to cover.
 */
export async function resolveGramsToProducts(
  tenantId: string,
  grams: string[],
  deps: InboundNamePinningDeps = {},
): Promise<Product[]> {
  const bySubstring = deps.bySubstring ?? findActiveProductsByNameSubstring;
  const bySimilarity = deps.bySimilarity ?? findActiveProductsByNameSimilarity;
  if (grams.length === 0) return [];

  const pinned: Product[] = [];
  const pinnedIds = new Set<string>();
  let lookups = 0;

  try {
    for (const gram of grams) {
      if (pinned.length >= INBOUND_PIN_MAX_PRODUCTS) break;
      if (lookups >= INBOUND_PIN_MAX_LOOKUPS) break;

      const queried = new Set<string>([gram]);

      // Rung 1: raw substring + token filter.
      lookups++;
      let matches = (await bySubstring(tenantId, gram, 25)).filter((p) =>
        productNameTokenMatch(gram, p.name),
      );

      // Rung 2: stemmed-token substring, same token filter.
      if (matches.length === 0 && lookups < INBOUND_PIN_MAX_LOOKUPS) {
        const term = stemmedSearchTerm(gram);
        if (term && !queried.has(term)) {
          queried.add(term);
          lookups++;
          matches = (await bySubstring(tenantId, term, 25)).filter((p) =>
            productNameTokenMatch(gram, p.name),
          );
        }
      }

      // Rung 3: dialect-variant substring. For each Albanian stem of each gram token,
      // consult the curated ALBANIAN_CONTENT_VARIANTS map; a NEW variant term is ILIKE'd
      // and candidates are token-filtered against the gram with the token substituted
      // ("kreatinen"→"creatine" makes tokenMatch('creatine', 'Creatine Monohydrate …')
      // pass). Bounded to INBOUND_PIN_MAX_VARIANT_LOOKUPS queries per gram.
      if (matches.length === 0) {
        const gramTokens = foldForMatch(gram).split(' ').filter(Boolean);
        let variantLookups = 0;
        outer: for (const token of gramTokens) {
          for (const stem of albanianTokenStems(token)) {
            for (const variant of expandDialectVariants([stem])) {
              if (variant === stem || variant === token) continue;
              if (variant.length < 4 || queried.has(variant)) continue;
              if (
                variantLookups >= INBOUND_PIN_MAX_VARIANT_LOOKUPS ||
                lookups >= INBOUND_PIN_MAX_LOOKUPS
              ) {
                break outer;
              }
              queried.add(variant);
              variantLookups++;
              lookups++;
              const variantGram = gramTokens
                .map((t) => (t === token ? variant : t))
                .join(' ');
              const rows = (await bySubstring(tenantId, variant, 25)).filter((p) =>
                productNameTokenMatch(variantGram, p.name),
              );
              if (rows.length > 0) {
                matches = rows;
                break outer;
              }
            }
          }
        }
      }

      // Rung 4: trigram similarity — typo recovery at the calibrated floor. No token
      // filter, ≥5-char grams only. (Brand mentions are deliberately NOT a ladder rung:
      // brands are a closed per-tenant set, so they resolve via the separate
      // resolveBrandTokenPins pass — exact folded match against the carried-brand list —
      // without burning ladder lookup budget on every non-brand gram.)
      if (matches.length === 0 && gram.length >= 5 && lookups < INBOUND_PIN_MAX_LOOKUPS) {
        lookups++;
        matches = await bySimilarity(tenantId, gram, INBOUND_PIN_SIMILARITY_THRESHOLD, 10);
      }

      if (matches.length === 0) continue;

      matches.sort(bySpecificity(gram));
      for (const product of matches) {
        if (pinned.length >= INBOUND_PIN_MAX_PRODUCTS) break;
        if (!pinnedIds.has(product.id)) {
          pinnedIds.add(product.id);
          pinned.push(product);
        }
      }
    }
  } catch {
    return [];
  }

  return pinned;
}

/**
 * Short-brand pinning pass (audit H1). Gram extraction has a ≥5-char floor (below it,
 * uni-grams are noise), which makes 3-4 char brands ("Nike", "GNC", "BSN") structurally
 * unpinnable through the ladder. Brands are a CLOSED SET per tenant though, so short
 * tokens can be safely resolved by exact folded equality against the carried-brand list
 * (plus containment for ≥4-char partials like "optimum" → "Optimum Nutrition") — no
 * fuzziness, no floor. Never throws; [] on any failure.
 */
export async function resolveBrandTokenPins(
  tenantId: string,
  inbound: string,
  deps: InboundNamePinningDeps = {},
): Promise<Product[]> {
  const byBrand = deps.byBrand ?? findActiveProductsByBrandValue;
  const carriedBrands = deps.carriedBrands ?? listCarriedBrandsCached;

  try {
    const tokens = foldForMatch(inbound)
      .split(' ')
      .filter((t) => t.length >= 2 && !isStopToken(t));
    if (tokens.length === 0) return [];
    const grams = new Set<string>(tokens);
    for (let i = 0; i + 1 < tokens.length; i++) {
      grams.add(`${tokens[i]} ${tokens[i + 1]}`);
    }

    const brands = await carriedBrands(tenantId);
    const matched: string[] = [];
    for (const row of brands) {
      const brandFold = foldBrandText(row.brand);
      if (!brandFold) continue;
      const hit = [...grams].some((g) => {
        const gramFold = foldBrandText(g);
        if (!gramFold) return false;
        if (gramFold === brandFold) return true;
        return gramFold.length >= 4 && brandFold.includes(gramFold);
      });
      if (hit) matched.push(row.brand);
      if (matched.length >= 2) break;
    }

    const pinned: Product[] = [];
    const seen = new Set<string>();
    for (const brand of matched) {
      const rows = await byBrand(tenantId, brand, INBOUND_PIN_MAX_PRODUCTS);
      for (const p of rows) {
        if (pinned.length >= INBOUND_PIN_MAX_PRODUCTS) return pinned;
        if (!seen.has(p.id)) {
          seen.add(p.id);
          pinned.push(p);
        }
      }
    }
    return pinned;
  } catch {
    return [];
  }
}

/**
 * Resolves the active catalog products the inbound message explicitly names:
 * gram extraction + the resolution ladder above, then the short-brand pass (H1) for
 * brand mentions the gram floor cannot reach.
 */
export async function resolveInboundNamedProducts(
  tenantId: string,
  inbound: string,
  deps: InboundNamePinningDeps = {},
): Promise<Product[]> {
  const pinned = await resolveGramsToProducts(tenantId, extractCandidateNameGrams(inbound), deps);
  if (pinned.length >= INBOUND_PIN_MAX_PRODUCTS) return pinned;
  const brandPins = await resolveBrandTokenPins(tenantId, inbound, deps);
  if (brandPins.length === 0) return pinned;
  const seen = new Set(pinned.map((p) => p.id));
  return [...pinned, ...brandPins.filter((p) => !seen.has(p.id))].slice(
    0,
    INBOUND_PIN_MAX_PRODUCTS,
  );
}
