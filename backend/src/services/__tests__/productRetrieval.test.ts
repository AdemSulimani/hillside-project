import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '../../db/models/product';
import { extractProductFamilyBaseName } from '../../db/models/product';
import type { Message } from '../../db/models/message';
import {
  buildProductAttributeAggregation,
  detectRequestedAttributes,
  detectProductQueryScope,
  extractConversationProductAnchor,
  getProductStructuredAttributes,
  isCategoryAttributeFollowUp,
  resolveProductsForContextualQuery,
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

// ---------------------------------------------------------------------------
// Helper to build minimal Message stubs for context-resolution tests
// ---------------------------------------------------------------------------
function mockMessage(
  overrides: Partial<Message> & { content: string | null; sent_by: Message['sent_by'] },
): Message {
  return {
    id: Math.random().toString(36).slice(2),
    tenant_id: 't1',
    conversation_id: 'conv1',
    external_message_id: Math.random().toString(36).slice(2),
    direction: overrides.sent_by === 'customer' ? 'inbound' : 'outbound',
    type: 'text',
    attachment_urls: [],
    ai_processed: false,
    quality_score: null,
    flagged: false,
    flag_reason: null,
    send_status: null,
    send_error: null,
    reply_to_message_id: null,
    reply_to_external_id: null,
    reply_to_content: null,
    reply_to_attachment_url: null,
    edited_at: null,
    edit_count: 0,
    original_content: null,
    edit_history: [],
    created_at: new Date(),
    ...overrides,
  } as Message;
}

const creatineProduct = mockProduct({ id: 'p1', name: 'ON Creatine Monohydrate 300g', brand: 'Optimum Nutrition', category: 'Creatine' });

describe('extractConversationProductAnchor', () => {
  it('returns the most recent substantive customer message', () => {
    const history: Message[] = [
      mockMessage({ content: 'Do you have creatine?', sent_by: 'customer' }),
      mockMessage({ content: 'Yes, we have ON Creatine.', sent_by: 'ai' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.equal(anchor, 'Do you have creatine?');
  });

  it('skips short attribute follow-ups and finds the prior product query', () => {
    const history: Message[] = [
      mockMessage({ content: 'Do you have creatine?', sent_by: 'customer' }),
      mockMessage({ content: 'Yes, we have ON Creatine.', sent_by: 'ai' }),
      mockMessage({ content: 'What brand?', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.equal(anchor, 'Do you have creatine?');
  });

  it('skips natural-language attribute follow-ups and finds prior product query', () => {
    const history: Message[] = [
      mockMessage({ content: 'Tell me about your creatine products', sent_by: 'customer' }),
      mockMessage({ content: 'We have ON Creatine 300g by Optimum Nutrition.', sent_by: 'ai' }),
      mockMessage({ content: 'What is the brand of this product?', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.equal(anchor, 'Tell me about your creatine products');
  });

  it('skips context-only price follow-ups and finds prior product query', () => {
    const history: Message[] = [
      mockMessage({ content: 'Keni creatine monohydrate?', sent_by: 'customer' }),
      mockMessage({ content: 'Po, kemi ON Creatine 300g.', sent_by: 'ai' }),
      mockMessage({ content: 'sa kushton?', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.equal(anchor, 'Keni creatine monohydrate?');
  });

  it('skips informal/plural price follow-ups with a trailing deictic ("Sa kushtojn kto")', () => {
    // Regression for the resurfaced multi-turn bug: "Sa kushtojn kto" (how much do
    // these cost) must not become the anchor — the prior weight-gain query should be.
    const history: Message[] = [
      mockMessage({ content: 'A keni ndonje proteina te mira per shtim peshe', sent_by: 'customer' }),
      mockMessage({ content: 'Po, kemi Mass gainer 3kg dhe Mega mass 3kg.', sent_by: 'ai' }),
      mockMessage({ content: 'Sa kushtojn kto', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.equal(anchor, 'A keni ndonje proteina te mira per shtim peshe');
  });

  it('skips plural price follow-up "sa kushtojne keto" and finds prior product query', () => {
    const history: Message[] = [
      mockMessage({ content: 'Keni mass gainer?', sent_by: 'customer' }),
      mockMessage({ content: 'Po, kemi Mass Gainer 3kg.', sent_by: 'ai' }),
      mockMessage({ content: 'sa kushtojne keto?', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.equal(anchor, 'Keni mass gainer?');
  });

  it('falls back to AI texts when no substantive customer message found', () => {
    const history: Message[] = [
      mockMessage({ content: 'We have ON Creatine 300g by Optimum Nutrition.', sent_by: 'ai' }),
      mockMessage({ content: 'What brand?', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.ok(anchor?.includes('ON Creatine'));
  });
});

describe('resolveProductsForContextualQuery — forceAnchorLookup', () => {
  const makeMatcher = (products: Product[]) =>
    async (_tenantId: string, _text: string, _limit: number): Promise<Product[]> => products;

  it('without forceAnchorLookup: returns empty for a natural-language brand question', async () => {
    const history: Message[] = [
      mockMessage({ content: 'Tell me about creatine', sent_by: 'customer' }),
      mockMessage({ content: 'We have ON Creatine 300g.', sent_by: 'ai' }),
    ];
    // "What is the brand of this product?" does not match isCategoryAttributeFollowUp
    // or isContextOnlyFollowUp, so without forceAnchorLookup the function must return [].
    const result = await resolveProductsForContextualQuery(
      't1',
      'What is the brand of this product?',
      history,
      makeMatcher([creatineProduct]),
      10,
      false,
    );
    assert.deepEqual(result, []);
  });

  it('with forceAnchorLookup=true: resolves a natural-language brand question via anchor', async () => {
    const history: Message[] = [
      mockMessage({ content: 'Tell me about creatine', sent_by: 'customer' }),
      mockMessage({ content: 'We have ON Creatine 300g.', sent_by: 'ai' }),
    ];
    const result = await resolveProductsForContextualQuery(
      't1',
      'What is the brand of this product?',
      history,
      makeMatcher([creatineProduct]),
      10,
      true,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'p1');
  });

  it('with forceAnchorLookup=true: resolves a natural-language price question via anchor', async () => {
    const history: Message[] = [
      mockMessage({ content: 'Keni creatine?', sent_by: 'customer' }),
      mockMessage({ content: 'Kemi ON Creatine 300g me çmim 2800 ALL.', sent_by: 'ai' }),
    ];
    const result = await resolveProductsForContextualQuery(
      't1',
      'What is the price of this product?',
      history,
      makeMatcher([creatineProduct]),
      10,
      true,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'p1');
  });

  it('with forceAnchorLookup=true: resolves any product attribute follow-up', async () => {
    const cases = [
      'Can you tell me the brand?',
      'What is the brand of this?',
      'Which category does it belong to?',
      'How much does this cost?',
      'What brand does this belong to?',
    ];
    for (const msg of cases) {
      const history: Message[] = [
        mockMessage({ content: 'Keni creatine?', sent_by: 'customer' }),
        mockMessage({ content: 'Kemi ON Creatine 300g.', sent_by: 'ai' }),
      ];
      const result = await resolveProductsForContextualQuery(
        't1',
        msg,
        history,
        makeMatcher([creatineProduct]),
        10,
        true,
      );
      assert.equal(result.length, 1, `Expected product for message: "${msg}"`);
    }
  });

  it('with forceAnchorLookup=true: falls back to AI texts when anchor search returns empty', async () => {
    const history: Message[] = [
      mockMessage({ content: 'What brand?', sent_by: 'customer' }),
      mockMessage({ content: 'The brand is Optimum Nutrition.', sent_by: 'ai' }),
      mockMessage({ content: 'What is the price?', sent_by: 'customer' }),
    ];
    let callCount = 0;
    const matcher = async (_tenantId: string, text: string, _limit: number): Promise<Product[]> => {
      callCount++;
      // First call (anchor "What brand?") returns empty — anchor has no product keywords.
      // Second call (AI text) returns a product.
      if (callCount === 1) return [];
      return [creatineProduct];
    };
    const result = await resolveProductsForContextualQuery(
      't1',
      'What is the price?',
      history,
      matcher,
      10,
      true,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'p1');
  });

  it('with forceAnchorLookup=true: returns empty when no history and no anchor', async () => {
    const result = await resolveProductsForContextualQuery(
      't1',
      'What is the brand?',
      [],
      makeMatcher([creatineProduct]),
      10,
      true,
    );
    assert.deepEqual(result, []);
  });

  it('default forceAnchorLookup=false still works for short pattern follow-ups', async () => {
    const history: Message[] = [
      mockMessage({ content: 'Keni creatine?', sent_by: 'customer' }),
      mockMessage({ content: 'Kemi ON Creatine 300g.', sent_by: 'ai' }),
    ];
    // "What brand?" matches isCategoryAttributeFollowUp — should work without forceAnchorLookup
    const result = await resolveProductsForContextualQuery(
      't1',
      'What brand?',
      history,
      makeMatcher([creatineProduct]),
      10,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'p1');
  });
});
