/**
 * Tests for the vocabulary-independent attribute-availability helpers.
 *
 * Covers the prompt-building, response-parsing, and cache-key logic in
 * productAttributeAvailabilityHelpers.ts — entirely in-process with no OpenAI calls.
 *
 * Key invariants verified:
 *  - parseSpecifiedAttributes accepts valid attribute keys the classifier confirms.
 *  - It rejects keys not in the requested set (model cannot widen the decision).
 *  - It rejects invalid/unknown keys.
 *  - It returns empty on malformed JSON and on empty "specified" arrays.
 *  - buildProductAvailabilityBlock includes name, description, extracted text (capped),
 *    structured fields, and tags — all sources the classifier reads from.
 *  - buildAvailabilityCacheKey is stable and changes when products or keys change.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '../../db/models/product';
import {
  buildAvailabilityCacheKey,
  buildProductAvailabilityBlock,
  MAX_EXTRACTED_TEXT_CHARS,
  parseSpecifiedAttributes,
} from '../productAttributeAvailabilityHelpers';

function mockProduct(overrides: Partial<Product> & Pick<Product, 'id' | 'name'>): Product {
  return {
    tenant_id: 't1',
    brand: null,
    price: 10,
    discounted_price: null,
    description: null,
    usage_description: null,
    sku: null,
    category: null,
    tags: [],
    flavor: null,
    size: null,
    color: null,
    variant: null,
    weight: null,
    image_urls: [],
    is_active: true,
    in_stock: true,
    source_type: 'manual',
    extracted_text: null,
    metadata: null,
    deleted_at: null,
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...overrides,
  } as Product;
}

// ---------------------------------------------------------------------------
// parseSpecifiedAttributes
// ---------------------------------------------------------------------------

describe('parseSpecifiedAttributes', () => {
  it('returns the confirmed keys present in the model response', () => {
    const raw = JSON.stringify({ specified: ['flavor', 'brand'] });
    const result = parseSpecifiedAttributes(raw, ['flavor', 'brand', 'weight']);
    assert.ok(result.has('flavor'));
    assert.ok(result.has('brand'));
    assert.ok(!result.has('weight'));
  });

  it('ignores a key not in the requested set (model cannot widen the decision)', () => {
    const raw = JSON.stringify({ specified: ['color', 'weight'] });
    const result = parseSpecifiedAttributes(raw, ['flavor']);
    assert.equal(result.size, 0);
  });

  it('ignores invalid/unknown keys', () => {
    const raw = JSON.stringify({ specified: ['price', 'hallucinated_key', 'flavor'] });
    const result = parseSpecifiedAttributes(raw, ['flavor']);
    assert.ok(result.has('flavor'));
    assert.equal(result.size, 1);
  });

  it('returns empty set on malformed JSON', () => {
    assert.equal(parseSpecifiedAttributes('NOT JSON', ['flavor']).size, 0);
  });

  it('returns empty set when "specified" is missing', () => {
    assert.equal(parseSpecifiedAttributes(JSON.stringify({ other: 'value' }), ['flavor']).size, 0);
  });

  it('returns empty set when "specified" is an empty array', () => {
    assert.equal(parseSpecifiedAttributes(JSON.stringify({ specified: [] }), ['flavor']).size, 0);
  });

  it('normalizes key casing (model may return "Flavor" instead of "flavor")', () => {
    const raw = JSON.stringify({ specified: ['Flavor', 'BRAND'] });
    const result = parseSpecifiedAttributes(raw, ['flavor', 'brand']);
    assert.ok(result.has('flavor'));
    assert.ok(result.has('brand'));
  });

  it('handles a non-array "specified" value gracefully', () => {
    const raw = JSON.stringify({ specified: 'flavor' });
    assert.equal(parseSpecifiedAttributes(raw, ['flavor']).size, 0);
  });
});

// ---------------------------------------------------------------------------
// buildProductAvailabilityBlock — covers all product text sources the classifier uses
// ---------------------------------------------------------------------------

describe('buildProductAvailabilityBlock', () => {
  it('includes the product name', () => {
    const p = mockProduct({ id: 'p1', name: 'Carbo One Tiramisu 1kg' });
    const block = buildProductAvailabilityBlock(p, 0);
    assert.ok(block.includes('Carbo One Tiramisu 1kg'));
  });

  it('includes brand and category when present', () => {
    const p = mockProduct({ id: 'p2', name: 'X', brand: 'Acme', category: 'Protein' });
    const block = buildProductAvailabilityBlock(p, 0);
    assert.ok(block.includes('Acme'));
    assert.ok(block.includes('Protein'));
  });

  it('includes non-null structured fields (flavor, color, size, weight)', () => {
    const p = mockProduct({
      id: 'p3',
      name: 'Gainer',
      flavor: 'Mango',
      color: null,
      size: '5kg',
    });
    const block = buildProductAvailabilityBlock(p, 0);
    assert.ok(block.includes('flavor=Mango'));
    assert.ok(block.includes('size=5kg'));
    assert.ok(!block.includes('color=')); // null — must not be included
  });

  it('includes description text', () => {
    const p = mockProduct({
      id: 'p4',
      name: 'Protein',
      description: 'Available in Tiramisu and Coconut variants.',
    });
    const block = buildProductAvailabilityBlock(p, 0);
    assert.ok(block.includes('Tiramisu'));
    assert.ok(block.includes('Coconut'));
  });

  it('caps extracted_text at MAX_EXTRACTED_TEXT_CHARS', () => {
    const longText = 'X'.repeat(MAX_EXTRACTED_TEXT_CHARS + 200);
    const p = mockProduct({ id: 'p5', name: 'P', extracted_text: longText });
    const block = buildProductAvailabilityBlock(p, 0);
    // The capped extracted text should appear in the block, but no more than the cap.
    const marker = 'packaging/extracted text:';
    const idx = block.indexOf(marker);
    assert.ok(idx !== -1);
    const afterMarker = block.slice(idx + marker.length);
    assert.ok(afterMarker.length <= MAX_EXTRACTED_TEXT_CHARS + 50); // small formatting overhead
  });

  it('includes tags', () => {
    const p = mockProduct({ id: 'p6', name: 'P', tags: ['sugar-free', 'vegan'] });
    const block = buildProductAvailabilityBlock(p, 0);
    assert.ok(block.includes('sugar-free'));
    assert.ok(block.includes('vegan'));
  });

  it('uses the 1-based index in the product header', () => {
    const p = mockProduct({ id: 'p7', name: 'P' });
    assert.ok(buildProductAvailabilityBlock(p, 2).startsWith('Product 3:'));
  });
});

// ---------------------------------------------------------------------------
// buildAvailabilityCacheKey — stability and invalidation
// ---------------------------------------------------------------------------

describe('buildAvailabilityCacheKey', () => {
  const base = [mockProduct({ id: 'p1', name: 'A', updated_at: new Date('2024-01-01') })];

  it('produces the same key for the same inputs', () => {
    const k1 = buildAvailabilityCacheKey(['flavor'], base);
    const k2 = buildAvailabilityCacheKey(['flavor'], base);
    assert.equal(k1, k2);
  });

  it('key is order-independent for requested keys', () => {
    const k1 = buildAvailabilityCacheKey(['flavor', 'brand'], base);
    const k2 = buildAvailabilityCacheKey(['brand', 'flavor'], base);
    assert.equal(k1, k2);
  });

  it('key changes when the product updated_at changes (edit invalidates cache)', () => {
    const edited = [mockProduct({ id: 'p1', name: 'A', updated_at: new Date('2024-01-02') })];
    assert.notEqual(
      buildAvailabilityCacheKey(['flavor'], base),
      buildAvailabilityCacheKey(['flavor'], edited),
    );
  });

  it('key changes when requested keys change', () => {
    assert.notEqual(
      buildAvailabilityCacheKey(['flavor'], base),
      buildAvailabilityCacheKey(['flavor', 'color'], base),
    );
  });

  it('key changes for different products', () => {
    const other = [mockProduct({ id: 'p99', name: 'B', updated_at: new Date('2024-01-01') })];
    assert.notEqual(
      buildAvailabilityCacheKey(['flavor'], base),
      buildAvailabilityCacheKey(['flavor'], other),
    );
  });
});
