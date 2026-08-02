import { knobNumber } from '../config/knobs';
import { GHEG_RECOMMENDATION_EXTRA_PATTERNS, withGhegPatterns } from './ghegLexicons';
import { PROMPT_ALLOWLIST_BUDGET } from './promptAssemblyService';

/** Max characters for brief catalog description lines (~1–2 lines in chat). Knob-declared (frozen). */
export const CATALOG_DESCRIPTION_BRIEF_MAX_CHARS = knobNumber('CATALOG_DESCRIPTION_BRIEF_MAX_CHARS');

/** Max characters for usage text shown in catalog when the turn is not a usage question. Knob-declared (frozen). */
export const CATALOG_USAGE_BRIEF_MAX_CHARS = knobNumber('CATALOG_USAGE_BRIEF_MAX_CHARS');

export type CatalogTextMode = 'brief' | 'full';

/** Per-field render mode once the evidence scan has run: 'extract' = brief + relevant excerpts. */
export type CatalogFieldTextMode = CatalogTextMode | 'extract';

export function normalizeCatalogWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Compresses long product text for catalog prompt injection (not customer-facing).
 * Prefers ending at a sentence boundary within the cap.
 */
export function summarizeTextForCatalogPrompt(
  text: string,
  maxChars: number = CATALOG_DESCRIPTION_BRIEF_MAX_CHARS,
): string {
  const normalized = normalizeCatalogWhitespace(text);
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;

  const slice = normalized.slice(0, maxChars);
  const sentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('.\n'),
  );
  if (sentenceEnd >= Math.floor(maxChars * 0.35)) {
    return slice.slice(0, sentenceEnd + 1).trim();
  }

  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > Math.floor(maxChars * 0.5)) {
    return `${slice.slice(0, lastSpace).trim()}…`;
  }
  return `${slice.trim()}…`;
}

export function formatCatalogDescriptionLine(
  description: string | null | undefined,
  mode: CatalogTextMode,
): string | null {
  const trimmed = description?.trim();
  if (!trimmed) return null;
  if (mode === 'full') {
    return `  Full description (internal reference only — never paste verbatim to the customer): ${trimmed}`;
  }
  const brief = summarizeTextForCatalogPrompt(trimmed, CATALOG_DESCRIPTION_BRIEF_MAX_CHARS);
  return `  Brief summary (max 1–2 lines if you mention this product): ${brief}`;
}

export function formatCatalogUsageLine(
  usage: string | null | undefined,
  mode: CatalogTextMode | 'omit',
): string[] {
  const trimmed = usage?.trim();
  if (!trimmed || mode === 'omit') return [];
  if (mode === 'full') {
    return [
      '  Usage description (internal reference only — extract only the portion that answers a usage question):',
      `  ${trimmed}`,
    ];
  }
  const brief = summarizeTextForCatalogPrompt(trimmed, CATALOG_USAGE_BRIEF_MAX_CHARS);
  return [`  Usage summary (omit unless customer asks about usage/dosage): ${brief}`];
}

/** Verbatim sentences from the description that overlap the customer's question. */
export function formatCatalogDescriptionExcerpts(sentences: string[]): string | null {
  if (sentences.length === 0) return null;
  return `  Relevant description excerpts (verbatim from the catalog — answer ONLY from these, do not paste all of them): ${sentences.join(' ')}`;
}

/** Verbatim sentences from the usage description that overlap the customer's question. */
export function formatCatalogUsageExcerpts(sentences: string[]): string[] {
  if (sentences.length === 0) return [];
  return [
    `  Relevant usage excerpts (verbatim from the catalog — answer ONLY from these, do not paste all of them): ${sentences.join(' ')}`,
  ];
}

// ---------------------------------------------------------------------------
// P0-2 (description investigation): evidence-aware per-product text modes.
//
// The brief slice is a query-agnostic 200-char prefix, and the 'full' escape
// hatch was gated on a fixed-vocabulary regex — so a factual question with no
// cue word ("a eshte pa sheqer?", "is it gluten free?") got a prompt from
// which the answer was physically absent (measured: 187/219 dev descriptions
// exceed 200 chars; the recorded sugar-question turn had its answer at char
// ~1150). computeCatalogTextEvidence closes the gap deterministically: a
// folded question token found in a product's own text BEYOND the brief
// boundary escalates that product's field to 'full' (top-K products, per-turn
// char budget) or, past the budget, to 'extract' (the overlapping sentences,
// verbatim) — never silently back to the blind prefix. No LLM call.
// ---------------------------------------------------------------------------

/** Per-product render decision produced by the evidence scan. */
export interface CatalogTextDecision {
  descriptionMode: CatalogFieldTextMode;
  usageMode: CatalogFieldTextMode;
  descriptionExcerpts?: string[];
  usageExcerpts?: string[];
}

export interface CatalogTextEvidenceResult {
  /** Product id → render decision. Only products with evidence beyond the brief slice appear. */
  decisions: Map<string, CatalogTextDecision>;
  /** Products escalated to full text. */
  fullCount: number;
  /** Products degraded to sentence excerpts (budget/cap overflow). */
  extractCount: number;
  /** At least one product had question-relevant text beyond the brief slice — the F2 defect counter. */
  briefOnlyMiss: boolean;
}

export interface CatalogTextEvidenceOptions {
  maxFullProducts?: number;
  fullTextBudgetChars?: number;
}

/**
 * Question words, copulas and catalog-generic terms that must not trigger a full-text
 * escalation on their own (folded, diacritic-free — the scan runs on folded text).
 * Verbs like "contains" are stopped because the NOUN carries the signal: matching
 * "permban" would escalate every description that says "Përmban ..." about anything.
 */
const EVIDENCE_SCAN_STOPWORDS = new Set<string>([
  // Albanian question/function words (folded)
  'cfare', 'qfare', 'cfar', 'qfar', 'cila', 'cili', 'cilin', 'cilen', 'cilat', 'kush',
  'eshte', 'esht', 'osht', 'asht', 'jane', 'jemi', 'jeni', 'kam', 'kemi', 'keni', 'kane', 'kini',
  'mund', 'muna', 'munem', 'mundem', 'munen', 'duhet', 'dua', 'doja', 'doni', 'deshironi',
  'per', 'nga', 'dhe', 'ose', 'por', 'prej', 'kur', 'pse', 'tek', 'deri', 'edhe', 'apo',
  'vetem', 'shume', 'pak', 'mire', 'keq', 'këtë', 'kete', 'ketij', 'kesaj', 'ketu', 'atje',
  'produkt', 'produkti', 'produktin', 'produktit', 'produktet', 'produkte', 'artikull',
  'permban', 'permbajne', 'permbaje', 'mban', 'brenda', 'pershendetje', 'mfal', 'falem',
  'faleminderit', 'miredita', 'mirembrema', 'perdor', 'perdoret', 'perdorim', 'perdorni',
  // English question/function words
  'the', 'and', 'for', 'are', 'you', 'your', 'this', 'that', 'have', 'has', 'had',
  'does', 'can', 'could', 'would', 'should', 'what', 'which', 'when', 'where', 'how', 'why',
  'with', 'without', 'about', 'more', 'info', 'information', 'please', 'tell', 'there',
  'they', 'them', 'from', 'contain', 'contains', 'containing', 'any', 'product', 'products',
  'hello', 'thanks', 'thank', 'use', 'used', 'using',
]);

/** Folded, diacritic-stripped, letters/digits only — the comparison space for the scan. */
function foldForEvidenceScan(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Common Albanian/English inflection suffixes, longest first, stripped down to a ≥4-char stem. */
const EVIDENCE_STEM_SUFFIXES = ['eve', 'ave', 'ove', 'in', 'en', 'un', 'it', 'et', 'ut', 've', 'es', 'i', 'e', 'a', 'n', 't', 's'];

/** The token plus de-inflected stem variants (min 4-char stem), for substring matching. */
function evidenceTokenVariants(token: string): string[] {
  const variants = new Set<string>([token]);
  for (const suffix of EVIDENCE_STEM_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) {
      variants.add(token.slice(0, token.length - suffix.length));
    }
  }
  return [...variants];
}

/** Content tokens of the customer message worth scanning for (folded, stopworded, ≥3 chars). */
function evidenceScanTokens(searchText: string): string[][] {
  const folded = foldForEvidenceScan(searchText);
  if (!folded) return [];
  const seen = new Set<string>();
  const tokens: string[][] = [];
  for (const raw of folded.split(' ')) {
    if (raw.length < 3 || EVIDENCE_SCAN_STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    tokens.push(evidenceTokenVariants(raw));
    if (tokens.length >= 24) break;
  }
  return tokens;
}

const EVIDENCE_EXCERPT_MAX_SENTENCES = 3;
const EVIDENCE_EXCERPT_MAX_CHARS = 500;

interface FieldEvidenceScan {
  /** Distinct question tokens present in the full text but NOT in the brief slice. */
  missedTokens: number;
  /** Sentences (verbatim, whitespace-normalized) containing a matched token. */
  excerpts: string[];
  /** Full normalized text length — the cost of rendering this field in full mode. */
  fullLen: number;
}

function scanFieldForEvidence(
  text: string | null | undefined,
  tokens: string[][],
  briefMaxChars: number,
): FieldEvidenceScan | null {
  const trimmed = text?.trim();
  if (!trimmed || tokens.length === 0) return null;
  const normalized = normalizeCatalogWhitespace(trimmed);
  const foldedFull = foldForEvidenceScan(normalized);
  if (!foldedFull) return null;
  const foldedBrief = foldForEvidenceScan(summarizeTextForCatalogPrompt(normalized, briefMaxChars));

  const matchedVariantSets: string[][] = [];
  let missedTokens = 0;
  for (const variants of tokens) {
    const inFull = variants.some((v) => foldedFull.includes(v));
    if (!inFull) continue;
    matchedVariantSets.push(variants);
    const inBrief = variants.some((v) => foldedBrief.includes(v));
    if (!inBrief) missedTokens += 1;
  }
  if (missedTokens === 0) return null;

  const excerpts: string[] = [];
  let excerptChars = 0;
  for (const sentence of normalized.split(/(?<=[.!?])\s+/)) {
    const foldedSentence = foldForEvidenceScan(sentence);
    if (!foldedSentence) continue;
    if (!matchedVariantSets.some((variants) => variants.some((v) => foldedSentence.includes(v)))) continue;
    if (excerpts.length >= EVIDENCE_EXCERPT_MAX_SENTENCES) break;
    if (excerptChars + sentence.length > EVIDENCE_EXCERPT_MAX_CHARS && excerpts.length > 0) break;
    excerpts.push(sentence.trim());
    excerptChars += sentence.length;
  }

  return { missedTokens, excerpts, fullLen: normalized.length };
}

/**
 * Decide, per product, whether its description/usage text should render 'full',
 * 'extract' (brief + overlapping sentences) or stay 'brief' for this question.
 * Pure and deterministic — safe to call on every turn.
 */
export function computeCatalogTextEvidence(
  searchText: string,
  products: Array<{ id: string; description: string | null; usage_description: string | null }>,
  options?: CatalogTextEvidenceOptions,
): CatalogTextEvidenceResult {
  const maxFullProducts = options?.maxFullProducts ?? knobNumber('CATALOG_FULL_TEXT_MAX_PRODUCTS');
  const fullTextBudgetChars =
    options?.fullTextBudgetChars ?? knobNumber('CATALOG_FULL_TEXT_TURN_BUDGET_CHARS');

  const result: CatalogTextEvidenceResult = {
    decisions: new Map(),
    fullCount: 0,
    extractCount: 0,
    briefOnlyMiss: false,
  };
  const tokens = evidenceScanTokens(searchText);
  if (tokens.length === 0 || products.length === 0) return result;

  const candidates: Array<{
    id: string;
    description: FieldEvidenceScan | null;
    usage: FieldEvidenceScan | null;
    score: number;
    fullLen: number;
  }> = [];
  for (const p of products) {
    const description = scanFieldForEvidence(p.description, tokens, CATALOG_DESCRIPTION_BRIEF_MAX_CHARS);
    const usage = scanFieldForEvidence(p.usage_description, tokens, CATALOG_USAGE_BRIEF_MAX_CHARS);
    if (!description && !usage) continue;
    candidates.push({
      id: p.id,
      description,
      usage,
      score: (description?.missedTokens ?? 0) + (usage?.missedTokens ?? 0),
      fullLen: (description?.fullLen ?? 0) + (usage?.fullLen ?? 0),
    });
  }
  if (candidates.length === 0) return result;

  result.briefOnlyMiss = true;
  candidates.sort((a, b) => b.score - a.score || a.fullLen - b.fullLen);

  let budgetUsed = 0;
  for (const candidate of candidates) {
    const fits =
      result.fullCount < maxFullProducts && budgetUsed + candidate.fullLen <= fullTextBudgetChars;
    if (fits) {
      result.decisions.set(candidate.id, {
        descriptionMode: candidate.description ? 'full' : 'brief',
        usageMode: candidate.usage ? 'full' : 'brief',
      });
      result.fullCount += 1;
      budgetUsed += candidate.fullLen;
    } else {
      result.decisions.set(candidate.id, {
        descriptionMode: candidate.description ? 'extract' : 'brief',
        usageMode: candidate.usage ? 'extract' : 'brief',
        descriptionExcerpts: candidate.description?.excerpts,
        usageExcerpts: candidate.usage?.excerpts,
      });
      result.extractCount += 1;
    }
  }
  return result;
}

const DESCRIPTION_QUESTION_PATTERNS: RegExp[] = [
  /^(describe (it|this)|description|what is it|what does it do)(\s*[.!?]*)?$/i,
  /^(cfare eshte|çfarë është|pershkruaj|përshkruaj)(\s*[.!?]*)?$/i,
  /\b(tell me (more )?about (it|this|the product)|more (info|information|details) (on|about))\b/i,
  /\b(what('s| is) (it|this) (made of|for)|made of|materials?)\b/i,
  /\b(benefits?|advantages?|features?|ingredients?|composition|perberes|përfitimet?|karakteristika)\b/i,
  /\b(pershkrim|përshkrim|detaje|details about)\b/i,
];

const RECOMMENDATION_CUE_PATTERNS: RegExp[] = [
  /\b(recommend|suggestion|suggest|which (one|product)|best for|compare|vs\b|versus)\b/i,
  /\b(sugjero|rekomand|cfare me sugjeron|çfarë më sugjeron|me mire|më mirë)\b/i,
];

/**
 * Comprehensive patterns that detect recommendation or comparison questions in both
 * English and Albanian (including informal/dialect forms). These run against the
 * diacritic-stripped, lowercased form produced by normalizeForRecommendationIntent().
 *
 * Kept intentionally broad: false-positives are harmless (they skip the product-gap
 * escalation for a benign question), whereas false-negatives cause spurious alerts.
 */
const RECOMMENDATION_COMPARISON_PATTERNS: RegExp[] = [
  // English — explicit recommendation / suggestion / comparison words
  /\b(recommend|suggest(ion)?|which\s+one|which\s+should|which\s+is\s+bet+er|which\s+is\s+best|best\s+(option|choice|pick|one)|compare|vs\b|versus)\b/i,
  /\b(what\s+(would|do)\s+you\s+(recommend|suggest)|which\s+(would|should)\s+(i|you)\s+(buy|get|take|choose|pick|recommend))\b/i,
  /\b(which\s+(one|product)\s+(to|should\s+i)\s+(buy|get|choose|take|pick))\b/i,
  // English — price ranking / value comparison (cheapest, most expensive, lowest price, etc.)
  /\b(cheapest|least\s+expensive|lowest[\s-]priced?|most\s+affordable|most\s+expensive|priciest|highest[\s-]priced?)\b/i,
  /\b(which\s+(is\s+)?(the\s+)?(cheapest|most\s+expensive|lowest[\s-]priced?|best[\s-]priced?|least\s+expensive))\b/i,
  /\b(what\s+(is|are)\s+(the\s+)?(cheapest|most\s+expensive|least\s+expensive|lowest[\s-]price[sd]?))\b/i,
  /\b(which\s+(costs?\s+)?(more|less|the\s+most|the\s+least))\b/i,
  /\b(compare\s+(the\s+)?prices?|price\s+comparison|which\s+has\s+(the\s+)?(best|lowest|highest)\s+price)\b/i,
  // Albanian — recommendation / suggestion keywords (diacritic-stripped)
  /\b(sugjero|sugjeron|sugjeron|rekomand|rekomandon|preferoni?|preferencen?)\b/i,
  /\b(cfare|cila|cilin|cilen|cilat)\b.{0,30}\b(sugjeron|rekomandon|preferon|rekomand)\b/i,
  // Albanian — "me mire" / "me e mire" (better / the best)
  /\bme\s+e?\s*mire\b/i,
  // Albanian — "cili/cila/cilin/cilen eshte me ..." (which is the better/best/cheapest)
  /\b(cili|cila|cilin|cilen|cilat)\s+eshte\s+me\b/i,
  // Albanian — "cilen/cilin te marr / te blej / te zgjedh" (which to take/buy/choose)
  /\b(cilen|cilin|cilat|cila)\b.{0,60}\b(te\s+marr|me\s+marr|te\s+blej|me\s+blej|te\s+zgjidh|me\s+zgjidh|te\s+zgjedh|me\s+zgjedh|te\s+preferon?|me\s+preferon?)\b/i,
  // Albanian — "cilen mkishe than ..." / "cilin do te kishe zgjedhur" (which would you have told/chosen)
  /\b(cilen|cilin|cilat|cila)\b.{0,80}\b(mkishe|do\s+te\s+kishe|kishe\s+than|than\s+ti|do\s+te\s+zgjidhnit?|zgjidhni?)\b/i,
  // Albanian — "cfare me thuaj" / "cfare me rekomandon" (what do you suggest/recommend for me)
  /\bcfare\s+me\s+(sugjeron|rekomandon|thuaj|thoni?)\b/i,
  // Albanian — "me thuaj cilen" / "na thuaj cilin" (tell me which)
  /\b(me|na)\s+thuaj\b.{0,30}\b(cilen|cilin|cilat|cila)\b/i,
  // Albanian — price ranking: "me i lire" (cheapest), "me i shtrenjte" (most expensive).
  // Accepts both Tosk "më" and Gheg "ma", and masculine/feminine endings
  // (lirë/lira, shtrenjtë/shtrenjta), so dialect forms like "cila osht ma e lira"
  // ("which is the cheapest") and "ma i shtrejt" are detected.
  /\b(me|ma)\s+[ie]?\s*lir[aei]?\b/i,
  /\b(me|ma)\s+[ie]?\s*shtre(njt|jt)[aei]?\b/i,
  // Albanian — "ma e mire" / "ma mire" (better / the best, Gheg)
  /\bma\s+e?\s*mir[ae]\b/i,
  // Albanian — "cmim me te ulet/lire" (lowest price), "cmim me te larte/shtrenjte" (highest price)
  /\b[cq]mim\s+me\s+te?\s+(ulet|lire)\b/i,
  /\b[cq]mim\s+me\s+te?\s+(larte|shtrenjte)\b/i,
  // Albanian — "cili/cilin kushton me pak/shume" (which costs less/more)
  /\b(cili|cilin|cila|cilen)\b.{0,40}\b(kushton\s+me|me\s+pak|me\s+shume)\b/i,
  // Albanian — "krahasim cmimesh" / "krahaso cmimet" (price comparison)
  /\b(krahaso\s+[cq]mimet?|krahasim\s+[cq]mimesh?)\b/i,
];

/**
 * P2-5 (RC-25): the Gheg extras are concatenated, never substituted — flag-off resolves to
 * the legacy array itself, so behaviour is byte-identical. Flag-on closes this list's one
 * dialect gap: the copula. The comment at the `(me|ma)` patterns above claims
 * "cila osht ma e lira" is detected, but the "which is more ..." frame requires the
 * literal Tosk 'eshte', so Gheg 'osht'/'asht' reach it and miss.
 */
const RECOMMENDATION_COMPARISON_PATTERNS_EFFECTIVE = withGhegPatterns(
  RECOMMENDATION_COMPARISON_PATTERNS,
  GHEG_RECOMMENDATION_EXTRA_PATTERNS,
);

function normalizeForDescriptionIntent(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s?!.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same normalization used for recommendation detection. */
function normalizeForRecommendationIntent(message: string): string {
  return normalizeForDescriptionIntent(message);
}

/**
 * Returns true when the customer is asking for a product recommendation or comparison
 * (e.g. "which one would you recommend?", "cilen me sugjeron?", "cilen mkishe than ti
 * me marr?") and NOT asking for factual catalog details.
 *
 * Used as a deterministic guard to prevent the product-information-gap escalation path
 * from firing on recommendation questions: the AI CAN compare products using the catalog
 * context it already has and should answer directly without creating a specialist alert.
 *
 * Covers both English and Albanian including informal/dialect spellings and diacritic-
 * free text (patterns run on the diacritic-stripped, lowercased form).
 */
export function isProductRecommendationOrComparisonQuestion(message: string): boolean {
  const t = normalizeForRecommendationIntent(message);
  if (!t || t.length > 300) return false;
  return RECOMMENDATION_COMPARISON_PATTERNS_EFFECTIVE.some((re) => re.test(t));
}

/** Customer wants product facts from the description, not a recommendation list. */
export function isProductDescriptionQuestion(message: string): boolean {
  const t = normalizeForDescriptionIntent(message);
  if (!t) return false;
  if (t.length > 200) return false;
  if (DESCRIPTION_QUESTION_PATTERNS.some((re) => re.test(t))) return true;

  const hasDescriptionCue =
    /\b(describe|description|benefit|feature|ingredient|material|perberes|përshkrim|detaje)\b/.test(
      t,
    );
  const isRecommendationOnly =
    RECOMMENDATION_CUE_PATTERNS.some((re) => re.test(t)) && !hasDescriptionCue;

  return hasDescriptionCue && !isRecommendationOnly && (t.includes('?') || t.split(/\s+/).length <= 12);
}

/**
 * Platform-enforced brevity rule. Always appended to every reply prompt so the
 * shortest-correct-answer behavior cannot be diluted by a tenant editing the
 * `guidelines.messaging_style` block. Kept short and example-driven because the
 * model follows concrete examples far more reliably than abstract instructions.
 */
/**
 * P2-5 (RC-26): the prompt carried THREE competing "HIGHEST PRIORITY" claims — this append, the
 * restrictions footer's docstring, and `guidelines.messaging_style`'s "Brevity (HIGHEST
 * PRIORITY)" — so the model was told three different things were the single top rule. P2-5
 * establishes one ladder and makes the text match the render order:
 *
 *   grounding contract > platform policy > operator rules > brevity > guidelines
 *
 * Brevity is demoted from "highest" to "high" and told what outranks it. The claim in
 * `guidelines.messaging_style` is block content and needs a migration/admin edit — deferred.
 */
const SHORTEST_ANSWER_PRIORITY_CLAUSE = PROMPT_ALLOWLIST_BUDGET
  ? 'HIGH PRIORITY — this overrides any tone or sales-strategy nudge toward longer replies, but the platform policy and operator business rules at the end of this prompt override it'
  : 'HIGHEST PRIORITY — this overrides any tone or sales-strategy nudge toward longer replies';

export const SHORTEST_ANSWER_APPEND = `

Answer length (${SHORTEST_ANSWER_PRIORITY_CLAUSE}):
- Give the SHORTEST reply that fully and correctly answers the customer's current message. Brevity is the default; every extra word must earn its place.
- A one-word or single-line answer is correct and preferred when it fully answers — it does not need to be a complete sentence. Examples:
  - "Do you have this product?" -> "Yes."
  - "Do you have this brand?" -> "Yes."
  - "Is it in stock?" (when stock was asked) -> "Yes."
  - "What is the price?" -> "€25"
- Do NOT restate the product or brand name the customer just referenced, and do NOT add filler such as "we have it available in our catalog".
- Never repeat or rephrase the customer's question, and never restate information the customer already gave you.
- No opening pleasantries or filler ("Of course!", "Sure", "Thanks for reaching out", "I'd be happy to help") — lead directly with the answer.
- Stay natural and polite — concise, not cold or robotic. Keep the words needed for the answer to be clear and grammatical; just cut everything that adds no information.
- Give a longer answer ONLY when the question genuinely needs it or another rule requires fixed/verbatim wording: verbatim usage/dosage instructions, order confirmations (delivery line + the required follow-up sentence), unavailable-product handling (acknowledge + up to 2–3 alternatives where available), attribute questions that need every value listed, recommendations (up to 2–3 products where available), or a genuinely multi-part question.
- Even in those longer cases, stay compact: no intro/preamble line, do not restate the customer's question, do not repeat the same fact twice, and add no closing summary. Return only the required content (and any fixed/verbatim wording) — nothing extra.
- NO FOLLOW-UP QUESTIONS OR INVITATIONS: Never end a product-information, recommendation, price, stock, or comparison reply with any follow-up question or closing invitation — not an order-closing question, not a generic invitation such as "Do you want more information?", "A doni ta porosisni?", "Would you like to order it?", "Let me know if you need anything", "Feel free to ask", "Is there anything else?", "më tregoni", "më shkruani", "nëse keni pyetje", or any similar phrase. Stop immediately after answering the question, nothing extra.`;

export const PRODUCT_DESCRIPTION_CONCISE_APPEND = `

Product description rules (IMPORTANT):
- NEVER send the full product description to the customer, even when a longer "Full description" appears in the catalog context.
- For recommendations, comparisons, or general product suggestions: list ONLY the product name(s) — one per line, no descriptions, no benefits, no details. Example: "Product A\nProduct B\nProduct C". Do NOT add any description or bullet-point text after each name. Only provide descriptions when the customer explicitly follows up and asks for more detail about a specific product (e.g. "tell me more about Product A", "what does it do", "what is the difference?").
- PRICE COMPARISON EXCEPTION: when the customer asks which product is cheapest, most expensive, or asks to compare prices (e.g. "which is cheapest?", "cili eshte me i lire?", "compare prices"), include the price next to the product name — one per line in the format "Product Name: €X". Identify and state directly which is the cheapest/most expensive. Do not add descriptions beyond the price.
- When the customer asks a specific question about a product: answer ONLY what they asked using relevant facts from the catalog; do not dump the entire description.
- If a broader overview is needed, write a very short summary (1–2 lines) of the most important points — never paste the full description verbatim.
- Do NOT proactively mention product attributes (flavor, size, color, variant, weight) unless the customer explicitly asks about them. These fields are provided as internal reference only — include them in your reply only when the customer's question directly asks about that attribute.
- NEVER use markdown formatting in your replies: no bold (**text**), no asterisks, no bullet point lists, no numbered lists, no headers. Write plain conversational text only.`;

export const PRODUCT_DESCRIPTION_TARGETED_APPEND = `

Product description question (IMPORTANT):
- The customer is asking about product details, not requesting a recommendation list.
- Read the full catalog description internally, then reply with ONLY the information that answers their question (or a 1–2 line summary if they asked broadly).
- Do NOT paste or closely paraphrase the entire description.`;

/**
 * Injected only when the customer asked for prices AND there are more than 5 products
 * in context. Keeps category-wide price replies compact without affecting comparison
 * accuracy (all products remain in the prompt for ranking/comparison).
 */
export const PRICE_LIST_COMPACT_APPEND = `

Price listing rule (IMPORTANT — applies when the customer asks for prices across a category):
- When listing prices for a category that has many products, show ONLY the 5 most relevant items. After the last item, add one short line telling the customer they can ask for the full list — in whatever language the customer is using (e.g. "Për listën e plotë të çmimeve, më tregoni." / "For the full price list, just ask.").
- Override the 5-item cap ONLY when the customer explicitly requests everything, for example: "all prices", "full list", "list them all", "te gjitha cmimete", "te gjitha produktet", "listen e plote", "te gjithe", or any clear equivalent in any language.
- For comparison or ranking questions ("which is cheapest?", "which costs more?", "cili kushton me pak?", "cila eshte me e lire?") — do NOT limit; use all available catalog data to answer the comparison accurately and state the answer directly (e.g. "The cheapest is Product X at €Y.").
- For a single specifically named product ("sa kushton Gold Standard 2kg?") — just give that product's price with no list.`;
