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

/** Locales supported by the holding/notice copy (matches aiService ReplyLocale). */
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
