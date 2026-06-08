/**
 * Shared, dependency-free product-title normalization and attribute parsing.
 *
 * Problem this solves
 * -------------------
 * Catalog product names frequently bundle variant attributes into the title, e.g.
 *   "Creatine Monohydrate 50 Servings"
 *   "Strawberry Whey Protein 2kg"
 * while a customer's photo (and the vision extraction from it) often shows only the
 * BASE product name ("creatine monohydrate"). A naive contiguous `ILIKE '%query%'`
 * over the whole title then either misses the match (extra attributes break the
 * contiguity) or fails to distinguish variants.
 *
 * This module is the single source of truth for:
 *  - splitting a raw title into a stable BASE NAME + the variant attributes, and
 *  - turning free text into match tokens, and
 *  - scoring how well one set of attributes overlaps another (for re-ranking).
 *
 * It is intentionally pure (no I/O, no DB, no network) so it can be unit-tested
 * exhaustively and reused by both the order-resolution and image-matching paths.
 */

/** Canonicalises unit spellings so "servings"/"serv"/"scoops" all collapse to one key. */
export const UNIT_SYNONYMS: Record<string, string> = {
  serving: 'serving',
  servings: 'serving',
  serv: 'serving',
  scoop: 'serving',
  scoops: 'serving',
  g: 'g',
  gr: 'g',
  gram: 'g',
  grams: 'g',
  kg: 'kg',
  ml: 'ml',
  l: 'l',
  lt: 'l',
  oz: 'oz',
  lb: 'lb',
  lbs: 'lb',
  pound: 'lb',
  pounds: 'lb',
  cap: 'cap',
  caps: 'cap',
  capsule: 'cap',
  capsules: 'cap',
  tab: 'tablet',
  tabs: 'tablet',
  tablet: 'tablet',
  tablets: 'tablet',
  pcs: 'pcs',
  count: 'pcs',
  ct: 'pcs',
};

/** Flavour vocabulary used both to strip flavours from a base name and to detect them. */
export const FLAVOR_WORDS = [
  'cookies and cream',
  'cookies & cream',
  'chocolate',
  'vanilla',
  'strawberry',
  'berry',
  'unflavored',
  'unflavoured',
  'banana',
  'mango',
  'lemon',
  'orange',
  'mint',
  'caramel',
  'coffee',
  'cream',
  'peanut',
  'cola',
  'watermelon',
  'peach',
  'pineapple',
  'coconut',
  'neutral',
];

/** Colour vocabulary used both to strip colours from a base name and to detect them. */
export const COLOR_WORDS = [
  'red',
  'blue',
  'black',
  'white',
  'green',
  'yellow',
  'pink',
  'purple',
  'grey',
  'gray',
  'silver',
  'gold',
];

/** Tokens that carry no identifying value when matching a product family. */
const MATCH_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'of',
  'a',
  'an',
  'plus',
  'new',
  'original',
  'pack',
  'size',
  'flavor',
  'flavour',
]);

export interface SelectionAttributes {
  /** Normalised "number + unit" tokens, e.g. "50serving", "2kg". Strongest signal. */
  sizeSignatures: string[];
  /** Flavour words detected in the text. */
  flavors: string[];
  /** Colour words detected in the text. */
  colors: string[];
  /** Bare numbers with no attached unit, e.g. "50". Weakest signal. */
  bareNumbers: string[];
}

/**
 * Tenant-supplied attribute vocabulary that EXTENDS (never replaces) the built-in
 * English defaults. Sourced from the tenant's own catalog so non-English / niche
 * flavours and colours (e.g. "luleshtrydhe", "forest fruits") are recognised when
 * parsing both customer photos and catalog titles.
 */
export interface AttributeVocabulary {
  flavors: string[];
  colors: string[];
}

export interface ParsedProductTitle {
  /** The original, trimmed title. */
  raw: string;
  /** The title with variant attributes (size/flavour/colour/parens) stripped out. */
  baseName: string;
  /** Significant, lower-cased base-name tokens used for AND-style retrieval. */
  baseTokens: string[];
  /** The variant attributes parsed out of the full title. */
  attributes: SelectionAttributes;
}

/** Lower-cases, strips diacritics, and collapses whitespace. Deterministic. */
export function normalizeText(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeUnit(rawUnit: string): string | null {
  const key = rawUnit.toLowerCase().replace(/\.$/, '');
  return UNIT_SYNONYMS[key] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest-first alternation so multi-word flavours ("cookies and cream") win over
// their sub-words ("cream") and longer units win over shorter ones.
const UNIT_ALT = Object.keys(UNIT_SYNONYMS)
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join('|');
const FLAVOR_COLOR_ALT = [...FLAVOR_WORDS, ...COLOR_WORDS]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join('|');

const SIZE_TOKEN_RE = new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*(?:${UNIT_ALT})\\b`, 'gi');
const FLAVOR_COLOR_RE = new RegExp(`\\b(?:${FLAVOR_COLOR_ALT})\\b`, 'gi');

/**
 * Extracts the variant-distinguishing attributes from a piece of text (a customer
 * message OR a product title). Pure and deterministic.
 */
export function extractSelectionAttributes(text: string): SelectionAttributes {
  const t = normalizeText(text);

  const sizeSignatures = new Set<string>();
  const bareNumbers = new Set<string>();

  // number + unit (e.g. "50 servings", "2kg", "500 g")
  const numberUnitRe = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let m: RegExpExecArray | null;
  const consumedNumbers = new Set<string>();
  while ((m = numberUnitRe.exec(t)) !== null) {
    const num = m[1];
    const unit = normalizeUnit(m[2]);
    if (unit) {
      sizeSignatures.add(`${num}${unit}`);
      consumedNumbers.add(num);
    }
  }

  // bare numbers not already paired with a recognised unit
  const numberRe = /\b(\d+(?:\.\d+)?)\b/g;
  while ((m = numberRe.exec(t)) !== null) {
    const num = m[1];
    if (!consumedNumbers.has(num)) bareNumbers.add(num);
  }

  // Word-boundary matching (not substring) so e.g. "cola" is not detected inside
  // "chocolate" and "berry" is not detected inside "strawberry".
  const flavors = FLAVOR_WORDS.filter((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(t));
  const colors = COLOR_WORDS.filter((w) => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(t));

  return {
    sizeSignatures: [...sizeSignatures],
    flavors,
    colors,
    bareNumbers: [...bareNumbers],
  };
}

/**
 * Strips variant attributes (parentheticals, size/unit tokens, flavour/colour words)
 * from a product title, leaving the stable family base name. Optionally caps the word
 * count so very long, descriptive titles do not produce an over-specific base.
 */
export function extractBaseName(name: string, maxWords = 8): string {
  let base = (name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(SIZE_TOKEN_RE, ' ')
    .replace(FLAVOR_COLOR_RE, ' ')
    .replace(/[-–—|,/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = base.split(/\s+/).filter((w) => w.length > 1);
  if (words.length > maxWords) {
    base = words.slice(0, maxWords).join(' ');
  }
  return base.length >= 3 ? base : (name ?? '').trim().slice(0, 40);
}

/**
 * Tokenises text into significant lower-cased match tokens: drops punctuation,
 * stopwords, single characters, and bare numbers (numbers are variant attributes,
 * not identity, so they must not be used as hard AND filters).
 */
export function tokenizeForMatch(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of normalizeText(text).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    const t = tok.trim();
    if (t.length < 2) continue;
    if (MATCH_STOPWORDS.has(t)) continue;
    if (/^\d+(?:\.\d+)?$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Parses a raw catalog/extraction title into its base name, tokens, and attributes. */
export function parseProductTitle(name: string, maxBaseWords = 8): ParsedProductTitle {
  const raw = (name ?? '').trim();
  const baseName = extractBaseName(raw, maxBaseWords);
  return {
    raw,
    baseName,
    baseTokens: tokenizeForMatch(baseName),
    attributes: extractSelectionAttributes(raw),
  };
}

function hasIntersection(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const setB = new Set(b);
  return a.some((x) => setB.has(x));
}

function numericTokens(attrs: SelectionAttributes): string[] {
  return [
    ...attrs.bareNumbers,
    ...attrs.sizeSignatures.map((s) => s.match(/^\d+(?:\.\d+)?/)?.[0] ?? ''),
  ].filter(Boolean);
}

/** True when the attribute set carries at least one usable signal. */
export function hasAnyAttribute(attrs: SelectionAttributes): boolean {
  return (
    attrs.sizeSignatures.length > 0 ||
    attrs.flavors.length > 0 ||
    attrs.colors.length > 0 ||
    attrs.bareNumbers.length > 0
  );
}

/**
 * Scores how strongly a candidate's attributes match the query's. Weighted from the
 * strongest signal (exact size/unit signature) to the weakest (a bare number overlap).
 */
export function attributeOverlapScore(
  query: SelectionAttributes,
  candidate: SelectionAttributes,
): number {
  let score = 0;
  if (hasIntersection(query.sizeSignatures, candidate.sizeSignatures)) score += 3;
  if (hasIntersection(query.flavors, candidate.flavors)) score += 2;
  if (hasIntersection(query.colors, candidate.colors)) score += 1;
  if (hasIntersection(numericTokens(query), numericTokens(candidate))) score += 0.5;
  return score;
}

/** Minimal structural shape needed to derive a product's attributes for ranking. */
export interface AttributeRankable {
  name: string;
  flavor?: string | null;
  size?: string | null;
  weight?: string | null;
  color?: string | null;
  variant?: string | null;
}

/** Collects a product's attributes from its title plus structured columns. */
export function productAttributes(product: AttributeRankable): SelectionAttributes {
  return extractSelectionAttributes(
    [
      product.name,
      product.size ?? '',
      product.weight ?? '',
      product.flavor ?? '',
      product.color ?? '',
      product.variant ?? '',
    ].join(' '),
  );
}

/**
 * Stable re-rank of candidate products by how well their attributes overlap the query
 * attributes. Products that match the photo's flavour/size/servings rise to the top;
 * ties preserve the incoming order. When the query carries no attributes the input is
 * returned unchanged (nothing to disambiguate on).
 */
export function rankProductsByAttributeOverlap<T extends AttributeRankable>(
  products: T[],
  query: SelectionAttributes,
): T[] {
  if (!hasAnyAttribute(query) || products.length < 2) return products;
  return products
    .map((product, index) => ({
      product,
      index,
      score: attributeOverlapScore(query, productAttributes(product)),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.product);
}
