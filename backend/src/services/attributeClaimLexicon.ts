/**
 * P3-1 — the closed vocabulary behind the declared-attribute grounding lane.
 *
 * WHY A CLOSED CLASS. The gate's price and name dimensions validate against reference sets that
 * are structurally complete: every active price, every active name. There is no equivalent for
 * attributes. Measured on the only real dev catalog (tenant 02beb134, 257 active rows):
 * `flavor` is non-null on 1 row, `brand` on 1, and `size`/`color`/`variant`/`weight` on ZERO.
 * The structured columns are empty, so an open-vocabulary "is this attribute value present?"
 * predicate has no evidence base and would flag essentially every attribute claim.
 *
 * The closed substance class IS the false-positive firewall. A claim only becomes eligible to be
 * judged when it is an EXCLUSION claim ("pa sheqer", "nuk ka laktozë", "sugar-free") over a
 * substance in the table below — the one family where a merchant description reliably speaks, and
 * the one family where being wrong actively harms a customer (allergen, intolerance, diabetic).
 *
 * FOLDED STORAGE. Every entry is stored diacritic-free and lowercase because every consumer folds
 * its input through `foldDialect` first. A diacritic inside one of these lists is a DEAD ALTERNATE
 * that can never match — the same trap RC-25 recorded when one retrieval arm searched
 * '%çokollatë%' while the other searched '%cokollate%'. `attributeClaimLexicon.test.ts` asserts no
 * exported entry contains a non-ASCII character, so the trap cannot be reintroduced.
 *
 * EXPLICIT INFLECTIONS, NO PREFIX STEMMING. Albanian marks definiteness/case as suffixes
 * (sheqer / sheqeri / sheqerit), so some morphology is unavoidable. It is spelled out rather than
 * approximated with a prefix rule, because prefix matching fails in BOTH directions: it would miss
 * 'laktoza' against a 'laktoze' stem (a lost rescue → a false flag) and it would match 'milk'
 * inside 'milkshake' (a spurious hit). Whole-token matching over an explicit table has neither
 * failure mode.
 *
 * PURE LEAF. Imports only `./dialectNormalization` (itself a leaf over `./productTitleNormalization`).
 * No I/O, no clock, no randomness — the whole predicate must be replayable offline in CI.
 */
import { foldDialect } from './dialectNormalization';

export type ClaimPolarity = 'exclusion' | 'other';

/**
 * Canonical substance → every surface form that means it, folded.
 *
 * Scope note: this is the ALLERGEN / DIETARY-EXCLUSION family only. It is deliberately NOT a
 * general attribute vocabulary — flavour, size, colour and weight claims are ineligible by
 * construction (see `parseAttributeClaim`), because the catalog columns that would ground them
 * are empty and the free text mentions them too incidentally to judge.
 */
export const SUBSTANCE_LEXICON: ReadonlyMap<string, readonly string[]> = new Map([
  ['sheqer', ['sheqer', 'sheqeri', 'sheqerit', 'sheqerin', 'sheqerna', 'sheqernat', 'sugar', 'sugars']],
  ['laktoze', ['laktoze', 'laktoza', 'laktozes', 'laktozen', 'lactose']],
  ['gluten', ['gluten', 'glutenit', 'glutenin', 'glutten']],
  ['kafeine', ['kafeine', 'kafeina', 'kafeines', 'kafein', 'caffeine']],
  ['aspartam', ['aspartam', 'aspartami', 'aspartamit', 'aspartame']],
  ['alkool', ['alkool', 'alkooli', 'alkoolit', 'alcohol']],
  ['soje', ['soje', 'soja', 'sojes', 'soy', 'soya']],
  ['kikirik', ['kikirik', 'kikiriket', 'kikirikeve', 'peanut', 'peanuts']],
  ['veze', ['veze', 'veza', 'vezet', 'vezeve', 'egg', 'eggs']],
  ['gmo', ['gmo', 'gmos']],
]);

/**
 * Substance → terms that may SUPPORT an exclusion claim about it, but may NEVER contradict one.
 *
 * The asymmetry is the whole point and it is an entailment, not a heuristic. "pa produkte
 * qumështi" (dairy-free) entails lactose-free, so it must RESCUE a `pa laktozë` claim. The
 * converse does not hold — a product containing milk protein may still be lactose-free (isolate,
 * hydrolysate), so a mention of milk must never be evidence that a lactose-free claim is false.
 *
 * Verified against the real row `BEEF AMINO 300 Tableta`, whose description contains BOTH
 * "pa Produkte Qumështi" and "intoleranca ndaj laktozës". Without this bridge the AI's correct
 * "pa laktozë" answer about that product is a false positive; with it, the claim is supported.
 */
export const SUPPORT_ONLY_BRIDGE: ReadonlyMap<string, readonly string[]> = new Map([
  ['laktoze', ['qumesht', 'qumeshti', 'qumeshtit', 'qumeshtin', 'dairy', 'milk']],
]);

/**
 * Tokens that mark an ABSENCE. Multi-word entries are matched as folded phrases; the Gheg 's'ka'
 * needs no entry because `foldDialect` rewrites the whole token to 'nuk ka' before we ever see it.
 */
export const EXCLUSION_MARKERS: readonly string[] = [
  'pa',
  'nuk ka',
  'nuk permban',
  'pa shtuar',
  'zero',
  '0g',
  '0',
  'free',
  'without',
  'nuk perfshin',
];

/**
 * Tokens that mark a PRESENCE, or a reduced-but-nonzero quantity. `reduktuar` / `i ulet ne` are
 * the load-bearing ones: "sheqer i reduktuar" refutes "pa sheqer" — reduced is not free. That
 * distinction is exactly what the roadmap's own acceptance product turns on.
 */
export const CONTRADICTION_MARKERS: readonly string[] = [
  'permban',
  'permbajne',
  'me sheqer',
  'i ulet ne',
  'e ulet ne',
  'ulet ne',
  'pak',
  'reduktuar',
  'minimale',
  'e larte',
  'i larte',
  'contains',
  'high in',
  'low in',
];

/**
 * Framings under which a substance is mentioned WITHOUT the text asserting the product contains it
 * — audience notes, comparisons, and instructions. A clause carrying one of these may never
 * contradict.
 *
 * Kept short deliberately: measured on the dev catalog only 2 rows use `intoleranc`, so this is a
 * small closed list rather than the open-ended escape hatch it might look like. The two entries
 * that earn their place from real rows are `intoleranc` (`BEEF AMINO`: "atletët që vuajnë nga
 * intoleranca ndaj laktozës") and `krahasuar` (`Mega mass`: "krahasuar me formulën e vjetër").
 */
export const NON_ASSERTIVE_FRAMES: readonly string[] = [
  'intoleranc',
  'alergji',
  'krahasuar',
  'qe gjendet ne',
  'alternative',
  'perzieni',
  'nese jeni',
  'ndjeshem ndaj',
];

export interface AttributeClaim {
  /** The value exactly as the model declared it. */
  raw: string;
  /** `foldDialect(raw)` — the form every comparison actually uses. */
  folded: string;
  polarity: ClaimPolarity;
  /** Canonical substance keys the claim is about, in lexicon order. */
  substances: string[];
  /** True only for an exclusion claim over at least one known substance. */
  eligible: boolean;
}

/** Whole-token containment: `needle` must occupy complete token positions inside `haystack`. */
export function containsPhrase(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const hay = haystack.split(' ').filter(Boolean);
  const parts = needle.split(' ').filter(Boolean);
  if (parts.length === 0 || parts.length > hay.length) return false;
  for (let i = 0; i + parts.length <= hay.length; i += 1) {
    let hit = true;
    for (let j = 0; j < parts.length; j += 1) {
      if (hay[i + j] !== parts[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** Substring containment, for the frame markers that are deliberately stem-shaped (`intoleranc`). */
function containsLoose(haystack: string, needle: string): boolean {
  return Boolean(haystack) && Boolean(needle) && haystack.includes(needle);
}

/** Canonical substance keys whose surface forms occur as whole tokens in `foldedText`. */
export function substancesIn(foldedText: string): string[] {
  const found: string[] = [];
  for (const [canonical, forms] of SUBSTANCE_LEXICON) {
    if (forms.some((form) => containsPhrase(foldedText, form))) found.push(canonical);
  }
  return found;
}

/** Bridge terms for `substance` occurring as whole tokens — SUPPORT direction only. */
export function bridgeTermsIn(foldedText: string, substance: string): boolean {
  const bridge = SUPPORT_ONLY_BRIDGE.get(substance);
  if (!bridge) return false;
  return bridge.some((term) => containsPhrase(foldedText, term));
}

export function hasExclusionMarker(foldedText: string): boolean {
  return EXCLUSION_MARKERS.some((m) => containsPhrase(foldedText, m));
}

export function hasContradictionMarker(foldedText: string): boolean {
  return CONTRADICTION_MARKERS.some((m) => containsPhrase(foldedText, m));
}

export function hasNonAssertiveFrame(foldedText: string): boolean {
  return NON_ASSERTIVE_FRAMES.some((m) => containsLoose(foldedText, m));
}

/**
 * Classify a declared attribute value.
 *
 * Eligibility is intentionally narrow: an exclusion marker AND a known substance, both in a value
 * short enough that their co-occurrence means what it looks like. "shije vanilje", "3kg",
 * "me proteina" and "i importuar nga gjermania" are all `other` → they can never reach the flag
 * branch, at any mode. Order is not required — Albanian puts the marker first ("pa sheqer"),
 * English puts it last ("sugar free"), and the value is a phrase, not a sentence.
 */
export function parseAttributeClaim(value: string): AttributeClaim {
  const raw = (value ?? '').trim();
  const folded = foldDialect(raw);
  const substances = substancesIn(folded);
  const exclusion = hasExclusionMarker(folded) && substances.length > 0;
  return {
    raw,
    folded,
    polarity: exclusion ? 'exclusion' : 'other',
    substances,
    eligible: exclusion && folded.length > 0,
  };
}

/**
 * The folded claim phrase, but only if the reply actually says it.
 *
 * A declared fact that never reaches the customer must never drive a customer-visible strip — the
 * same narrowing the name path applies at `groundingGate.ts` (`proseNorm.includes(n)`). Returns
 * null when absent, and null can never strip.
 */
export function locateClaimInProse(claim: AttributeClaim, proseFolded: string): string | null {
  if (!claim.eligible || !claim.folded) return null;
  return containsPhrase(proseFolded, claim.folded) ? claim.folded : null;
}

/**
 * Split raw text into folded clauses.
 *
 * MUST run on RAW text: `foldDialect` strips punctuation to spaces, so folding first would destroy
 * every clause boundary. Splitting on strong terminators ONLY — never on commas or on
 * `dhe`/`ose` — because in both directions a coordinated list is governed by one operator:
 *   support:       "Pa sheqer të shtuar, produkte qumështi, laktozë ose produkte shtazore"
 *   contradiction: "i ulët në karbohidrate, yndyrë dhe laktozë"
 * Both are real rows. Splitting the list would sever the operator from its objects and turn each
 * into an unmarked bare mention — losing the rescue in the first case and the flag in the second.
 */
export function segmentClauses(rawText: string): string[] {
  return (rawText ?? '')
    .split(/[.;:!?\n\r]+/u)
    .map((part) => foldDialect(part))
    .filter((part) => part.length > 0);
}
