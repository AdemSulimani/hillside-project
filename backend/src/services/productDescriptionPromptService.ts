/** Max characters for brief catalog description lines (~1–2 lines in chat). */
export const CATALOG_DESCRIPTION_BRIEF_MAX_CHARS = 200;

/** Max characters for usage text shown in catalog when the turn is not a usage question. */
export const CATALOG_USAGE_BRIEF_MAX_CHARS = 200;

export type CatalogTextMode = 'brief' | 'full';

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
  return RECOMMENDATION_COMPARISON_PATTERNS.some((re) => re.test(t));
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
export const SHORTEST_ANSWER_APPEND = `

Answer length (HIGHEST PRIORITY — this overrides any tone or sales-strategy nudge toward longer replies):
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
- NO GENERIC FOLLOW-UP INVITATIONS: Never end a product-information, price, stock, or comparison reply with a generic closing invitation such as "Do you want more information?", "Let me know if you need anything", "Feel free to ask", "Is there anything else?", "më tregoni", "më shkruani", "nëse keni pyetje", or any similar phrase. The ONLY permitted exception is the single order-oriented follow-up question allowed by the follow-up/closing policy (at most once per conversation, on the very first product turn) — outside that one case, stop immediately after answering the question, nothing extra.`;

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
