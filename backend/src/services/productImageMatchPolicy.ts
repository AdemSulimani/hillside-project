/**
 * Pure, dependency-light decision policy for the customer image → catalog product
 * matching pipeline.
 *
 * This module intentionally contains NO I/O and NO heavy runtime imports (no OpenAI
 * client, no DB pool) so the matching policy can be unit-tested in isolation and the
 * confidence thresholds live in a single, documented place.
 */
import { knobNumber } from '../config/knobs';
import type { VisualFingerprintData } from '../db/models/productImageFingerprint';

export type ImageQuality = 'good' | 'fair' | 'poor';

// P2-7: read through the manifest, which supplies the NaN guard + [0,1] band these four lacked.
// They were bare `parseFloat(process.env.X || '0.62')` — the same defect class as
// SIMILARITY_THRESHOLD: a typo'd value yields NaN, every comparison against it is false, and image
// matching silently stops matching anything. `config/knobs` is a leaf module, so importing it keeps
// this file's no-I/O-no-heavy-imports contract (see the header) intact.
export const IMAGE_SIMILARITY_THRESHOLD = knobNumber('IMAGE_SIMILARITY_THRESHOLD');
export const IMAGE_MATCH_CONFIDENCE_THRESHOLD = knobNumber('IMAGE_MATCH_CONFIDENCE_THRESHOLD');
export const VISION_EXTRACTION_CONFIDENCE_MIN = knobNumber('VISION_EXTRACTION_CONFIDENCE_MIN');
export const IMAGE_MATCH_AMBIGUITY_DELTA = knobNumber('IMAGE_MATCH_AMBIGUITY_DELTA');

/** Confidence at/above which a candidate is treated as a confident match. */
export const CONFIDENT_MATCH_FLOOR = IMAGE_MATCH_CONFIDENCE_THRESHOLD;
/** Upper confidence guard for asking about poor quality — above this we won't nag. */
export const QUALITY_CLARIFY_CONFIDENCE_CEILING = 0.65;

export interface CustomerVisionExtraction extends VisualFingerprintData {
  confidence: number;
  image_quality: ImageQuality;
  multiple_products_detected: boolean;
  product_count_estimate: number;
  is_social_media_screenshot: boolean;
  extraction_notes: string | null;
  /** False when the photo contains no identifiable retail product (selfie, receipt, meme, empty scene). */
  contains_product: boolean;
  /** True when one product is the clear foreground/primary subject (others are background or duplicates). */
  primary_subject_clear: boolean;
  /**
   * True when the customer's message named/described a specific product and the vision
   * model selected that one among several visible DIFFERENT products. When set, the
   * customer's words — not visual prominence — disambiguated the target, so we must NOT
   * ask "which one do you mean?".
   */
  primary_selected_via_message_text: boolean;
  /**
   * Number of visually DISTINCT products (different SKUs). Identical duplicates of
   * the same item count as 1. This is the signal that decides whether to ask
   * "which one do you mean?" — not the raw item count.
   */
  distinct_product_count: number;
  /** True when every visible product instance is the same item (e.g. three of the same bottle). */
  all_visible_products_identical: boolean;
  /** True when hands, reflections, packaging glare, or unrelated objects partially obscure the product. */
  has_distracting_objects: boolean;
}

/**
 * Tiered outcome of the image-match decision. Made explicit (instead of a scattered
 * if/else ladder) so the "should we ask the customer?" question is documented,
 * testable, and tunable in one place.
 *
 * - confident_match:           answer directly using the matched catalog product.
 * - tentative_match:           best candidate is plausible but not certain — present
 *                              it with a hedge / yes-no confirm, do NOT interrogate.
 * - clarify_multiple_distinct: several DIFFERENT products and no clear primary — ask which.
 * - clarify_quality:           photo too poor / occluded to match — ask for a clearer one.
 * - clarify_low_confidence:    readable but identification confidence too low — ask for detail.
 * - not_in_catalog:            identified well enough; we simply do not carry it.
 * - no_product_detected:       the image is not a product photo at all.
 */
export type VisionMatchDecision =
  | 'confident_match'
  | 'tentative_match'
  | 'clarify_multiple_distinct'
  | 'clarify_quality'
  | 'clarify_low_confidence'
  | 'not_in_catalog'
  | 'no_product_detected';

export interface VisionDecisionInput {
  extraction: CustomerVisionExtraction | null;
  matchConfidence: number;
  /** Best raw visual fingerprint similarity among candidates (0 when none). */
  topSimilarity: number;
  /** True when at least one catalog candidate survived scoring. */
  hasCatalogCandidates: boolean;
  brandLikelyAbsent: boolean;
  /** True when a legible SKU/barcode resolved deterministically to a catalog product. */
  exactSkuMatch: boolean;
}

export interface VisionDecision {
  decision: VisionMatchDecision;
  shouldAskClarification: boolean;
  productNotInCatalog: boolean;
  /** Legacy reason string consumed by the prompt-rule builder and downstream logging. */
  clarificationReason: string | null;
}

export function decisionToReason(decision: VisionMatchDecision): string | null {
  switch (decision) {
    case 'clarify_multiple_distinct':
      return 'multiple_products_in_image';
    case 'clarify_quality':
      return 'poor_image_quality';
    case 'clarify_low_confidence':
      return 'low_extraction_confidence';
    case 'no_product_detected':
      return 'no_product_detected';
    case 'not_in_catalog':
      return 'product_not_in_catalog';
    default:
      return null;
  }
}

/**
 * Derives the duplicate-aware product counts from the raw model fields. Identical
 * duplicates collapse to a single distinct product, and a single distinct product
 * is by definition the clear primary subject. Defaults are backward-compatible:
 * a missing `contains_product` is treated as true so we never reject valid photos
 * because an older cached extraction omitted the field.
 */
export function deriveVisionCounts(raw: {
  multiple_products_detected?: unknown;
  product_count_estimate?: unknown;
  distinct_product_count?: unknown;
  all_visible_products_identical?: unknown;
  primary_subject_clear?: unknown;
  primary_selected_via_message_text?: unknown;
  contains_product?: unknown;
}): {
  multipleDetected: boolean;
  productCountEstimate: number;
  distinctProductCount: number;
  allIdentical: boolean;
  primarySubjectClear: boolean;
  primarySelectedViaMessageText: boolean;
  containsProduct: boolean;
} {
  const multipleDetected = raw.multiple_products_detected === true;
  const productCountEstimate =
    typeof raw.product_count_estimate === 'number' && raw.product_count_estimate > 0
      ? Math.min(10, Math.round(raw.product_count_estimate))
      : multipleDetected
        ? 2
        : 1;

  const containsProduct = raw.contains_product !== false;
  const allIdentical = raw.all_visible_products_identical === true;

  let distinctProductCount: number;
  if (typeof raw.distinct_product_count === 'number' && raw.distinct_product_count > 0) {
    distinctProductCount = Math.min(10, Math.round(raw.distinct_product_count));
  } else if (allIdentical) {
    distinctProductCount = 1;
  } else {
    distinctProductCount = productCountEstimate;
  }
  if (allIdentical) distinctProductCount = 1;

  // When the customer's message named the product they mean, their words disambiguate
  // the target even if no single item is visually dominant — so the primary subject is
  // considered clear and we must not fall into the "which one?" clarification branch.
  const primarySelectedViaMessageText = raw.primary_selected_via_message_text === true;

  const primarySubjectClear =
    distinctProductCount <= 1
      ? true
      : raw.primary_subject_clear === true || primarySelectedViaMessageText;

  return {
    multipleDetected,
    productCountEstimate,
    distinctProductCount,
    allIdentical,
    primarySubjectClear,
    primarySelectedViaMessageText,
    containsProduct,
  };
}

/**
 * Pure, side-effect-free policy that maps the assembled signals to a single tiered
 * decision. Kept free of I/O so it can be unit-tested exhaustively.
 */
export function decideVisionMatch(input: VisionDecisionInput): VisionDecision {
  const { extraction, matchConfidence, topSimilarity, hasCatalogCandidates, brandLikelyAbsent, exactSkuMatch } =
    input;

  const wrap = (decision: VisionMatchDecision): VisionDecision => ({
    decision,
    shouldAskClarification:
      decision === 'clarify_multiple_distinct' ||
      decision === 'clarify_quality' ||
      decision === 'clarify_low_confidence' ||
      decision === 'no_product_detected',
    productNotInCatalog: decision === 'not_in_catalog',
    clarificationReason: decisionToReason(decision),
  });

  // A legible SKU/barcode that resolved to a catalog row is the strongest possible
  // signal — trust it even over fuzzy visual similarity.
  if (exactSkuMatch) return wrap('confident_match');

  // No structured extraction at all (vision call failed / skipped): defer to whatever
  // the text-matching pool produced rather than inventing a clarification.
  if (!extraction) {
    return wrap(hasCatalogCandidates ? 'tentative_match' : 'clarify_low_confidence');
  }

  // The photo is not a product image — ask for one rather than matching noise.
  if (!extraction.contains_product) {
    return wrap('no_product_detected');
  }

  // Several genuinely different products and none stands out as the subject:
  // refuse to guess; ask which one. Identical duplicates and "distinct + clear
  // primary subject" intentionally fall through and match normally.
  if (extraction.distinct_product_count > 1 && !extraction.primary_subject_clear) {
    return wrap('clarify_multiple_distinct');
  }

  // Strong overall confidence → answer directly.
  if (matchConfidence >= CONFIDENT_MATCH_FLOOR) {
    return wrap('confident_match');
  }

  // Strong raw visual similarity even if the blended score sits below the confident
  // floor → present the candidate tentatively (hedged), without interrogating.
  if (hasCatalogCandidates && topSimilarity >= IMAGE_SIMILARITY_THRESHOLD) {
    return wrap('tentative_match');
  }

  // Brand was read clearly and is absent from the catalog → a definitive miss; do
  // not ask for a better photo, just say we don't carry it.
  if (brandLikelyAbsent && extraction.brand_name) {
    return wrap('not_in_catalog');
  }

  // Photo quality / occlusion is the limiting factor → ask for a clearer one
  // (but don't nag once confidence is already reasonable).
  if (
    (extraction.image_quality === 'poor' || extraction.has_distracting_objects) &&
    matchConfidence < QUALITY_CLARIFY_CONFIDENCE_CEILING
  ) {
    return wrap('clarify_quality');
  }

  // Readable but identification confidence too low to commit → ask for a detail.
  if (extraction.confidence < VISION_EXTRACTION_CONFIDENCE_MIN) {
    return wrap('clarify_low_confidence');
  }

  // The image was readable enough to search and nothing matched.
  if (!hasCatalogCandidates) {
    return wrap('not_in_catalog');
  }

  // Fallback: a weak candidate exists — present it tentatively rather than asserting.
  return wrap('tentative_match');
}
