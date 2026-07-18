/**
 * P3-4 — the fabrication check: product-claim token membership (RC-03).
 *
 * THE DEFECT IT GUARDS. Phase 10 replayed one fixed prompt eight times at the live
 * `AI_REPLY_TEMPERATURE=0.3` and got eight different paragraphs. Several of them asserted
 * "BSN = Bio-Engineered Supplements and Nutrition" plus strength claims that appear nowhere in the
 * injected catalog. Both existing defences waved them through: the product-name guard only checks
 * NAMES, and the quality eval scored the fabricating replies 0.95. The remediation plan's answer is
 * a deterministic membership check — "zero product-claim tokens absent from the injected catalog" —
 * explicitly NOT an LLM judge, because a judge is the thing that already failed here.
 *
 * WHY THIS IS NOT WHOLE-TEXT TOKEN MEMBERSHIP. Checking every word of an Albanian reply against the
 * catalog would flag most of the language, forcing an allowlist so large the check becomes vacuous —
 * the failure mode where a gate is green because it can no longer fail. The plan's own wording is
 * "product-CLAIM tokens", and that word does the work: only spans in CLAIM POSITION are extracted.
 * Three conservative extractors, no general tokenizer:
 *
 *   (a) prices     — reuses `extractStatedPrices`, the same parser the live guard uses
 *   (b) name spans — maximal runs of Capitalized / ALL-CAPS / digit-bearing tokens
 *   (c) quantities — a number bound to a unit ("50g", "100 caps"), the invented-strength-claim class
 *
 * A CORRECTED CLAIM, KEPT VISIBLE BECAUSE IT WAS NEARLY A SILENT HOLE. An earlier version of this
 * module exempted EVERY position-initial token (one that opens a sentence, line, bullet, or follows
 * a colon) on the reasoning that its capital is orthographic, and this comment asserted the
 * exemption "costs nothing in recall". That was false. Measured against the negative corpus, a
 * synthetic fabricated token was MISSED 5/7 at sentence start and 7/7 at reply start and in a
 * bullet — and the RC-03 case this check exists for ("BSN është shkurtesa e…") is a brand claim in
 * exactly that position. The exemption is now gated on the ALLOWLIST: a position-initial token is
 * dropped only when it is a recognised language word. Cost of the fix, measured: exactly ONE new
 * allowlist entry ("nuk").
 *
 * GROUNDING USES FORWARD CONTAINMENT ONLY. See the note on `grounded()` — reusing the live guard's
 * `nameMatchesCatalogIndex` was wrong here, because its reverse arm made any span CONTAINING a real
 * product name count as grounded, so a fabricated token appended to a real name disappeared.
 *
 * PRECISION BIAS IS DELIBERATE. This is a release gate; a false positive blocks a deploy. So the
 * check is conservative everywhere it has a choice: a multi-token span that fails as a whole is
 * decomposed and only the individually-ungrounded tokens are reported, and a span whose every token
 * is independently grounded is never a violation. Real recall gaps remain — they are enumerated as
 * passing tests in `tokenMembership.test.ts` under "KNOWN RECALL GAPS".
 *
 * ⚠️ THE BIGGEST GAP IS NOW HALF-CLOSED — ELSEWHERE — AND THE HALVES ARE WORTH DISTINGUISHING.
 * A false SENTENCE built from true WORDS — "Mega mass 3kg Vanil është pa sheqer" ("…is sugar-free")
 * — is invisible to token membership by construction: every token is grounded, only the
 * proposition is invented. THIS MODULE STILL CANNOT SEE IT and never will; it is a CI instrument
 * that never runs on the send path, so no amount of cleverness here could stop such a reply
 * reaching a customer.
 *
 * P3-1 closed it where it had to be closed — in the gate. `evaluateConsolidatedGrounding` now
 * consumes `f.type === 'attribute'` and, behind `GROUNDING_GATE_ATTRIBUTE_FACTS`, strips or
 * escalates a declared exclusion claim the resolved product's own catalog text REFUTES. That is
 * the contradiction half. The SILENCE half stays open deliberately: 218 of 257 real active rows
 * say nothing about sugar and most supplements genuinely are sugar-free, so flagging absence would
 * strip true sentences at scale into a pause with no automatic exit. The lane also judges only
 * DECLARED facts (no prose backstop exists for a semantic claim) and only a closed substance
 * lexicon. Do not read "P3-1 landed" as "attribute fabrication is solved".
 *
 * THE ALLOWLIST GROWS ONLY FROM NEGATIVE-CORPUS FAILURES. Every entry below is here because a real
 * recorded reply tripped on it, and each is a language/canned-copy word, never a product word.
 * `fabricationGolden.test.ts` asserts the allowlist is disjoint from the tokens under test, so a
 * future engineer cannot turn a red gate green by allowlisting the fabrication itself.
 *
 * Pure: imports only `priceConsistencyGuard` and `productTitleNormalization` — both leaf modules,
 * neither of which reaches `openaiClient`. Runs in `npm test` with no DB, Redis, network or key.
 */
import {
  extractStatedPrices,
  filterHallucinatedPrices,
  type CatalogPriceSet,
} from '../../services/priceConsistencyGuard';
import { normalizeText } from '../../services/productTitleNormalization';

export type ClaimKind = 'price' | 'name' | 'quantity';

export interface ClaimViolation {
  /** The span exactly as it appeared in the reply. */
  span: string;
  /** Its normalized form — what membership was actually tested against. */
  normalized: string;
  kind: ClaimKind;
  /** Why it counted as ungrounded, for the failure message. */
  reason: string;
}

export interface TokenMembershipInput {
  /** The customer-facing reply under test. */
  replyText: string;
  /**
   * The catalog context block actually placed in the prompt. This — not the full DB catalog — is
   * the authoritative universe: the plan says "absent from the INJECTED catalog", and a claim the
   * model could not have read is a fabrication even if some unrelated row happens to contain it.
   */
  injectedCatalogText: string;
  /** Full active-catalog names, for the same containment matcher the live name guard uses. */
  catalogNameIndex: readonly string[];
  /** Full active-catalog price set (P0-2's `getFullCatalogPriceSet` shape). */
  priceSet: CatalogPriceSet;
  /** The customer's own words. Echoing them back is never a fabrication. */
  customerText?: string;
  /** Case-specific additions (e.g. a tenant's canned copy). */
  extraAllowlist?: readonly string[];
}

export interface TokenMembershipResult {
  ok: boolean;
  violations: ClaimViolation[];
  /**
   * How many candidate spans were extracted and tested. ANTI-VACUITY: a broken extractor reports
   * `ok: true` forever, so every corpus case asserts this is > 0.
   */
  candidatesChecked: number;
}

/**
 * The repo's single sanctioned normalizer, reused rather than reimplemented: NFD-fold + lowercase +
 * whitespace collapse. Sharing it with the live name guard is what stops the harness and the gate
 * disagreeing about whether "Qokolad" and "Çokollatë" are the same token.
 */
const norm = (text: string): string => normalizeText(text ?? '');

/**
 * Language and canned-copy words that legitimately appear capitalized mid-line in Albanian/English
 * replies. Every one of these was surfaced by a real reply in the negative corpus — none was added
 * speculatively, and none is a product, brand, flavour or attribute word.
 */
const LANGUAGE_ALLOWLIST: readonly string[] = [
  // Albanian sentence/list connectives and canned-reply vocabulary
  'po', 'jo', 'nuk', 'ju', 'ne', 'na', 'edhe', 'dhe', 'ose', 'per', 'me', 'nga', 'te', 'tjera',
  'gjithashtu', 'faleminderit', 'pershendetje', 'mirembrema', 'miredita', 'sigurisht',
  'cmimi', 'cmimet', 'shijet', 'shija', 'produkte', 'produktet', 'produkti', 'stok', 'ne stok',
  'porosia', 'porosine', 'adresa', 'emri', 'telefoni', 'specialist', 'informacion',
  'disa', 'nese', 'kemi', 'keni', 'eshte', 'jane', 'zgjedhje', 'opsione', 'opsionet',
  // Sentence-opening verbs. Added ONLY after the position-initial exemption was tightened and the
  // negative corpus surfaced each one as a false positive — never speculatively (that is the rule
  // stated in the header, and it is what keeps the allowlist from growing until the gate is inert).
  'kushton', 'jep', 'merrni', 'kjo',
  // English equivalents, for the English corpus arm
  'yes', 'no', 'we', 'you', 'and', 'or', 'for', 'with', 'from', 'the', 'also', 'thanks',
  'price', 'prices', 'flavours', 'flavors', 'flavour', 'flavor', 'products', 'product',
  'stock', 'in stock', 'order', 'address', 'name', 'phone', 'specialist', 'information',
  'some', 'if', 'have', 'is', 'are', 'options', 'choice',
];

/**
 * A token is POSITION-INITIAL when its capitalization is explained by orthography rather than by
 * being a proper noun: it opens a line, a sentence, a bullet, or follows a colon. Returns the set of
 * character offsets at which such a token starts.
 */
function positionInitialOffsets(text: string): Set<number> {
  const offsets = new Set<number>();
  // A token start is position-initial when everything between it and the previous "opener"
  // (start-of-text, newline, sentence terminator, colon, or bullet marker) is only whitespace
  // or the bullet punctuation itself.
  const OPENER = /(^|[\n\r]|[.!?…]|[:•]|(?:^|[\n\r])\s*[-–—*]\s)/g;
  let m: RegExpExecArray | null;
  while ((m = OPENER.exec(text)) !== null) {
    let i = m.index + m[0].length;
    while (i < text.length && /[\s\-–—*•:]/.test(text[i])) i += 1;
    offsets.add(i);
    if (OPENER.lastIndex === m.index) OPENER.lastIndex += 1; // zero-width guard
  }
  offsets.add(0);
  return offsets;
}

/**
 * Is this character an uppercase letter?
 *
 * Deliberately NOT a character-class range. `[A-ZÀ-ſ]` looks right and is wrong for Albanian: the
 * block U+00C0–U+017F contains lowercase letters too, so `ë` (U+00EB) and `ç` (U+00E7) match it and
 * every ordinary Albanian word gets read as a proper noun. The case round-trip is script-agnostic
 * and has no such gap.
 */
function isUpper(ch: string): boolean {
  return ch === ch.toUpperCase() && ch !== ch.toLowerCase();
}

/**
 * Does this token look like a product-claim token rather than ordinary prose?
 *
 * Every rule below requires at least one LETTER. A bare numeral is never a product claim on its own
 * — it is a price fragment, a serving count, or the "90" of "€31.90" — and admitting them produced
 * exactly that noise: three violations reported for one fabricated price.
 */
function isClaimShaped(token: string): boolean {
  const letters = [...token].filter((c) => /\p{L}/u.test(c));
  if (letters.length === 0) return false;
  if (/\d/.test(token)) return true; // 3kg, 100caps, C4
  if (token.length >= 2 && letters.every(isUpper)) return true; // BSN, ON
  return isUpper(token[0]);
}

interface Span {
  text: string;
  /** True when the span's FIRST token was position-initial and therefore dropped. */
  trimmedInitial: boolean;
}

/**
 * Extract maximal runs of claim-shaped tokens.
 *
 * A run is broken by two things, and BOTH are load-bearing:
 *   - a non-claim-shaped token (a lowercase word), and
 *   - any punctuation between two tokens.
 * The second is easy to omit and produced a real defect: without it a run walked straight through
 * a sentence boundary, so "…Zzqfakebrandix. Merrni Zzqfakebrandix." became one span and the
 * sentence-initial "Merrni" was swept in as a fabricated brand token. Only spaces and tabs
 * separate the words of a product name; everything else ends it.
 *
 * POSITION-INITIAL TOKENS ARE NOT EXEMPT — they are only exempt when the ALLOWLIST recognises
 * them. An earlier version dropped every position-initial token outright, on the reasoning that
 * its capital is orthographic rather than a brand. That reasoning is right about `Po` and `Kemi`
 * and catastrophically wrong about a fabricated brand that happens to open a sentence, a line or a
 * bullet — measured against the negative corpus, a synthetic token was MISSED 5/7 at sentence
 * start and 7/7 at reply start and in a bullet. The RC-03 case this whole check exists for
 * ("BSN është shkurtesa e…") is a brand claim in exactly that position, so the blind spot sat
 * directly under the defect. Allowlist-gating keeps the false-positive control (every ordinary
 * sentence opener in the corpus is a language word) while closing it.
 */
function extractNameSpans(replyText: string, isAllowlisted: (token: string) => boolean): Span[] {
  const initial = positionInitialOffsets(replyText);
  const spans: Span[] = [];
  const TOKEN = /[\wÀ-ɏ][\wÀ-ɏ-]*/g;

  let current: string[] = [];
  let trimmedInitial = false;
  let prevEnd = 0;
  let m: RegExpExecArray | null;

  const flush = (): void => {
    if (current.length > 0) spans.push({ text: current.join(' '), trimmedInitial });
    current = [];
    trimmedInitial = false;
  };

  while ((m = TOKEN.exec(replyText)) !== null) {
    const token = m[0];
    // Punctuation (or a newline) since the previous token ends the run.
    if (!/^[ \t]*$/.test(replyText.slice(prevEnd, m.index))) flush();
    prevEnd = m.index + token.length;

    if (!isClaimShaped(token)) {
      flush();
      continue;
    }
    if (initial.has(m.index) && current.length === 0 && isAllowlisted(token)) {
      // A KNOWN language/canned word whose capital is orthographic. Drop this token only; the run
      // continues after it. An unrecognised token in the same position is NOT dropped — see the
      // note above; that exemption is where fabricated brands used to hide.
      trimmedInitial = true;
      continue;
    }
    current.push(token);
  }
  flush();
  return spans.filter((s) => s.text.length > 0);
}

const QUANTITY_RE =
  /\b\d+(?:[.,]\d+)?\s*(?:g|gr|gram|gramë|kg|mg|ml|l|tab|tableta|caps?|kapsula|serving|servings|servime|porcion|porcione)\b/giu;

/** "3 kg" and "3kg" are the same claim; collapse the gap before membership. */
function normQuantity(raw: string): string {
  return norm(raw).replace(/\s+/g, '');
}

export function checkClaimTokenMembership(input: TokenMembershipInput): TokenMembershipResult {
  const violations: ClaimViolation[] = [];
  let candidatesChecked = 0;

  const catalogNorm = norm(input.injectedCatalogText);
  const catalogNoSpace = catalogNorm.replace(/\s+/g, '');
  const customerNorm = norm(input.customerText ?? '');
  const allow = new Set<string>([
    ...LANGUAGE_ALLOWLIST.map(norm),
    ...(input.extraAllowlist ?? []).map(norm),
  ]);

  /**
   * Is this normalized span accounted for by something the model was actually given?
   *
   * ⚠️ FORWARD CONTAINMENT ONLY — deliberately NOT `nameMatchesCatalogIndex`, even though that is
   * the matcher the live name guard uses. That function also matches in REVERSE
   * (`suspect.includes(candidate)`), which is right for its own job — deciding whether a suspected
   * name resembles a catalog row — and exactly wrong here. Under reverse containment any span that
   * CONTAINS a real product name is "grounded", so appending a fabricated token to a real name
   * hides it: "Pro Mass 1kg Qokolad Zzqfakebrandix" was reported clean because it contains
   * "Pro Mass 1kg Qokolad". Grounding asks the opposite question — is this span accounted for BY
   * the catalog — so containment may only run catalog-contains-span.
   */
  const nameIndexNorm = input.catalogNameIndex.map(norm).filter(Boolean);
  const grounded = (n: string): boolean => {
    if (!n) return true;
    if (allow.has(n)) return true;
    if (catalogNorm.includes(n)) return true;
    if (customerNorm.includes(n)) return true;
    return nameIndexNorm.some((candidate) => candidate === n || (n.length >= 4 && candidate.includes(n)));
  };

  // (a) PRICES — delegate to the guard's own parser + filter so the harness and the live gate
  // cannot disagree about what counts as a stated price.
  for (const stated of extractStatedPrices(input.replyText)) {
    candidatesChecked += 1;
    void stated;
  }
  for (const bad of filterHallucinatedPrices(input.replyText, input.priceSet)) {
    violations.push({
      span: bad.raw,
      normalized: String(bad.value),
      kind: 'price',
      reason: 'price absent from the active catalog price set',
    });
  }

  // (b) QUANTITY CLAIMS — run BEFORE names so a quantity token ("5000mg") is reported under the
  // kind that actually describes it. Otherwise the name extractor claims it first and the failure
  // message says "product name" about a strength claim, which sends the reader to the wrong guard.
  const quantitySpans = new Set<string>();
  for (const match of input.replyText.matchAll(QUANTITY_RE)) {
    candidatesChecked += 1;
    const raw = match[0];
    const n = normQuantity(raw);
    quantitySpans.add(n);
    if (catalogNoSpace.includes(n)) continue;
    if (customerNorm.replace(/\s+/g, '').includes(n)) continue;
    violations.push({
      span: raw,
      normalized: n,
      kind: 'quantity',
      reason: 'quantity/strength claim absent from the injected catalog',
    });
  }

  // (c) NAME SPANS
  for (const span of extractNameSpans(input.replyText, (t) => allow.has(norm(t)))) {
    candidatesChecked += 1;
    const spanNorm = norm(span.text);
    if (grounded(spanNorm)) continue;

    // Decompose: report only the tokens that are individually ungrounded. A span whose every
    // token is grounded is not a violation — precision bias, deliberately.
    const tokens = span.text.split(/\s+/).filter(Boolean);
    const ungrounded = tokens.filter(
      (t) => !grounded(norm(t)) && !quantitySpans.has(normQuantity(t)),
    );
    if (ungrounded.length === 0) continue;

    for (const token of ungrounded) {
      violations.push({
        span: token,
        normalized: norm(token),
        kind: 'name',
        reason: `product-claim token absent from the injected catalog (in span "${span.text}")`,
      });
    }
  }

  // Dedupe by (kind, normalized) preserving first-seen order — the same fabricated token repeated
  // three times is one defect, and a stable order keeps failure messages diffable.
  const seen = new Set<string>();
  const deduped = violations.filter((v) => {
    const k = `${v.kind}:${v.normalized}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { ok: deduped.length === 0, violations: deduped, candidatesChecked };
}

/** The allowlist, exported so a test can assert it never overlaps the tokens under test. */
export const TOKEN_MEMBERSHIP_ALLOWLIST: readonly string[] = LANGUAGE_ALLOWLIST;

/** A failure message that names the fabricated spans. */
export function describeViolations(label: string, result: TokenMembershipResult): string {
  if (result.ok) return `${label}: clean (${result.candidatesChecked} candidates checked)`;
  const lines = result.violations.map((v) => `  [${v.kind}] "${v.span}" — ${v.reason}`).join('\n');
  return `${label}: ${result.violations.length} ungrounded claim(s) of ${result.candidatesChecked} candidates:\n${lines}`;
}
