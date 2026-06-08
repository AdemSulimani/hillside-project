import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '../../db/models/product';
import {
  disambiguateVariants,
  extractSelectionAttributes,
} from '../orderProductResolutionService';

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

describe('extractSelectionAttributes', () => {
  it('captures number + unit signatures', () => {
    const attrs = extractSelectionAttributes('Can I order the 50 servings one?');
    assert.deepEqual(attrs.sizeSignatures, ['50serving']);
  });

  it('normalises unit synonyms and spacing', () => {
    assert.deepEqual(extractSelectionAttributes('2kg please').sizeSignatures, ['2kg']);
    assert.deepEqual(extractSelectionAttributes('500 g').sizeSignatures, ['500g']);
    assert.deepEqual(extractSelectionAttributes('60 serving').sizeSignatures, ['60serving']);
  });

  it('records bare numbers separately from unit-bound numbers', () => {
    const attrs = extractSelectionAttributes('the 50 one');
    assert.deepEqual(attrs.sizeSignatures, []);
    assert.deepEqual(attrs.bareNumbers, ['50']);
  });

  it('detects flavors and colors', () => {
    const attrs = extractSelectionAttributes('the chocolate black one');
    assert.deepEqual(attrs.flavors, ['chocolate']);
    assert.deepEqual(attrs.colors, ['black']);
  });
});

describe('disambiguateVariants — the reported Creatine 50 vs 60 bug', () => {
  const creatine50 = mockProduct({ id: '50', name: 'Creatine 50 Servings' });
  const creatine60 = mockProduct({ id: '60', name: 'Creatine 60 Servings' });

  it('selects the 50-serving variant the customer asked for', () => {
    const res = disambiguateVariants(
      [creatine60, creatine50],
      'Can I order the 50 servings one?',
      'Creatine 60 Servings', // intent LLM picked the WRONG variant
    );
    assert.equal(res.product?.id, '50');
    assert.equal(res.reason, 'size_match');
    assert.equal(res.ambiguous, false);
  });

  it('overrides a wrong intent_exact match using the customer wording', () => {
    // Intent says "Creatine 60 Servings" (an exact catalog name) but customer said 50.
    const res = disambiguateVariants(
      [creatine50, creatine60],
      'i want the 50 servings creatine',
      'Creatine 60 Servings',
    );
    assert.equal(res.product?.id, '50');
  });

  it('matches via bare number when the customer omits the unit', () => {
    const res = disambiguateVariants([creatine50, creatine60], 'the 60 one', 'Creatine');
    assert.equal(res.product?.id, '60');
    assert.equal(res.reason, 'bare_number_match');
  });

  it('reports ambiguous when the customer gives no distinguishing attribute', () => {
    const res = disambiguateVariants([creatine50, creatine60], 'yes please', 'Creatine');
    assert.equal(res.product, null);
    assert.equal(res.ambiguous, true);
    assert.equal(res.reason, 'ambiguous');
  });

  it('falls back to intent exact name when no customer attribute is present', () => {
    const res = disambiguateVariants(
      [creatine50, creatine60],
      'yes please',
      'Creatine 60 Servings',
    );
    assert.equal(res.product?.id, '60');
    assert.equal(res.reason, 'intent_exact');
  });
});

describe('disambiguateVariants — general behaviour', () => {
  it('returns the single candidate unchanged (non-variant products)', () => {
    const only = mockProduct({ id: '1', name: 'Whey Protein 2kg' });
    const res = disambiguateVariants([only], 'i want it', 'Whey Protein 2kg');
    assert.equal(res.product?.id, '1');
    assert.equal(res.reason, 'unique');
  });

  it('reports no_candidates for an empty set', () => {
    const res = disambiguateVariants([], 'anything', 'Nope');
    assert.equal(res.product, null);
    assert.equal(res.reason, 'no_candidates');
  });

  it('disambiguates flavor variants', () => {
    const choc = mockProduct({ id: 'c', name: 'Mass Gainer Chocolate 2kg', flavor: 'Chocolate' });
    const van = mockProduct({ id: 'v', name: 'Mass Gainer Vanilla 2kg', flavor: 'Vanilla' });
    const res = disambiguateVariants([choc, van], 'the vanilla one please', 'Mass Gainer');
    assert.equal(res.product?.id, 'v');
    assert.equal(res.reason, 'flavor_match');
  });

  it('uses the structured size column when the name lacks the attribute', () => {
    const small = mockProduct({ id: 's', name: 'Pre-Workout', size: '30 servings' });
    const large = mockProduct({ id: 'l', name: 'Pre-Workout', size: '60 servings' });
    const res = disambiguateVariants([small, large], 'the 30 servings please', 'Pre-Workout');
    assert.equal(res.product?.id, 's');
    assert.equal(res.reason, 'size_match');
  });
});
