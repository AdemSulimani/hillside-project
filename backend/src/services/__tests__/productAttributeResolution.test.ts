import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveProductAttributes,
  usableImageDerivedAttributes,
  buildImageDerivedBlockForProduct,
  looksNumeric,
  ATTR_ANSWER_CONFIDENCE_MIN,
  ATTR_NUMERIC_CONFIDENCE_MIN,
  type FingerprintInput,
  type StructuredAttributeInput,
} from '../productAttributeResolution';
import type { VisualFingerprintData } from '../../db/models/productImageFingerprint';

function fp(
  json: Partial<VisualFingerprintData>,
  version = 2,
): FingerprintInput {
  return { fingerprint_json: json, fingerprint_version: version };
}

const emptyStructured: StructuredAttributeInput = {};

describe('looksNumeric', () => {
  it('treats values containing digits as numeric', () => {
    assert.equal(looksNumeric('60 servings'), true);
    assert.equal(looksNumeric('2.27kg'), true);
    assert.equal(looksNumeric('Chocolate'), false);
    assert.equal(looksNumeric('Optimum Nutrition'), false);
  });
});

describe('resolveProductAttributes — catalog precedence', () => {
  it('always prefers a non-empty structured catalog value over the image', () => {
    const resolved = resolveProductAttributes(
      { brand: 'Catalog Brand' },
      [fp({ brand_name: 'Image Brand', attribute_confidence: { brand_name: 0.99 } })],
    );
    const brand = resolved.get('brand');
    assert.equal(brand?.value, 'Catalog Brand');
    assert.equal(brand?.source, 'catalog');
    assert.equal(brand?.confidence, 1);
    assert.equal(brand?.usable, true);
  });
});

describe('resolveProductAttributes — image fallback when catalog empty', () => {
  it('uses a high-confidence image brand when catalog brand is empty (Problem #2, scenario 1)', () => {
    const resolved = resolveProductAttributes(
      emptyStructured,
      [fp({ brand_name: 'Optimum Nutrition', attribute_confidence: { brand_name: 0.95 } })],
    );
    const brand = resolved.get('brand');
    assert.equal(brand?.value, 'Optimum Nutrition');
    assert.equal(brand?.source, 'image');
    assert.equal(brand?.usable, true);
  });

  it('uses a high-confidence image flavor when catalog flavor is empty (scenario 2)', () => {
    const resolved = resolveProductAttributes(
      emptyStructured,
      [fp({ flavor: 'Chocolate', attribute_confidence: { flavor: 0.9 } })],
    );
    assert.equal(resolved.get('flavor')?.usable, true);
    assert.equal(resolved.get('flavor')?.value, 'Chocolate');
  });

  it('requires the higher numeric threshold for servings (scenario 3)', () => {
    const justBelow = ATTR_NUMERIC_CONFIDENCE_MIN - 0.05;
    const justAbove = ATTR_NUMERIC_CONFIDENCE_MIN + 0.01;

    const low = resolveProductAttributes(
      emptyStructured,
      [fp({ servings: '60 servings', attribute_confidence: { servings: justBelow } })],
    );
    assert.equal(low.get('servings')?.usable, false, 'numeric value below numeric threshold must not be usable');

    const high = resolveProductAttributes(
      emptyStructured,
      [fp({ servings: '60 servings', attribute_confidence: { servings: justAbove } })],
    );
    assert.equal(high.get('servings')?.usable, true);
  });

  it('resolves arbitrary attributes from the generic attributes map', () => {
    const resolved = resolveProductAttributes(
      emptyStructured,
      [
        fp({
          attributes: { 'protein per serving': '24g', warnings: 'keep out of reach of children' },
          attribute_confidence: { 'protein per serving': 0.92, warnings: 0.95 },
        }),
      ],
    );
    // "24g" is numeric → needs the numeric threshold (0.92 >= 0.85 ok).
    assert.equal(resolved.get('protein per serving')?.usable, true);
    // free text warning → non-numeric threshold.
    assert.equal(resolved.get('warnings')?.usable, true);
  });
});

describe('resolveProductAttributes — confidence gating', () => {
  it('marks a non-numeric value below the answer threshold as not usable', () => {
    const resolved = resolveProductAttributes(
      emptyStructured,
      [fp({ brand_name: 'Blurry Brand', attribute_confidence: { brand_name: ATTR_ANSWER_CONFIDENCE_MIN - 0.1 } })],
    );
    assert.equal(resolved.get('brand')?.usable, false);
  });

  it('treats legacy fingerprints without per-attribute confidence as not usable (default below threshold)', () => {
    const resolved = resolveProductAttributes(
      emptyStructured,
      [fp({ brand_name: 'Legacy Brand' }, 1)], // no attribute_confidence
    );
    const brand = resolved.get('brand');
    assert.equal(brand?.source, 'image');
    assert.equal(brand?.usable, false);
  });
});

describe('resolveProductAttributes — conflict resolution across images', () => {
  it('marks an attribute conflicted when two images disagree at comparable confidence', () => {
    const resolved = resolveProductAttributes(emptyStructured, [
      fp({ flavor: 'Chocolate', attribute_confidence: { flavor: 0.9 } }),
      fp({ flavor: 'Vanilla', attribute_confidence: { flavor: 0.88 } }),
    ]);
    const flavor = resolved.get('flavor');
    assert.equal(flavor?.conflicted, true);
    assert.equal(flavor?.usable, false, 'conflicted attribute must never be used to answer');
  });

  it('does NOT conflict when one image is clearly more confident than the other', () => {
    const resolved = resolveProductAttributes(emptyStructured, [
      fp({ flavor: 'Chocolate', attribute_confidence: { flavor: 0.95 } }),
      fp({ flavor: 'Vanilla', attribute_confidence: { flavor: 0.4 } }),
    ]);
    const flavor = resolved.get('flavor');
    assert.equal(flavor?.conflicted, false);
    assert.equal(flavor?.value, 'Chocolate');
    assert.equal(flavor?.usable, true);
  });

  it('does NOT conflict when both images agree on the same value', () => {
    const resolved = resolveProductAttributes(emptyStructured, [
      fp({ brand_name: 'Acme', attribute_confidence: { brand_name: 0.9 } }),
      fp({ brand_name: 'acme', attribute_confidence: { brand_name: 0.88 } }),
    ]);
    assert.equal(resolved.get('brand')?.conflicted, false);
    assert.equal(resolved.get('brand')?.usable, true);
  });
});

describe('usableImageDerivedAttributes + buildImageDerivedBlockForProduct', () => {
  it('returns only usable image-derived attributes', () => {
    const resolved = resolveProductAttributes(
      { brand: 'Catalog Brand' },
      [
        fp({
          brand_name: 'Image Brand',
          flavor: 'Chocolate',
          attribute_confidence: { brand_name: 0.99, flavor: 0.9 },
        }),
      ],
    );
    const usable = usableImageDerivedAttributes(resolved);
    // brand came from catalog (excluded), flavor from image (included)
    assert.deepEqual(
      usable.map((a) => a.key).sort(),
      ['flavor'],
    );
  });

  it('builds a provenance-labeled block including a confidence note', () => {
    const block = buildImageDerivedBlockForProduct(
      'Whey Protein 2kg',
      emptyStructured,
      [fp({ brand_name: 'Optimum Nutrition', attribute_confidence: { brand_name: 0.95 } })],
    );
    assert.ok(block.text);
    assert.match(block.text as string, /Optimum Nutrition/);
    assert.match(block.text as string, /read from image/);
    assert.equal(block.usable.length, 1);
  });

  it('returns null text when nothing trustworthy and no visible text exists', () => {
    const block = buildImageDerivedBlockForProduct(
      'Mystery Product',
      emptyStructured,
      [fp({ brand_name: 'Blurry', attribute_confidence: { brand_name: 0.2 } })],
      { includeVisibleText: false },
    );
    assert.equal(block.text, null);
    assert.equal(block.usable.length, 0);
  });

  it('surfaces raw visible label text as a generic fallback even without high-confidence fields', () => {
    const block = buildImageDerivedBlockForProduct(
      'Mystery Product',
      emptyStructured,
      [fp({ visible_text: ['Gluten Free', 'Made in USA'], attribute_confidence: {} })],
    );
    assert.ok(block.text);
    assert.match(block.text as string, /Gluten Free/);
  });
});
