/**
 * P2-5 (RC-25): one shared dialect-normalization layer for the LEXICAL retrieval arm.
 *
 * THE DEFECT THIS FIXES. `extractKeywords` lowercases but KEEPS diacritics, while its sibling
 * `extractCatalogSearchPhrases` NFD-strips them — and both run on the same inbound message in
 * the same call (aiService `matchProductsForCustomerMessage`). So one arm searches `%çokollatë%`
 * and the other `%cokollate%` against a catalog EV-031 shows is spelled inconsistently and
 * EV-030 shows customers type without diacritics at all (0 of 40 real messages carry ë or ç).
 * The keyword stopword list even carries BOTH spellings of every Albanian word by hand
 * ('një'/'nje', 'çfarë'/'cfare', 'shumë'/'shume') precisely because the fold is missing.
 *
 * SCOPE — deliberately the lexical arm only. Not the embedding arm, not the fact index:
 *
 *   - The EMBEDDING arm is already self-consistent (raw query, raw doc) and is left alone.
 *     RC-25 frames the arms as "disagreeing", but they are independent retrievers fused by
 *     RRF: each needs query-vs-doc consistency, not identity with the other. Normalizing only
 *     the query would be the one genuinely broken option — it would put query and document in
 *     different spaces. Normalizing both would flip `hashEmbeddingInput` for 100% of rows and
 *     force a full re-embed (200/6h via the reconcile cron), and EV-043 shows it cannot pay:
 *     the closest distinct neighbour scores 0.594 against a 0.65 floor, a gap no amount of
 *     diacritic folding closes. The threshold, not the representation, is the retrieval defect.
 *   - The FACT INDEX already shares `normalizeText` (groundingGate / catalogGuardReference).
 *     It is a SAFETY surface: folding there widens what counts as "grounded", trading
 *     hallucination-catching for a dialect problem it does not have (EV-031: catalog names are
 *     English brand strings, not Gheg function words).
 *
 * CALIBRATION CONSTRAINT. `normalizeText` (productTitleNormalization) is coupled to the 0.48
 * `word_similarity` threshold in catalogGuardReferenceService — empirically calibrated against
 * a 29-item corpus with a gap of (0.467, 0.500]. This module DELEGATES to it and never
 * modifies it; `dialectNormalization.test.ts` pins the delegation so it cannot be reimplemented.
 *
 * TWO OPERATIONS, DELIBERATELY DIFFERENT SEMANTICS. A single normalize() that rewrites
 * Gheg→Tosk would introduce a bug: EV-031 shows the catalog literally contains "Qokolad
 * Karamel" and "Dubai qokolad". Rewriting a query's 'qokolad'→'cokollate' while the document
 * stays raw (which it must) BREAKS an ILIKE that works today. So:
 *   - FUNCTION words are REWRITTEN (they never appear in product names).
 *   - CONTENT words are EXPANDED, raw form always retained (they do).
 * This layer therefore touches RECALL, never IDENTITY: product id and the structured columns
 * stay authoritative, and no two catalog rows can collapse into one.
 */
import { normalizeText } from './productTitleNormalization';

export const DIALECT_NORMALIZATION =
  (process.env.DIALECT_NORMALIZATION ?? 'false').trim().toLowerCase() === 'true';

/**
 * Gheg → standard-Albanian FUNCTION words. Whole-token rewrites over a closed dictionary.
 *
 * WHOLE-TOKEN ONLY, NEVER SUBSTRING — this is structural, not stylistic. 'ma'→'me' applied as
 * a substring corrupts the catalog's own "Serious Mass"; 'o'→'eshte' would corrupt every word
 * containing an o.
 *
 * Forms taken verbatim from EV-030's traffic profile and RC-25. Two folds the remediation plan
 * proposed are deliberately REJECTED:
 *
 *   - `o` → `eshte`. The plan's mapping lists "osht/o → eshte". EV-030 contains BOTH
 *     "Qysh o moti sot" (o = është) and "O shef qa bone" (o = the vocative "hey"). A bare-'o'
 *     fold corrupts the vocative, and the vocative is the more common of the two.
 *   - merging `kjo` and `keto`. The plan's "qito/qita/qikjo/kto/qeto → keto/kjo" conflates
 *     singular and plural. They are folded to their own number below.
 */
export const GHEG_FUNCTION_WORD_MAP: ReadonlyMap<string, string> = new Map([
  // Comparative: Gheg 'ma' = standard 'më'
  ['ma', 'me'],
  // Interrogative: Gheg 'qfar/qka/qa' = standard 'çfarë'
  ['qfar', 'cfare'],
  ['qfare', 'cfare'],
  ['cfar', 'cfare'],
  ['qka', 'cfare'],
  ['qa', 'cfare'],
  // Copula: Gheg 'osht/asht' = standard 'është'. NOTE: bare 'o' is deliberately absent.
  ['osht', 'eshte'],
  ['oshte', 'eshte'],
  ['asht', 'eshte'],
  // Deictics — plural ('këto') and singular ('kjo') kept distinct.
  ['qita', 'keto'],
  ['qito', 'keto'],
  ['qeto', 'keto'],
  ['qeta', 'keto'],
  ['aito', 'keto'],
  ['kto', 'keto'],
  ['qikjo', 'kjo'],
  ['qkjo', 'kjo'],
  // 'vetëm'
  ['veq', 'vetem'],
  // 'si'
  ['qysh', 'si'],
  // 'ndonjë'
  ['naj', 'ndonje'],
  // 'një'
  ['ni', 'nje'],
  ['nji', 'nje'],
  // Modals: 'mund'
  ['muna', 'mund'],
  ['muni', 'mund'],
  ['munesh', 'mund'],
  // Negation
  ['sun', 'smund'],
  ['ska', 'nuk ka'],
  // Person forms
  ['jom', 'jam'],
  ['kena', 'kemi'],
  // Clipped verb endings
  ['kushtojn', 'kushtojne'],
  ['kan', 'kane'],
  // 'të mirë'
  ['tmir', 'te mire'],
]);

/**
 * Albanian/Gheg CONTENT-word variants. ADDITIVE — the raw form is always retained.
 *
 * These words DO appear in product names, so they must never be rewritten. EV-031: the catalog
 * holds "Vegan Protei 600gr Qokolad Karamel" and "Protein 80 700gr Dubai qokolad" — folding a
 * query's 'qokolad' to 'cokollate' would lose both rows.
 */
export const ALBANIAN_CONTENT_VARIANTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['qokolad', ['cokollate', 'qokollat', 'chocolate']],
  ['qokollat', ['cokollate', 'qokolad', 'chocolate']],
  ['cokollate', ['qokolad', 'qokollat', 'chocolate']],
  ['dredhze', ['luleshtrydhe', 'strawberry']],
  ['dredhza', ['luleshtrydhe', 'strawberry']],
  ['kreatin', ['kreatine', 'creatine']],
  ['kreatine', ['creatine', 'kreatin']],
  ['creatine', ['kreatine', 'kreatin']],
  ['proteina', ['protein', 'proteine']],
  ['protein', ['proteina', 'proteine']],
  // EV-031's truncated catalog row "Vegan Protei 600gr"
  ['protei', ['protein', 'proteina']],
  ['shalqi', ['shalqini', 'watermelon']],
  ['shalqini', ['shalqi', 'watermelon']],
]);

/**
 * The single retrieval stopword list (P2-5): unifies the two divergent copies that had drifted
 * apart — aiService's `extractKeywords` (English + Tosk, both spellings of each word by hand)
 * and productRetrievalService's private shadow copy (less English, far less Albanian, but with
 * 'produkt'/'produkte' that aiService lacks).
 *
 * Entries are stored FOLDED (no diacritics): callers fold before lookup, so 'një' and 'nje'
 * collapse to one entry — the hand-maintained double-spelling burden disappears. Tokens of
 * length <= 2 are dropped by the caller's length filter (except letter+digit product codes
 * like "c4" — see `isAlphanumericCodeToken`), so short entries are informational.
 *
 * Gheg function words are included: EV-030 shows they dominate real traffic and today they pass
 * the filter and become garbage ILIKE terms.
 */
export const RETRIEVAL_STOPWORDS: ReadonlySet<string> = new Set([
  // English
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'can', 'may', 'might', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'between',
  'through', 'after', 'before', 'above', 'below', 'and', 'but', 'or',
  'not', 'no', 'so', 'if', 'then', 'than', 'too', 'very', 'just',
  'that', 'this', 'what', 'which', 'who', 'when', 'where', 'how',
  'all', 'each', 'any', 'both', 'few', 'more', 'most', 'some',
  'hi', 'hello', 'hey', 'thanks', 'thank', 'please', 'ok', 'okay',
  // Albanian (folded — 'një'/'nje' are one entry now)
  'dhe', 'nje', 'per', 'nga', 'ne', 'eshte', 'jam', 'jemi', 'jane',
  'ka', 'kam', 'kemi', 'kane', 'do', 'dua', 'duam', 'mund', 'qe', 'si',
  'cfare', 'cfar', 'kur', 'ku', 'kjo', 'ky', 'ato', 'ata', 'ajo',
  'ai', 'na', 'ju', 'te', 'se', 'por', 'ose', 'nuk', 'jo', 'po',
  'edhe', 'fare', 'shume', 'pak', 'mire', 'keq', 'sot', 'dje',
  'neser', 'tani', 'keni', 'faleminderit', 'pershendetje', 'mirupafshim',
  'ndihme', 'produkt', 'produkte',
  // Gheg function words — these dominate EV-030 traffic and today survive the filter to
  // become ILIKE noise ('qfar', 'kushtojn' etc. as %substring% terms).
  'keto', 'vetem', 'ndonje', 'smund', 'jom', 'kena', 'osht', 'asht',
  'qysh', 'qfar', 'qka', 'veq', 'naj', 'sun', 'ska', 'muna', 'muni',
  'munesh', 'qita', 'qito', 'qeto', 'kto', 'qikjo', 'kushtojn',
  'kushtojne', 'shef', 'okej', 'aha', 'hajde', 'tmir', 'shum',
]);

/**
 * Folds a message to a canonical, diacritic-free, standard-Albanian form for lexical matching.
 *
 * Delegates diacritic folding to `normalizeText` (the calibrated primitive), then rewrites Gheg
 * FUNCTION words whole-token. Punctuation is stripped to spaces first so tokens split cleanly —
 * `normalizeText` itself does not strip punctuation.
 */
export function foldDialect(text: string): string {
  const base = normalizeText((text ?? '').replace(/[^\p{L}\p{N}\s]/gu, ' '));
  if (!base) return '';
  return base
    .split(' ')
    .map((token) => GHEG_FUNCTION_WORD_MAP.get(token) ?? token)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Expands dialect/spelling variants for CONTENT words. Additive and order-stable: every input
 * token is emitted first, in order, before any variant — so a downstream ranker that favours
 * earlier/exact terms still prefers what the customer actually typed. Never drops a token.
 */
export function expandDialectVariants(tokens: string[]): string[] {
  const out: string[] = [...tokens];
  const seen = new Set(tokens);
  for (const token of tokens) {
    for (const variant of ALBANIAN_CONTENT_VARIANTS.get(token) ?? []) {
      if (!seen.has(variant)) {
        seen.add(variant);
        out.push(variant);
      }
    }
  }
  return out;
}

/**
 * A short token that mixes letters and digits ("c4", "b12") is a product/model code, not noise —
 * exempt from the ≥3-char keyword floor. Pure-digit tokens ("30", "60") must NOT qualify: they
 * would ILIKE-match every "30servime" catalog name.
 */
export function isAlphanumericCodeToken(t: string): boolean {
  return t.length >= 2 && /\p{L}/u.test(t) && /\p{N}/u.test(t);
}

/**
 * The lexical keyword pipeline: fold → tokenize → drop stopwords/short tokens → expand variants.
 * This is what `extractKeywords` becomes when DIALECT_NORMALIZATION is on.
 */
export function extractDialectKeywords(text: string): string[] {
  const folded = foldDialect(text);
  if (!folded) return [];
  const tokens = folded
    .split(' ')
    .filter((w) => (w.length > 2 || isAlphanumericCodeToken(w)) && !RETRIEVAL_STOPWORDS.has(w));
  return expandDialectVariants(tokens);
}
