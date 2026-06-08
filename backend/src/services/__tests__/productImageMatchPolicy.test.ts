import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideVisionMatch,
  deriveVisionCounts,
  CONFIDENT_MATCH_FLOOR,
  IMAGE_SIMILARITY_THRESHOLD,
  VISION_EXTRACTION_CONFIDENCE_MIN,
  type CustomerVisionExtraction,
} from '../productImageMatchPolicy';

function mockExtraction(
  overrides: Partial<CustomerVisionExtraction> = {},
): CustomerVisionExtraction {
  return {
    brand_name: 'Acme',
    product_name: 'Whey Protein',
    product_type: 'protein powder',
    flavor: 'chocolate',
    size: '2kg',
    visible_text: ['Acme', 'Whey', 'Chocolate'],
    packaging_colors: 'blue and white',
    distinguishing_features: 'silver lid',
    sku_visible: null,
    barcode_visible: false,
    packaging_version_note: null,
    confidence: 0.8,
    image_quality: 'good',
    multiple_products_detected: false,
    product_count_estimate: 1,
    is_social_media_screenshot: false,
    extraction_notes: null,
    contains_product: true,
    primary_subject_clear: true,
    distinct_product_count: 1,
    all_visible_products_identical: false,
    has_distracting_objects: false,
    ...overrides,
  };
}

describe('deriveVisionCounts', () => {
  it('collapses identical duplicates to a single distinct product', () => {
    const counts = deriveVisionCounts({
      multiple_products_detected: true,
      product_count_estimate: 3,
      all_visible_products_identical: true,
    });
    assert.equal(counts.distinctProductCount, 1);
    assert.equal(counts.allIdentical, true);
    // A single distinct product is, by definition, the clear primary subject.
    assert.equal(counts.primarySubjectClear, true);
  });

  it('keeps distinct count when products genuinely differ', () => {
    const counts = deriveVisionCounts({
      multiple_products_detected: true,
      product_count_estimate: 3,
      distinct_product_count: 3,
      all_visible_products_identical: false,
      primary_subject_clear: false,
    });
    assert.equal(counts.distinctProductCount, 3);
    assert.equal(counts.primarySubjectClear, false);
  });

  it('defaults contains_product to true when the field is absent (backward compatible)', () => {
    const counts = deriveVisionCounts({});
    assert.equal(counts.containsProduct, true);
    assert.equal(counts.distinctProductCount, 1);
  });

  it('treats explicit contains_product=false as no product', () => {
    const counts = deriveVisionCounts({ contains_product: false });
    assert.equal(counts.containsProduct, false);
  });
});

describe('decideVisionMatch', () => {
  it('returns confident_match on a deterministic SKU hit even with weak signals', () => {
    const out = decideVisionMatch({
      extraction: mockExtraction({ confidence: 0.1, image_quality: 'poor' }),
      matchConfidence: 0,
      topSimilarity: 0,
      hasCatalogCandidates: false,
      brandLikelyAbsent: true,
      exactSkuMatch: true,
    });
    assert.equal(out.decision, 'confident_match');
    assert.equal(out.shouldAskClarification, false);
    assert.equal(out.productNotInCatalog, false);
  });

  it('does NOT ask for clarification when multiple IDENTICAL products are present', () => {
    const out = decideVisionMatch({
      extraction: mockExtraction({
        multiple_products_detected: true,
        all_visible_products_identical: true,
        distinct_product_count: 1,
        primary_subject_clear: true,
      }),
      matchConfidence: CONFIDENT_MATCH_FLOOR + 0.1,
      topSimilarity: IMAGE_SIMILARITY_THRESHOLD + 0.1,
      hasCatalogCandidates: true,
      brandLikelyAbsent: false,
      exactSkuMatch: false,
    });
    assert.equal(out.decision, 'confident_match');
    assert.equal(out.shouldAskClarification, false);
  });

  it('asks which one when multiple DISTINCT products and no clear primary', () => {
    const out = decideVisionMatch({
      extraction: mockExtraction({
        multiple_products_detected: true,
        distinct_product_count: 3,
        primary_subject_clear: false,
      }),
      matchConfidence: CONFIDENT_MATCH_FLOOR + 0.2,
      topSimilarity: IMAGE_SIMILARITY_THRESHOLD + 0.1,
      hasCatalogCandidates: true,
      brandLikelyAbsent: false,
      exactSkuMatch: false,
    });
    assert.equal(out.decision, 'clarify_multiple_distinct');
    assert.equal(out.shouldAskClarification, true);
    assert.equal(out.clarificationReason, 'multiple_products_in_image');
  });

  it('does NOT ask when multiple distinct products but one is the clear primary', () => {
    const out = decideVisionMatch({
      extraction: mockExtraction({
        multiple_products_detected: true,
        distinct_product_count: 3,
        primary_subject_clear: true,
      }),
      matchConfidence: CONFIDENT_MATCH_FLOOR + 0.1,
      topSimilarity: IMAGE_SIMILARITY_THRESHOLD + 0.1,
      hasCatalogCandidates: true,
      brandLikelyAbsent: false,
      exactSkuMatch: false,
    });
    assert.equal(out.decision, 'confident_match');
    assert.equal(out.shouldAskClarification, false);
  });

  it('asks for a product photo when the image contains no product', () => {
    const out = decideVisionMatch({
      extraction: mockExtraction({ contains_product: false }),
      matchConfidence: 0,
      topSimilarity: 0,
      hasCatalogCandidates: false,
      brandLikelyAbsent: false,
      exactSkuMatch: false,
    });
    assert.equal(out.decision, 'no_product_detected');
    assert.equal(out.shouldAskClarification, true);
  });

  it('returns tentative_match for strong visual similarity below the confident floor', () => {
    const out = decideVisionMatch({
      extraction: mockExtraction({ confidence: 0.5 }),
      matchConfidence: CONFIDENT_MATCH_FLOOR - 0.1,
      topSimilarity: IMAGE_SIMILARITY_THRESHOLD + 0.05,
      hasCatalogCandidates: true,
      brandLikelyAbsent: false,
      exactSkuMatch: false,
    });
    assert.equal(out.decision, 'tentative_match');
    assert.equal(out.shouldAskClarification, false);
    assert.equal(out.productNotInCatalog, false);
  });

  it('reports not_in_catalog when the brand is read but absent from the catalog', () => {
    const out = decideVisionMatch({
      extraction: mockExtraction({ brand_name: 'UnknownBrand', confidence: 0.7 }),
      matchConfidence: CONFIDENT_MATCH_FLOOR - 0.2,
      topSimilarity: IMAGE_SIMILARITY_THRESHOLD - 0.2,
      hasCatalogCandidates: false,
      brandLikelyAbsent: true,
      exactSkuMatch: false,
    });
    assert.equal(out.decision, 'not_in_catalog');
    assert.equal(out.productNotInCatalog, true);
    assert.equal(out.shouldAskClarification, false);
    assert.equal(out.clarificationReason, 'product_not_in_catalog');
  });

  it('asks for a clearer photo on poor quality with low confidence and no usable match', () => {
    const out = decideVisionMatch({
      extraction: mockExtraction({ image_quality: 'poor', confidence: 0.5, brand_name: null }),
      matchConfidence: 0.2,
      topSimilarity: 0.1,
      hasCatalogCandidates: false,
      brandLikelyAbsent: false,
      exactSkuMatch: false,
    });
    assert.equal(out.decision, 'clarify_quality');
    assert.equal(out.clarificationReason, 'poor_image_quality');
  });

  it('asks for a clearer photo when distracting objects obscure the product', () => {
    const out = decideVisionMatch({
      extraction: mockExtraction({ has_distracting_objects: true, confidence: 0.5, brand_name: null }),
      matchConfidence: 0.2,
      topSimilarity: 0.1,
      hasCatalogCandidates: false,
      brandLikelyAbsent: false,
      exactSkuMatch: false,
    });
    assert.equal(out.decision, 'clarify_quality');
  });

  it('asks for detail when extraction confidence is below the minimum', () => {
    const out = decideVisionMatch({
      extraction: mockExtraction({
        confidence: VISION_EXTRACTION_CONFIDENCE_MIN - 0.1,
        image_quality: 'fair',
        brand_name: null,
      }),
      matchConfidence: 0.2,
      topSimilarity: 0.1,
      hasCatalogCandidates: false,
      brandLikelyAbsent: false,
      exactSkuMatch: false,
    });
    assert.equal(out.decision, 'clarify_low_confidence');
    assert.equal(out.clarificationReason, 'low_extraction_confidence');
  });

  it('falls back to tentative_match when no extraction but candidates exist', () => {
    const out = decideVisionMatch({
      extraction: null,
      matchConfidence: 0.3,
      topSimilarity: 0.3,
      hasCatalogCandidates: true,
      brandLikelyAbsent: false,
      exactSkuMatch: false,
    });
    assert.equal(out.decision, 'tentative_match');
  });

  it('reports not_in_catalog for a readable photo that matched nothing', () => {
    const out = decideVisionMatch({
      extraction: mockExtraction({ confidence: 0.7, image_quality: 'good', brand_name: 'Acme' }),
      matchConfidence: 0.2,
      topSimilarity: 0.1,
      hasCatalogCandidates: false,
      brandLikelyAbsent: false,
      exactSkuMatch: false,
    });
    assert.equal(out.decision, 'not_in_catalog');
    assert.equal(out.productNotInCatalog, true);
  });
});
