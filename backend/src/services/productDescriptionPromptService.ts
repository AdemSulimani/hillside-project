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
- Give a longer answer ONLY when the question genuinely needs it or another rule requires fixed/verbatim wording: verbatim usage/dosage instructions, order confirmations (delivery line + the required follow-up sentence), unavailable-product handling (acknowledge + 1–2 alternatives), attribute questions that need every value listed, recommendations (1–2 products), or a genuinely multi-part question.
- Even in those longer cases, stay compact: no intro/preamble line, do not restate the customer's question, do not repeat the same fact twice, and add no closing summary. Return only the required content (and any fixed/verbatim wording) — nothing extra.`;

export const PRODUCT_DESCRIPTION_CONCISE_APPEND = `

Product description rules (IMPORTANT):
- NEVER send the full product description to the customer, even when a longer "Full description" appears in the catalog context.
- For recommendations, comparisons, or general product suggestions: mention at most 2 products — pick the best fits. For each, write at most 1–2 short lines with only the key benefits or selling points from the catalog — do not copy or paraphrase long catalog text.
- When the customer asks a specific question about a product: answer ONLY what they asked using relevant facts from the catalog; do not dump the entire description.
- If a broader overview is needed, write a very short summary (1–2 lines) of the most important points — never paste the full description verbatim.
- Do NOT proactively mention product attributes (flavor, size, color, variant, weight) unless the customer explicitly asks about them. These fields are provided as internal reference only — include them in your reply only when the customer's question directly asks about that attribute.
- NEVER use markdown formatting in your replies: no bold (**text**), no asterisks, no bullet point lists, no numbered lists, no headers. Write plain conversational text only.`;

export const PRODUCT_DESCRIPTION_TARGETED_APPEND = `

Product description question (IMPORTANT):
- The customer is asking about product details, not requesting a recommendation list.
- Read the full catalog description internally, then reply with ONLY the information that answers their question (or a 1–2 line summary if they asked broadly).
- Do NOT paste or closely paraphrase the entire description.`;
