/**
 * P3-5 (RC-26, rules R4 + R16): the deterministic half of price intent.
 *
 * WHY IT IS ITS OWN MODULE. `aiService.ts` imports `openaiClient`, which throws at module load
 * when `OPENAI_API_KEY` is unset — so anything exported from there is untestable in a suite that
 * deliberately has no key, no mocking framework, and no network. The house answer is a pure
 * sibling module (`priceConsistencyGuard.ts`, `uncertainAnswerFallbackGuard.ts`,
 * `productInformationGapHelpers.ts` all exist for this reason). This is one more.
 *
 * WHAT IT FIXES. These keywords already existed inside `customerAskedAboutPrice` — as a fallback
 * reached ONLY when the LLM classifier threw or returned an unparseable shape. A confident `false`
 * from the classifier therefore overrode a price word sitting in plain sight.
 *
 * That is EV-010 (alert dcf5c812, 2026-06-27): "Me qfar shije i keni edhe sa kushtojn" — a
 * compound Gheg flavour+price question where the classifier anchored on the flavour half.
 * `kushtojn` is in this list and always has been; nothing ever asked it.
 *
 * The consequence is not cosmetic. `includePrice` is `customerAskedPrice || customerAskedDiscount`,
 * so a missed price intent injects a catalog with NO price lines at all — the model cannot state a
 * price, and the fail-closed product-information-gap assessor then correctly reports
 * `missing_info: ["çmimi"]` and escalates to a human. The audit's R16 row floats "make the assessor
 * treat çmimi as answerable-by-design" as one option; on this codebase that would suppress a TRUE
 * signal and ship a reply that never answers the question. The defect is upstream, and it is this.
 */

/**
 * Matched against the customer's own message, diacritic-folded and lowercased.
 *
 * Every entry must be an explicit price word. The union can only ADD prices to the prompt, so a
 * false positive here volunteers a price nobody asked for — a direct R4/R5 violation ("mention
 * price only when explicitly asked"). Bare `kushton`/`cmim` stems are deliberate: they cover the
 * inflected Gheg and Tosk forms (`kushtojn`, `kushtojne`, `kushtoi`, `qmimi`) without needing a
 * full morphology table, and neither stem occurs in ordinary non-price Albanian.
 */
export const PRICE_INTENT_KEYWORDS: readonly string[] = [
  'price',
  'cost',
  'how much',
  'cheapest',
  'most expensive',
  'lowest price',
  'highest price',
  'compare price',
  'price comparison',
  'sa kushton',
  'kushton',
  'kushtojne',
  'kushtojn',
  'kushtoi',
  'kushtuan',
  'sa ben',
  'sa eshte cmimi',
  'sa eshte qmimi',
  'cmim',
  'çmim',
  'qmim',
  'me i lire',
  'me e lire',
  'me i shtrenjte',
  'me e shtrenjte',
  'krahasim cmimesh',
  'krahasim qmimesh',
  'krahaso cmimet',
  '$',
  '€',
];

/**
 * Does the customer's own text contain an explicit price word?
 *
 * Pure and total — never throws, so it is safe to evaluate before the classifier and safe to use
 * as the classifier's error fallback (both call sites in `customerAskedAboutPrice`).
 */
export function lexicallyAsksAboutPrice(message: string): boolean {
  const normalized = (message ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (!normalized.trim()) return false;
  return PRICE_INTENT_KEYWORDS.some((needle) => normalized.includes(needle));
}
