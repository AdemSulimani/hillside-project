/**
 * P1-A — attribute backfill pure helpers.
 *
 * The load-bearing invariant: an LLM-extracted value can reach the catalog ONLY when it (or a
 * known dialect variant) occupies whole-token positions in the product's OWN text — extractor
 * hallucination is structurally impossible, the write-time twin of the P1-B membership check.
 *
 * No OpenAI import: `extractAttributesBatch` defers its client import, so this suite stays
 * import-safe without an API key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '../../db/models/product';
import {
  buildBackfillUserPrompt,
  mergeBackfillValues,
  parseBackfillResponse,
  productOwnText,
  verifyExtractedValue,
} from '../attributeBackfillService';

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

describe('verifyExtractedValue (verbatim-membership guard)', () => {
  it('accepts a value present verbatim in the product name', () => {
    const p = mockProduct({ id: 'p1', name: 'Carbo one 1kg Limon' });
    assert.equal(verifyExtractedValue('Limon', p), true);
    assert.equal(verifyExtractedValue('1kg', p), true);
  });

  it('accepts a value present in the description only', () => {
    const p = mockProduct({
      id: 'p2',
      name: 'Carbo one 1kg Limon',
      description: 'Efekti i real pharm carbo one 1000g …',
    });
    assert.equal(verifyExtractedValue('Real Pharm', p), true);
  });

  it('rejects a value absent from the product own text — extractor hallucination', () => {
    const p = mockProduct({ id: 'p3', name: 'BSN Creatine 216gr', description: 'Pluhur kreatine pa aromë.' });
    assert.equal(verifyExtractedValue('Qershi', p), false);
  });

  it('accepts a dialect variant (çokollatë declared, name says Qokolad)', () => {
    const p = mockProduct({ id: 'p4', name: 'Take a Whey 1kg Qokolad' });
    assert.equal(verifyExtractedValue('çokollatë', p), true);
  });

  it('never reads extracted_text', () => {
    const p = mockProduct({
      id: 'p5',
      name: 'BSN Creatine 216gr',
      extracted_text: 'shared blob mentioning Qershi and Limon and Mango',
    });
    assert.equal(verifyExtractedValue('Qershi', p), false);
    assert.equal(productOwnText(p).includes('Qershi'), false);
  });

  it('rejects empty and unfoldable values', () => {
    const p = mockProduct({ id: 'p6', name: 'X Product' });
    assert.equal(verifyExtractedValue('', p), false);
    assert.equal(verifyExtractedValue('   ', p), false);
  });
});

describe('mergeBackfillValues', () => {
  it('never overwrites an existing column value', () => {
    const p = mockProduct({ id: 'm1', name: 'Gainer Vanilla 2kg', flavor: 'Strawberry' });
    const proposal = mergeBackfillValues(p, { flavor: 'Vanilla' });
    assert.equal('flavor' in proposal.updates, false);
  });

  it('prefers the deterministic regex value over the LLM value', () => {
    const p = mockProduct({ id: 'm2', name: 'Carbo one 1kg Limon' });
    const proposal = mergeBackfillValues(p, { flavor: 'Limon i freskët' });
    assert.equal(proposal.updates.flavor, 'Limon');
    assert.equal(proposal.fields.flavor, 'regex');
  });

  it('accepts a verified LLM value the regex vocabulary cannot know (Tiramisu)', () => {
    const p = mockProduct({ id: 'm3', name: 'Gold whey 500gr Tiramisu' });
    const proposal = mergeBackfillValues(p, { flavor: 'Tiramisu' });
    assert.equal(proposal.updates.flavor, 'Tiramisu');
    assert.equal(proposal.fields.flavor, 'llm');
  });

  it('the extended regex vocabulary covers the real catalog forms (Dredhz, Vanil, Mjedre, Qershis)', () => {
    for (const [name, expected] of [
      ['Gold whey 500gr Dredhz', 'Dredhz'],
      ['Whey protein 700gr Vanil', 'Vanil'],
      ['Applied Nutrition Creatine 250gr shije Mjedre', 'Mjedre'],
      ['Creatine 300g shije Qershis', 'Qershis'],
      ['Isotonic 1kg shije Portokalli', 'Portokalli'],
      ['X-Mass 3kg shije Keksi', 'Keksi'],
    ] as const) {
      const proposal = mergeBackfillValues(mockProduct({ id: `v-${expected}`, name }), {});
      assert.equal(proposal.updates.flavor, expected, name);
      assert.equal(proposal.fields.flavor, 'regex', name);
    }
  });

  it('routes an unverifiable LLM value to rejected, never to updates', () => {
    const p = mockProduct({ id: 'm4', name: 'BSN Creatine 216gr' });
    const proposal = mergeBackfillValues(p, { flavor: 'Qershi' });
    assert.equal('flavor' in proposal.updates, false);
    assert.equal(proposal.rejected.flavor, 'Qershi');
  });

  it('extracts sizes with catalog unit spellings (216gr) via the regex pass', () => {
    const p = mockProduct({ id: 'm5', name: 'BSN Creatine 216gr' });
    const proposal = mergeBackfillValues(p, {});
    assert.equal(proposal.updates.size, '216gr');
    assert.equal(proposal.updates.weight, '216gr');
  });

  it('proposes nothing for a non-supplement item with no attribute text', () => {
    const p = mockProduct({ id: 'm6', name: 'Qant per garderob' });
    const proposal = mergeBackfillValues(p, {});
    assert.deepEqual(proposal.updates, {});
  });

  it('brand comes only from the LLM pass (no regex vocabulary) and is verified', () => {
    const p = mockProduct({
      id: 'm7',
      name: 'Carbo one 1kg Limon',
      description: 'Efekti i real pharm carbo one 1000g.',
    });
    const proposal = mergeBackfillValues(p, { brand: 'Real Pharm' });
    assert.equal(proposal.updates.brand, 'Real Pharm');
    assert.equal(proposal.fields.brand, 'llm');
  });
});

describe('buildBackfillUserPrompt / parseBackfillResponse', () => {
  it('numbers products 1..N and includes only present fields', () => {
    const prompt = buildBackfillUserPrompt([
      mockProduct({ id: 'b1', name: 'A', description: 'desc A' }),
      mockProduct({ id: 'b2', name: 'B', tags: ['tag1'] }),
    ]);
    assert.match(prompt, /Product 1:\n {2}name: A\n {2}description: desc A/);
    assert.match(prompt, /Product 2:\n {2}name: B\n {2}tags: tag1/);
    assert.doesNotMatch(prompt, /Product 1:[\s\S]*?usage:/);
  });

  it('parses an index-aligned response and drops invalid entries', () => {
    const raw = JSON.stringify({
      products: [
        { index: 1, flavor: 'Limon', junk: 'x' },
        { index: 2, size: ' 1kg ' },
        { index: 99, flavor: 'out-of-range' },
        { flavor: 'no-index' },
        'not-an-object',
      ],
    });
    const parsed = parseBackfillResponse(raw, 2);
    assert.deepEqual(parsed, [{ flavor: 'Limon' }, { size: '1kg' }]);
  });

  it('returns empty maps on malformed JSON', () => {
    assert.deepEqual(parseBackfillResponse('NOT JSON', 2), [{}, {}]);
  });
});
