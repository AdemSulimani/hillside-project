/**
 * Pure, dependency-light helpers for the PARTIAL PRODUCT ANSWER + attribute-level
 * escalation flow.
 *
 * Problem this solves:
 *   When a customer asks several things about a product (e.g. "what is the price
 *   and what brand is it?") the AI may know SOME answers (price) but not others
 *   (brand). The previous behaviour was all-or-nothing: a single missing detail
 *   discarded the entire reply and sent a generic holding message, withholding
 *   information we already had. Conversely, a missing attribute on a product that
 *   DOES exist must never produce a "product not available / not in catalog"
 *   response.
 *
 * This module decides, deterministically and testably, how to combine the known
 * answer with a "we will notify you shortly" notice for the missing parts, and
 * which structured attributes are definitely missing across the matched products.
 *
 * It intentionally performs NO I/O and imports NO runtime-heavy modules (no OpenAI
 * client, no DB) so it is fully unit-testable in-process — mirroring
 * productAttributeResolution.ts and usageSuitabilityHelpers.ts.
 */
import type { StructuredAttributeKey } from './productRetrievalService';

/**
 * Locales supported by the holding/notice copy (matches aiService ReplyLocale).
 *
 * ADDING A NEW LOCALE — single-table-change checklist:
 *   1. Add the new key to this union type.
 *   2. Add an entry to `STRUCTURED_ATTRIBUTE_LABELS` (attribute display names in the new language).
 *   3. Add an entry to `GENERIC_NOTICE_LIST_NORMS` (normalized text of the generic "this information" phrase).
 *   4. Add an entry to `MISSING_NOTICE_PATTERNS` (regex matching the locale's "we will notify you" sentence).
 *   5. In processAIReply.ts: add an entry to HOLDING_MESSAGES, DATA_CONFIRMATION_MESSAGES,
 *      MISSING_CUSTOMER_NAME_MESSAGES, ORDER_CONFIRMATION_FOLLOW_UP, and VARIANT_CLARIFICATION_LEAD_IN.
 *   6. In aiService.ts: add the locale to the ReplyLocale union and all locale-dispatch tables there.
 *
 * Every locale-specific string lives in a single Record<Locale, …> table; no regex,
 * switch, or if/else chain outside these tables needs updating.
 */
export type InfoGapLocale = 'sq' | 'en';

/**
 * Answerability of a product-information request:
 *  - 'complete'  : every requested piece of info is available → send the full answer.
 *  - 'partial'   : some info is available, some is missing → answer what we know AND escalate the rest.
 *  - 'none'      : nothing requested could be answered from the catalog → escalate with a holding notice.
 */
export type AnswerabilityStatus = 'complete' | 'partial' | 'none';

/** Customer-facing single-word labels for each structured attribute, per locale. */
const STRUCTURED_ATTRIBUTE_LABELS: Record<InfoGapLocale, Record<StructuredAttributeKey, string>> = {
  en: {
    flavor: 'flavor',
    size: 'size',
    color: 'color',
    variant: 'variant',
    weight: 'weight',
    brand: 'brand',
    category: 'product type',
  },
  sq: {
    flavor: 'shija',
    size: 'madhësia',
    color: 'ngjyra',
    variant: 'varianti',
    weight: 'pesha',
    brand: 'marka',
    category: 'lloji i produktit',
  },
};

/** Map structured attribute keys to localized, customer-friendly labels. */
export function localizedAttributeLabels(
  keys: StructuredAttributeKey[],
  locale: InfoGapLocale,
): string[] {
  const table = STRUCTURED_ATTRIBUTE_LABELS[locale] ?? STRUCTURED_ATTRIBUTE_LABELS.en;
  return keys.map((k) => table[k]).filter((v): v is string => Boolean(v));
}

/** Normalize a label for case/diacritic-insensitive de-duplication. */
function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^the\s+/, '')
    .replace(/\s+information$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Synonym groups for the same underlying product attribute, in BOTH locales plus
 * the informal spellings the model tends to emit. The LLM ("missing" labels) and
 * the deterministic structured net localize the SAME attribute differently (e.g.
 * the model returns "brandi" while the structured net returns "marka"), which made
 * a single requested attribute appear twice ("...lidhur me brandi dhe marka").
 * Mapping every synonym to one canonical key lets de-duplication collapse them so
 * each requested attribute is mentioned exactly once. Values are matched after
 * `normalizeLabel` (lowercase, diacritics stripped).
 */
const ATTRIBUTE_SYNONYM_GROUPS: Record<string, string[]> = {
  brand: ['brand', 'brands', 'brandi', 'brend', 'brendi', 'marka', 'marke', 'markes', 'trademark', 'prodhuesi', 'manufacturer'],
  weight: ['weight', 'pesha', 'masa', 'gramazhi', 'gramatura'],
  flavor: ['flavor', 'flavour', 'taste', 'shija', 'shije', 'aroma'],
  size: ['size', 'madhesia', 'permasa', 'permasat', 'dimension', 'dimensions'],
  color: ['color', 'colour', 'ngjyra'],
  variant: ['variant', 'varianti'],
  category: ['category', 'product type', 'lloji i produktit', 'lloji', 'kategoria', 'type'],
};

/** normalized synonym -> canonical group key (for synonym-aware de-duplication). */
const SYNONYM_GROUP_BY_LABEL: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [group, synonyms] of Object.entries(ATTRIBUTE_SYNONYM_GROUPS)) {
    for (const synonym of synonyms) {
      map.set(normalizeLabel(synonym), group);
    }
  }
  return map;
})();

/** Normalized localized structured labels — the canonical wording to prefer when shown. */
const CANONICAL_LABEL_NORMS: ReadonlySet<string> = new Set(
  Object.values(STRUCTURED_ATTRIBUTE_LABELS).flatMap((labels) =>
    Object.values(labels).map((label) => normalizeLabel(label)),
  ),
);

/**
 * De-duplicate a list of human-readable info labels. Synonyms for the same
 * attribute (e.g. "brandi"/"marka", "flavor"/"shija") collapse to a single entry,
 * preferring the canonical localized wording when present; otherwise the first
 * occurrence's wording/casing is kept. Empty/whitespace labels are dropped.
 */
export function dedupeInfoLabels(labels: string[]): string[] {
  const groups = new Map<string, { display: string; canonical: boolean }>();
  const order: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const norm = normalizeLabel(trimmed);
    if (!norm) continue;
    const key = SYNONYM_GROUP_BY_LABEL.get(norm) ?? norm;
    const isCanonical = CANONICAL_LABEL_NORMS.has(norm);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { display: trimmed, canonical: isCanonical });
      order.push(key);
    } else if (!existing.canonical && isCanonical) {
      // A later synonym uses the system's canonical wording — prefer it.
      existing.display = trimmed;
      existing.canonical = true;
    }
  }
  return order.map((key) => groups.get(key)!.display);
}

/**
 * Normalize free reply/answer text for word-level concept scanning: lowercase,
 * strip diacritics, drop punctuation, collapse whitespace.
 */
function normalizeForConceptScan(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The set of normalized tokens that indicate a given info label's underlying concept
 * is being discussed. For attributes in a synonym group this returns every synonym in
 * BOTH locales (so "shija" matches an answer that says "shije"); for free-form labels
 * (e.g. "ingredients"/"përbërësit") it returns the label's own normalized form.
 */
function conceptTokensForLabel(label: string): string[] {
  const norm = normalizeLabel(label);
  if (!norm) return [];
  const group = SYNONYM_GROUP_BY_LABEL.get(norm);
  if (group) {
    return ATTRIBUTE_SYNONYM_GROUPS[group]
      .map((synonym) => normalizeLabel(synonym))
      .filter((token) => token.length > 0);
  }
  return [norm];
}

/**
 * Whether the supplied (already concept-normalized) text mentions the concept named by
 * `label`. Single-word tokens match by word-prefix (so "shije" also matches "shijet"
 * and "marka" matches "markes"); multi-word tokens match as a substring.
 */
function textMentionsConcept(normalizedText: string, label: string): boolean {
  if (!normalizedText) return false;
  return conceptTokensForLabel(label).some((token) => {
    if (token.includes(' ')) return normalizedText.includes(token);
    // Word-boundary prefix match: token may be followed by inflectional letters.
    const re = new RegExp(`(?:^|\\s)${escapeRegExp(token)}[\\p{L}]*(?:\\s|$)`, 'u');
    return re.test(normalizedText);
  });
}

/**
 * SAFEGUARD (Layer 2): drop from `missing` any label whose concept the grounded
 * `answeredText` already provides. This prevents the contradictory "X is lemon. We'll
 * notify you shortly about X." class of replies at composition time — independent of
 * whether the spurious label came from the LLM or the deterministic structured net.
 *
 * It relies on the composer's contract (the answer states a value only when known and
 * never mentions a missing concept), so a concept appearing in the answer means it was
 * answered and must not also be escalated.
 */
export function reconcileMissingAgainstAnswer(
  missing: string[],
  answeredText: string,
): string[] {
  const known = normalizeForConceptScan(answeredText);
  if (!known) return [...missing];
  return missing.filter((label) => !textMentionsConcept(known, label));
}

/**
 * Join labels into a natural-language list using the locale conjunction.
 *   en: ["brand"]                -> "brand"
 *       ["brand", "ingredients"] -> "brand and ingredients"
 *       ["a", "b", "c"]          -> "a, b and c"
 *   sq: uses "dhe" instead of "and".
 */
export function formatInfoList(labels: string[], locale: InfoGapLocale): string {
  const cleaned = labels.map((l) => l.trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) return cleaned[0];
  const conjunction = locale === 'sq' ? 'dhe' : 'and';
  const head = cleaned.slice(0, -1).join(', ');
  const tail = cleaned[cleaned.length - 1];
  return `${head} ${conjunction} ${tail}`;
}

/**
 * The localized "we will notify you shortly" sentence naming the missing info.
 * Used both as the trailing line of a partial answer and inside the standalone
 * holding message. Falls back to a generic phrasing when no labels are supplied.
 */
export function buildMissingInfoNotice(missing: string[], locale: InfoGapLocale): string {
  const list = formatInfoList(dedupeInfoLabels(missing), locale);
  if (locale === 'sq') {
    return list
      ? `Do t'ju njoftojmë së shpejti lidhur me ${list}.`
      : `Do t'ju njoftojmë së shpejti lidhur me këtë informacion.`;
  }
  return list
    ? `We will notify you shortly regarding the ${list} information.`
    : `We will notify you shortly regarding this information.`;
}

/**
 * Standalone holding message for the "nothing answerable" case — greets the
 * customer and names the missing info. NEVER states the product is unavailable.
 */
export function buildMissingInfoHoldingMessage(missing: string[], locale: InfoGapLocale): string {
  const notice = buildMissingInfoNotice(missing, locale);
  return locale === 'sq' ? `Përshëndetje, ${lowerFirst(notice)}` : `Hello, ${lowerFirst(notice)}`;
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/**
 * Compose the customer-facing PARTIAL answer: the known information followed by a
 * single notice covering everything that must still be looked up by a human.
 */
export function composePartialAnswer(
  answeredText: string,
  missing: string[],
  locale: InfoGapLocale,
): string {
  const known = (answeredText ?? '').trim();
  const notice = buildMissingInfoNotice(missing, locale);
  if (!known) return notice;
  // Avoid double punctuation / spacing when the known answer already ends a sentence.
  const separator = /[.!?…]$/.test(known) ? ' ' : '. ';
  return `${known}${separator}${notice}`;
}

/**
 * Derive the overall answerability status from the composed answer text and the
 * list of missing info items. Pure and deterministic.
 */
export function deriveAnswerabilityStatus(
  answeredText: string,
  missing: string[],
): AnswerabilityStatus {
  const cleanMissing = dedupeInfoLabels(missing);
  if (cleanMissing.length === 0) return 'complete';
  return (answeredText ?? '').trim().length > 0 ? 'partial' : 'none';
}

/**
 * Narrow vocabulary of FREE-FORM product information concepts a customer can ask about
 * that live outside the structured attribute columns (P0-3, RC-01). Stems are matched
 * word-prefix-wise against `normalizeLabel` output, so inflections match ("përbërësit"
 * → "perberesit" matches stem "perberes"; "dozat" matches "doz"). Multi-word stems
 * match as substrings.
 *
 * Purpose: under the deterministic-first gap gate, an LLM "missing" label may trigger
 * an escalation ONLY when it names one of these known free-form concepts. Labels that
 * map to a STRUCTURED attribute are owned by the deterministic net (which adds its own
 * localized labels when a requested attribute is genuinely absent), and labels naming
 * neither — question echoes such as "ma shum" or "cila eshte me e mire", the measured
 * IN1/IN3/EV-010 false-escalation drivers — are suppressed.
 */
const FREE_FORM_INFO_STEMS: string[] = [
  // ingredients / composition
  'ingredient', 'perberes', 'perberj', 'composition',
  // usage / instructions / dosage
  'usage', 'perdorim', 'udhezim', 'instruction', 'doz', 'serving',
  // expiry / shelf life
  'expir', 'afat', 'skadenc', 'shelf life',
  // origin / provenance
  'origin', 'origjin', 'prejardhj',
  // nutrition — deliberately NO single-word 'protein'/'kalori' stems: in a supplements
  // catalog "protein" is the product category, so a stochastic question echo like
  // "proteina" would sail through the filter and reintroduce the RC-01 false-escalation
  // class. Only content/quantity-shaped labels ("sa proteina ka", "protein content")
  // count as a genuine nutrition-info gap; the residual (an LLM labelling a true gap
  // with the bare word "proteina") fails soft — the customer still gets the grounded
  // reply, no escalation.
  'nutrition', 'nutritional', 'vlera ushqyese', 'vlerat ushqyese',
  'sa proteina', 'proteina ka', 'gram proteina', 'protein content', 'permban proteina',
  'sa kalori', 'kalori ka', 'calorie content',
  // allergens / dietary
  'allergen', 'alergjen', 'gluten', 'laktoz', 'lactose', 'sheqer', 'sugar', 'vegan', 'vegetarian',
  // certifications / warranty / authenticity
  'certif', 'garanci', 'warranty', 'authentic',
  // material (non-supplement niches)
  'material',
];

/** Whether a normalized label word-matches a free-form info stem. */
function matchesFreeFormStem(norm: string): boolean {
  if (!norm) return false;
  const words = norm.split(' ');
  return FREE_FORM_INFO_STEMS.some((stem) =>
    stem.includes(' ') ? norm.includes(stem) : words.some((w) => w.startsWith(stem)),
  );
}

/**
 * Deterministic-first filter (P0-3, RC-01) for the LLM assessor's `missing` labels:
 * keep only labels naming a known FREE-FORM info concept. Structured-attribute
 * synonyms are dropped — when such an attribute is genuinely absent the deterministic
 * net (computeMissingStructuredAttributes / the per-product pass) contributes its own
 * localized label, so the LLM's opinion on structured attributes never decides an
 * escalation on its own. Everything else (stochastic question echoes) is suppressed.
 */
export function filterFreeFormInfoLabels(labels: string[]): string[] {
  return labels.filter((label) => {
    if (typeof label !== 'string') return false;
    const norm = normalizeLabel(label);
    if (!norm) return false;
    if (SYNONYM_GROUP_BY_LABEL.has(norm)) return false;
    return matchesFreeFormStem(norm);
  });
}

/**
 * The gap gate's escalation decision (P0-3, RC-01). Pure so both policies are
 * unit-testable:
 *  - Legacy (deterministicFirst=false): escalate when the assessment failed closed
 *    (`!ok` — including transport/parse errors) OR anything is missing.
 *  - Deterministic-first (deterministicFirst=true): escalate ONLY on the missing-info
 *    status, which by construction is backed by deterministic structured evidence or
 *    an allowlisted free-form gap (see filterFreeFormInfoLabels). An errored assessor
 *    yields empty answer/missing → status 'complete' when the deterministic net is
 *    clear → the original AI reply is sent as-is (fail OPEN on the degradation path),
 *    while a genuinely absent structured attribute still escalates.
 */
export function decideGapEscalation(
  assessment: { ok: boolean },
  status: AnswerabilityStatus,
  deterministicFirst: boolean,
): boolean {
  if (deterministicFirst) return status !== 'complete';
  return !assessment.ok || status !== 'complete';
}

/** A product's structured attribute view (subset of getProductStructuredAttributes output). */
export type StructuredAttributeMap = Partial<Record<StructuredAttributeKey, string | null>>;

/**
 * Determine which of the REQUESTED structured attributes cannot be answered from
 * ANY of the matched products — considering both the structured catalog fields and
 * the set of attribute keys that were confidently read from product images.
 *
 * An attribute is considered AVAILABLE when at least one matched product carries a
 * non-empty structured value for it, OR the key is present in `imageUsableKeys`
 * (high-confidence packaging-derived facts). Everything else is reported missing.
 *
 * This is the deterministic safety net guaranteeing we escalate a genuinely-missing
 * structured attribute even if the LLM composer is unavailable or too lenient — and
 * that we NEVER escalate an attribute the catalog can actually answer.
 */
export function computeMissingStructuredAttributes(
  requested: StructuredAttributeKey[],
  productAttributeMaps: StructuredAttributeMap[],
  imageUsableKeys: ReadonlySet<string> = new Set(),
): StructuredAttributeKey[] {
  if (requested.length === 0) return [];
  const missing: StructuredAttributeKey[] = [];
  for (const key of requested) {
    const availableInCatalog = productAttributeMaps.some((attrs) => {
      const value = attrs?.[key];
      return typeof value === 'string' && value.trim().length > 0;
    });
    const availableFromImage = imageUsableKeys.has(key);
    if (!availableInCatalog && !availableFromImage) {
      missing.push(key);
    }
  }
  return missing;
}

/**
 * Locale-specific matchers for the trailing "we will notify you shortly regarding …"
 * notice produced by buildMissingInfoNotice. Capture group 1 is the named info list
 * (e.g. "shije", "marka dhe pesha", or the generic "këtë informacion" / "this").
 */
const MISSING_NOTICE_PATTERNS: Record<InfoGapLocale, RegExp> = {
  sq: /\s*Do t['’]ju njoftojm[ëe] s[ëe] shpejti lidhur me\s+([^.!?]+?)\s*[.!?]+/u,
  en: /\s*We will notify you shortly regarding\s+(?:the\s+)?([^.!?]+?)\s*[.!?]+/iu,
};

/** Normalized form of the generic (no named attribute) notice list, per locale. */
const GENERIC_NOTICE_LIST_NORMS: Record<InfoGapLocale, string[]> = {
  sq: ['kete informacion'],
  en: ['this information', 'this'],
};

/** Split a notice's info list back into individual labels using the locale conjunction. */
function splitNoticeInfoList(list: string, locale: InfoGapLocale): string[] {
  const conjunction = locale === 'sq' ? 'dhe' : 'and';
  return list
    .split(new RegExp(`\\s*,\\s*|\\s+${conjunction}\\s+`, 'i'))
    .map((part) => part.replace(/\s+information$/i, '').trim())
    .filter((part) => part.length > 0);
}

/**
 * FINAL VALIDATION LAYER (Layer 3): the last line of defence run on the fully composed
 * outbound reply, right before it is sent. It detects the "we will notify you shortly
 * regarding X" notice and removes any attribute from it that the rest of the reply has
 * ALREADY answered — eliminating self-contradictory messages such as:
 *
 *   "We have Carbo One 1kg in lemon flavor. We will notify you shortly regarding the flavor."
 *
 * Behaviour:
 *   - If every named attribute in the notice is already answered → the whole notice
 *     sentence is removed.
 *   - If only some are answered → the notice is rebuilt naming only the still-missing
 *     attributes.
 *   - The generic notice ("…regarding this information") names nothing specific and is
 *     left untouched (it cannot contradict a stated value).
 *   - Replies without the notice are returned unchanged.
 *   - When `options.multiProduct` is true the function returns the reply unchanged: in
 *     multi-product queries the notice legitimately names an attribute that appears in
 *     the reply for ONE product but is genuinely absent for OTHERS, so stripping it
 *     would hide the per-product knowledge gap.
 *
 * Pure and deterministic; safe to run on every outbound message regardless of channel.
 */
export function stripContradictoryMissingInfoNotice(
  reply: string,
  locale: InfoGapLocale,
  options?: { multiProduct?: boolean },
): string {
  // Multi-product replies: an attribute may be stated for one product while still
  // missing for others — the notice is valid for those products, do not strip it.
  if (options?.multiProduct) return reply ?? '';
  const text = reply ?? '';
  const pattern = MISSING_NOTICE_PATTERNS[locale] ?? MISSING_NOTICE_PATTERNS.en;
  const match = pattern.exec(text);
  if (!match) return text;

  const list = match[1]?.trim() ?? '';
  const listNorm = normalizeForConceptScan(list);

  // Generic, non-specific notice — nothing to contradict; leave the reply as-is.
  if (!list || GENERIC_NOTICE_LIST_NORMS[locale].includes(listNorm)) {
    return text;
  }

  // Everything OUTSIDE the notice sentence is the "answered" portion of the reply.
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const answeredPortion = normalizeForConceptScan(`${before} ${after}`);

  const labels = splitNoticeInfoList(list, locale);
  if (labels.length === 0) return text;

  const stillMissing = labels.filter((label) => !textMentionsConcept(answeredPortion, label));

  // No contradiction detected — keep the original notice exactly.
  if (stillMissing.length === labels.length) return text;

  const rebuilt = stillMissing.length > 0 ? ` ${buildMissingInfoNotice(stillMissing, locale)}` : '';
  const result = `${before.trimEnd()}${rebuilt}${after}`;
  // Tidy any double spaces / stray leading punctuation introduced by the removal.
  return result.replace(/[ \t]{2,}/g, ' ').replace(/\s+([.!?])/g, '$1').trim();
}
