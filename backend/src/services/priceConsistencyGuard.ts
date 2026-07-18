/**
 * Price-consistency validation for outbound AI replies.
 *
 * Guarantees: an AI reply must never state a concrete price that is NOT present
 * in the catalog knowledge for the matched products. This closes the hallucinated-
 * price risk (the LLM making up a price not in any matched product) and the cross-
 * message price-inconsistency risk (the model quoting a different price in turn N+2
 * than it quoted in turn N for the same product).
 *
 * Architecture
 * ─────────────
 *  1. buildCatalogPriceSet() — extracts every concrete price (base + discounted)
 *     from the matched products and normalizes them to a canonical numeric form.
 *  2. extractStatedPrices() — deterministically extracts price values from the
 *     reply text using multi-locale regex (€, ALL, LEK, plain numbers in context).
 *  3. validateReplyPrices()  — pure predicate; returns false when the reply states
 *     a price not in the catalog set (within a small rounding tolerance).
 *  4. filterHallucinatedPrices() — produces an audit list of stated prices that
 *     have no matching catalog entry (empty = no hallucination detected).
 *
 * Intentionally performs NO I/O — pure and fully unit-testable in-process.
 * The caller (processAIReply.ts) decides whether to escalate or log; this
 * module only provides the detection.
 */

/** Rounding tolerance: two prices are considered the same if they differ by ≤ PRICE_EPSILON. */
const PRICE_EPSILON = 0.01;

export interface CatalogPriceSet {
  /** Normalized numeric prices extracted from the catalog (base + discounted, all products). */
  prices: number[];
}

export interface StatedPrice {
  /** The raw string as it appeared in the reply. */
  raw: string;
  /** Parsed numeric value (NaN when parsing failed). */
  value: number;
}

/**
 * Numeric core shared by every price pattern. Alternation order matters — the grouped
 * (thousands-separated) forms must be tried BEFORE the plain form: with the plain-only core,
 * "1.250,50€" extracted as "250,50" (the regex latched onto the tail after the thousands dot), so
 * a CORRECT €1.250,50 statement failed the catalog check and was stripped as a hallucination — an
 * EV-011-class false positive for any product priced over €1,000.
 */
const PRICE_NUM = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,7}(?:[.,]\d{1,2})?`;

/**
 * Patterns for price mentions in a reply, supporting:
 *   - "€12.50", "€ 12", "€12,50" (European comma notation), "€1.250,50" (grouped)
 *   - "12.50 EUR", "12.50 €"
 *   - "ALL 1250", "1250 ALL", "1250 LEK", "12,500 LEK" (Albanian lek, grouped)
 *
 * A bare number with NO currency marker ("çmimi është 12.50", "500g", "2 cope", "20%", a phone
 * number) is deliberately NOT extracted: requiring the marker is what keeps the guard's
 * over-reach at zero on weights/quantities/percentages (pinned in priceConsistencyGuard.test.ts).
 *
 * Captures the numeric part (group 1) so the caller can reconstruct the raw string for logging.
 */
const PRICE_PATTERNS: RegExp[] = [
  // Currency symbol prefix: €12, € 12, €12.50, €12,50, €1.250,50
  new RegExp(String.raw`€\s*(${PRICE_NUM})`, 'g'),
  // Currency symbol suffix: 12.50 €, 12 €, 1.250,50 €
  new RegExp(String.raw`(${PRICE_NUM})\s*€`, 'g'),
  // EUR suffix: 12.50 EUR
  new RegExp(String.raw`(${PRICE_NUM})\s*EUR\b`, 'gi'),
  // Albanian lek prefix or suffix: ALL 1250, 1250 ALL, 1250 LEK, LEK 1250
  new RegExp(String.raw`(?:ALL|LEK)\s*(${PRICE_NUM})`, 'gi'),
  new RegExp(String.raw`(${PRICE_NUM})\s*(?:ALL|LEK)\b`, 'gi'),
];

/** Normalize a price string to a canonical float (European "1.250,50" / US "1,250.50" handled). */
function normalizePrice(raw: string): number {
  const s = raw.trim();
  // European thousands separator, optional comma decimal: "1.250" / "1.250,50" → 1250.50
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(s)) {
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  // US thousands separator, optional dot decimal: "12,500" / "1,250.50" → 1250.50
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(s)) {
    return parseFloat(s.replace(/,/g, ''));
  }
  // Comma as decimal separator: "12,50" → 12.50
  if (/^\d+,\d{1,2}$/.test(s)) {
    return parseFloat(s.replace(',', '.'));
  }
  return parseFloat(s.replace(',', '.'));
}

function pricesAreEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= PRICE_EPSILON;
}

/**
 * Extract every concrete price value mentioned in the reply text.
 * Returns a de-duplicated list ordered by position of first occurrence.
 */
export function extractStatedPrices(replyText: string): StatedPrice[] {
  const text = replyText ?? '';
  const seen = new Set<string>();
  const results: StatedPrice[] = [];

  for (const pattern of PRICE_PATTERNS) {
    // Use a fresh lastIndex for each iteration (patterns have /g flag).
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const numericPart = match[1]?.trim();
      if (!numericPart) continue;
      if (seen.has(numericPart)) continue;
      seen.add(numericPart);
      const value = normalizePrice(numericPart);
      if (!Number.isFinite(value)) continue;
      results.push({ raw: numericPart, value });
    }
  }

  return results;
}

/**
 * Build the set of valid prices the reply is allowed to state, derived from
 * the matched products' base prices and discounted prices.
 */
export function buildCatalogPriceSet(
  products: Array<{ price: number; discounted_price: number | null }>,
): CatalogPriceSet {
  const prices: number[] = [];
  for (const p of products) {
    if (Number.isFinite(p.price)) prices.push(p.price);
    if (p.discounted_price != null && Number.isFinite(p.discounted_price)) {
      prices.push(p.discounted_price);
    }
  }
  return { prices };
}

/**
 * Return the stated prices (from the reply) that do NOT match ANY price in the catalog
 * set. An empty return means no hallucinated prices were detected.
 *
 * Tolerant:
 *   - The reply is only inspected when matched products exist AND at least one price is
 *     stated. If the catalog set is empty we assume the AI couldn't get a price from the
 *     catalog and allow the reply as-is (fail-open for no-product-context turns).
 *   - Cross-currency comparisons (€ vs ALL) are not attempted; only prices with the same
 *     numeric value are matched, so a genuine multi-currency mismatch is left to the
 *     quality evaluator.
 */
export function filterHallucinatedPrices(
  replyText: string,
  catalogPriceSet: CatalogPriceSet,
): StatedPrice[] {
  if (catalogPriceSet.prices.length === 0) return [];
  const stated = extractStatedPrices(replyText);
  if (stated.length === 0) return [];
  return stated.filter(
    (s) => !catalogPriceSet.prices.some((c) => pricesAreEqual(s.value, c)),
  );
}

/**
 * True when the reply states ONLY prices that exist in the catalog (or states no prices).
 * False when at least one stated price is not in the catalog.
 * When the catalog has no prices, returns true (fail-open — can't validate nothing).
 */
export function replyPricesAreGrounded(
  replyText: string,
  catalogPriceSet: CatalogPriceSet,
): boolean {
  return filterHallucinatedPrices(replyText, catalogPriceSet).length === 0;
}
