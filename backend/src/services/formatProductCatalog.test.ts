import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '../db/models/product';
import { formatProductCatalog, truncateCatalogText } from './productCatalogFormat';

function minimalProduct(overrides: Partial<Product>): Product {
  const now = new Date();
  return {
    id: 'p1',
    tenant_id: 't1',
    name: 'Widget',
    brand: 'Acme',
    price: 9.99,
    discounted_price: null,
    description: null,
    usage_description: null,
    sku: 'SKU1',
    category: 'Cat',
    tags: ['vitamin'],
    image_urls: [],
    is_active: true,
    in_stock: true,
    source_type: 'manual',
    extracted_text: null,
    metadata: null,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('truncateCatalogText', () => {
  it('returns null for empty or non-positive max', () => {
    assert.equal(truncateCatalogText('  ', 10), null);
    assert.equal(truncateCatalogText('hi', 0), null);
  });

  it('returns full string when within limit', () => {
    assert.equal(truncateCatalogText('abc', 10), 'abc');
  });

  it('appends ellipsis when truncated', () => {
    const s = 'abcdefghijklmnopqrstuvwxyz';
    const out = truncateCatalogText(s, 10);
    assert.ok(out && out.endsWith('…'));
    assert.ok(out && out.length <= 10);
  });
});

describe('formatProductCatalog', () => {
  it('omits description line when description is absent', () => {
    const out = formatProductCatalog([minimalProduct({ description: null })], {
      includePrice: false,
      descriptionMaxChars: 100,
      includeFullUsage: false,
      usageMaxChars: 0,
    });
    assert.match(out, /Widget/);
    assert.doesNotMatch(out, /Lorem ipsum/);
  });

  it('truncates long description with ellipsis', () => {
    const long =
      'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore';
    const out = formatProductCatalog(
      [minimalProduct({ description: long })],
      { includePrice: false, descriptionMaxChars: 40, includeFullUsage: false, usageMaxChars: 0 },
    );
    assert.match(out, /…/);
    assert.ok(!out.includes(long), 'full long description should not appear');
  });

  it('omits description when descriptionMaxChars is 0', () => {
    const out = formatProductCatalog(
      [minimalProduct({ description: 'Should not appear' })],
      { includePrice: false, descriptionMaxChars: 0, includeFullUsage: false, usageMaxChars: 0 },
    );
    assert.doesNotMatch(out, /Should not appear/);
  });

  it('omits usage when absent', () => {
    const out = formatProductCatalog([minimalProduct({ usage_description: null })], {
      includePrice: false,
      includeFullUsage: false,
      usageMaxChars: 0,
    });
    assert.doesNotMatch(out, /Usage description/);
  });

  it('includes full usage when includeFullUsage is true', () => {
    const usage =
      'Take one tablet daily with water. Do not exceed. Store in a cool dry place. Full regulatory text here.';
    const out = formatProductCatalog(
      [minimalProduct({ usage_description: usage })],
      { includePrice: false, descriptionMaxChars: 0, includeFullUsage: true },
    );
    assert.match(out, /Usage description:/);
    assert.ok(out.includes('Full regulatory text here.'));
    assert.doesNotMatch(out, /Usage description \(truncated\)/);
  });

  it('omits usage when includeFullUsage is false and usageMaxChars is 0', () => {
    const usage = 'Take one tablet daily with water and food for at least ten weeks.';
    const out = formatProductCatalog(
      [minimalProduct({ usage_description: usage })],
      { includePrice: false, includeFullUsage: false, usageMaxChars: 0 },
    );
    assert.doesNotMatch(out, /Usage description/);
  });

  it('includes truncated usage preview when includeFullUsage is false and usageMaxChars > 0', () => {
    const usage =
      'Take one tablet daily with water. Do not exceed. Store in a cool dry place. Additional long guidance.';
    const out = formatProductCatalog(
      [minimalProduct({ usage_description: usage })],
      { includePrice: false, includeFullUsage: false, usageMaxChars: 48 },
    );
    assert.match(out, /Usage description \(truncated\):/);
    assert.match(out, /…/);
    assert.ok(!out.includes(usage), 'full usage should not appear');
  });

  it('keeps price and stock lines when includePrice is true', () => {
    const out = formatProductCatalog(
      [minimalProduct({ description: 'Short', in_stock: false })],
      { includePrice: true, includeDiscount: false, includeFullUsage: false, usageMaxChars: 0 },
    );
    assert.match(out, /Price: €9\.99/);
    assert.match(out, /out of stock/);
  });
});
