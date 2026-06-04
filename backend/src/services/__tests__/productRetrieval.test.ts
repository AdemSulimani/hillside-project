import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '../../db/models/product';
import { extractProductFamilyBaseName } from '../../db/models/product';
import {
  buildProductAttributeAggregation,
  detectRequestedAttributes,
  detectProductQueryScope,
  getProductStructuredAttributes,
  isCategoryAttributeFollowUp,
} from '../productRetrievalService';

function mockProduct(overrides: Partial<Product> & Pick<Product, 'id' | 'name'>): Product {
  return {
    tenant_id: 't1',
    brand: 'BrandX',
    price: 10,
    discounted_price: null,
    description: null,
    usage_description: null,
    sku: null,
    category: 'Supplements',
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
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as Product;
}

describe('productRetrievalService', () => {
  it('isCategoryAttributeFollowUp matches tell-me phrasing', () => {
    assert.equal(isCategoryAttributeFollowUp('tell me the flavors'), true);
  });

  it('detectRequestedAttributes ignores non-catalog topics like ingredients', () => {
    const attrs = detectRequestedAttributes('What are the ingredients and specs?');
    assert.equal(attrs.length, 0);
  });

  it('detectRequestedAttributes merges intent attributes from classifier', () => {
    const attrs = detectRequestedAttributes('tell me more', ['flavor']);
    assert.deepEqual(attrs, ['flavor']);
  });

  it('buildProductAttributeAggregation lists flavors across SKUs', () => {
    const products = [
      mockProduct({ id: '1', name: 'Mass Gainer Chocolate 2kg', flavor: 'Chocolate' }),
      mockProduct({ id: '2', name: 'Mass Gainer Vanilla 2kg', flavor: 'Vanilla' }),
    ];
    const block = buildProductAttributeAggregation(products, 'What flavors?');
    assert.ok(block);
    assert.match(block!, /Chocolate/);
    assert.match(block!, /Vanilla/);
    assert.match(block!, /Flavors across 2/);
  });

  it('buildProductAttributeAggregation returns group hint when attrs missing', () => {
    const products = [
      mockProduct({ id: '1', name: 'Mystery Product A' }),
      mockProduct({ id: '2', name: 'Mystery Product B' }),
    ];
    const block = buildProductAttributeAggregation(products, 'What flavors?');
    assert.ok(block);
    assert.match(block!, /2 matching products/);
  });

  it('detectProductQueryScope uses attribute intent hint', () => {
    const products = [mockProduct({ id: '1', name: 'A' }), mockProduct({ id: '2', name: 'B' })];
    const scope = detectProductQueryScope('hello', products, { is_attribute_question: true });
    assert.equal(scope, 'attribute_followup');
  });

  it('getProductStructuredAttributes includes category as product type', () => {
    const attrs = getProductStructuredAttributes(
      mockProduct({ id: '1', name: 'Whey', category: 'Protein' }),
    );
    assert.equal(attrs.category, 'Protein');
  });

  it('extractProductFamilyBaseName strips flavor and size tokens', () => {
    const base = extractProductFamilyBaseName('Mass Gainer Pro Chocolate 2kg');
    assert.ok(!/chocolate/i.test(base));
    assert.ok(!/2kg/i.test(base));
    assert.match(base, /Mass Gainer/i);
  });

  it('infers flavor from product name when DB column empty', () => {
    const products = [
      mockProduct({ id: '1', name: 'Whey Isolate Vanilla 1kg' }),
      mockProduct({ id: '2', name: 'Whey Isolate Chocolate 1kg' }),
    ];
    const block = buildProductAttributeAggregation(products, 'flavors?');
    assert.ok(block);
    assert.match(block!, /vanilla/i);
    assert.match(block!, /chocolate/i);
  });
});
