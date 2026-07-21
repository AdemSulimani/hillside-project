import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '../../db/models/product';
import { extractProductFamilyBaseName } from '../../db/models/product';
import type { Message } from '../../db/models/message';
import {
  ALL_STRUCTURED_ATTRIBUTE_KEYS,
  buildProductAttributeAggregation,
  detectRequestedAttributes,
  detectProductQueryScope,
  extractConversationProductAnchor,
  getProductInferredAttributes,
  getProductStructuredAttributes,
  isCategoryAttributeFollowUp,
  isOtherOptionsFollowUp,
  resolveProductsForContextualQuery,
  sanitizeExtractedText,
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

  // Recall: Albanian definite/plural/case inflections and English plurals must be detected
  // deterministically, so a genuinely-requested attribute never has to rely on the
  // stochastic LLM label. `\bshije\b` previously missed "shijen"/"shijes"/"shijet".
  it('detectRequestedAttributes detects Albanian inflected + English plural attribute words', () => {
    assert.deepEqual(detectRequestedAttributes('cfare shije ka'), ['flavor']);
    assert.deepEqual(detectRequestedAttributes('me trego shijen'), ['flavor']);
    assert.deepEqual(detectRequestedAttributes('cilat jane shijet'), ['flavor']);
    assert.deepEqual(detectRequestedAttributes('what flavors do you carry'), ['flavor']);
    assert.deepEqual(detectRequestedAttributes('cila eshte marka'), ['brand']);
    assert.deepEqual(detectRequestedAttributes('cilat jane markat'), ['brand']);
    assert.deepEqual(detectRequestedAttributes('me trego markën'), ['brand']);
    // Bare indefinite ablative — the standard "what brand?" phrasing. Missed by the first
    // inflection pass (`mark(?:a…|en|es)` had no bare `marke`), which silently under-reported a
    // genuinely-requested brand: the deterministic net emitted nothing and the sanitizer
    // (correctly) stripped the LLM's structured label, so no notice named brand at all.
    assert.deepEqual(detectRequestedAttributes('cfare marke eshte'), ['brand']);
    assert.deepEqual(detectRequestedAttributes('çfarë marke është ky produkt'), ['brand']);
    assert.deepEqual(detectRequestedAttributes('what colours are available'), ['color']);
    assert.deepEqual(detectRequestedAttributes('cfare ngjyrash ka'), ['color']);
    assert.deepEqual(detectRequestedAttributes('sa eshte pesha'), ['weight']);
    assert.deepEqual(detectRequestedAttributes('me trego peshën'), ['weight']);
    assert.deepEqual(detectRequestedAttributes('sa eshte madhesia'), ['size']);
  });

  // False-positive guardrails: the inflection suffixes must not swallow unrelated words —
  // "shijshëm" (tasty) is not a flavor request, and "market"/"marketing" is not a brand
  // request.
  it('detectRequestedAttributes does not false-match tasty/market lookalikes', () => {
    assert.deepEqual(detectRequestedAttributes('a eshte i shijshem'), []);
    assert.deepEqual(detectRequestedAttributes('do you sell it on the market'), []);
    assert.deepEqual(detectRequestedAttributes('what is your marketing about'), []);
  });

  // The category-follow-up all-keys expansion is correct for aggregation but must be
  // opt-OUTable so the missing-attribute gate never flags every NULL column on a bare
  // browse question.
  it('detectRequestedAttributes expands a bare category follow-up to all keys by default, but not when opted out', () => {
    const expanded = detectRequestedAttributes('what options do you have?');
    assert.deepEqual([...expanded].sort(), [...ALL_STRUCTURED_ATTRIBUTE_KEYS].sort());
    const scoped = detectRequestedAttributes('what options do you have?', undefined, {
      expandCategoryFollowUp: false,
    });
    assert.deepEqual(scoped, []);
    // A follow-up that DOES name a specific attribute still returns just that attribute
    // (unaffected by the opt-out, since the expansion only fires when nothing matched).
    assert.deepEqual(
      detectRequestedAttributes('what flavors do you have?', undefined, {
        expandCategoryFollowUp: false,
      }),
      ['flavor'],
    );
  });

  // Layer 1 (root cause for the "we'll notify you about the flavor" contradiction):
  // an attribute present only in the product NAME / description / extracted text / tags
  // must be reported as AVAILABLE so the deterministic missing-attribute net never
  // contradicts an answer that already stated the value.
  describe('getProductInferredAttributes (text-aware availability)', () => {
    it('reads a flavor embedded in the product name when the column is empty', () => {
      const product = mockProduct({
        id: 'c1',
        name: 'Carbo One 1kg me shije limon',
        flavor: null,
      });
      assert.equal(getProductInferredAttributes(product).flavor, 'limon');
    });

    it('reads a flavor from the description when name + column lack it', () => {
      const product = mockProduct({
        id: 'c2',
        name: 'Whey Protein 2kg',
        flavor: null,
        description: 'Premium whey with a rich chocolate taste.',
      });
      assert.equal(getProductInferredAttributes(product).flavor, 'chocolate');
    });

    it('prefers the structured column value when present', () => {
      const product = mockProduct({ id: 'c3', name: 'Gainer', flavor: 'Strawberry' });
      assert.equal(getProductInferredAttributes(product).flavor, 'Strawberry');
    });

    it('returns null for an attribute genuinely absent everywhere', () => {
      const product = mockProduct({ id: 'c4', name: 'Mystery Tub', brand: null });
      assert.equal(getProductInferredAttributes(product).brand, null);
    });
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

// ---------------------------------------------------------------------------
// sanitizeExtractedText — OCR quality gate
// ---------------------------------------------------------------------------

describe('sanitizeExtractedText', () => {
  it('passes through clean prose text unchanged', () => {
    const text = 'Tiramisu flavor. 1kg bag. Suitable for athletes.';
    const result = sanitizeExtractedText(text);
    assert.ok(result?.includes('Tiramisu'));
  });

  it('strips lines dominated by non-word characters (OCR garbage)', () => {
    // "▌█░░ ▒▒▒▓ ░░░░" has zero word characters → below the 40% threshold → stripped.
    const text = 'Valid line with content.\n▌█░░ ▒▒▒▓ ░░░░\nAnother valid line.';
    const result = sanitizeExtractedText(text);
    assert.ok(result?.includes('Valid line'));
    assert.ok(result?.includes('Another valid line'));
    assert.ok(!result?.includes('▌█'));
  });

  it('strips very short lines (< 3 chars)', () => {
    const text = 'AB\nA valid sentence here.\n--';
    const result = sanitizeExtractedText(text);
    assert.ok(!result?.startsWith('AB'));
    assert.ok(result?.includes('A valid sentence'));
  });

  it('caps output at maxChars', () => {
    const text = ('Word '.repeat(300)).trim();
    const result = sanitizeExtractedText(text, 100);
    assert.ok(result !== null);
    assert.ok((result ?? '').length <= 100);
  });

  it('returns null when all lines are garbage', () => {
    const text = '--- / ---\n▌░░▒▒\n!! !!';
    assert.equal(sanitizeExtractedText(text), null);
  });

  it('returns null for empty input', () => {
    assert.equal(sanitizeExtractedText(''), null);
    assert.equal(sanitizeExtractedText('   \n  \n'), null);
  });

  it('keeps lines that mix word chars with punctuation (e.g. "Tiramisu • 1kg")', () => {
    const text = 'Tiramisu • 1kg';
    const result = sanitizeExtractedText(text);
    assert.ok(result?.includes('Tiramisu'));
  });

  it('uses default maxChars of 800', () => {
    const text = ('A valid long line of text. '.repeat(50)).trim();
    const result = sanitizeExtractedText(text);
    assert.ok((result ?? '').length <= 800);
  });
});

// ---------------------------------------------------------------------------
// isOtherOptionsFollowUp — Albanian "tjera" and other follow-up phrases
// ---------------------------------------------------------------------------

describe('isOtherOptionsFollowUp', () => {
  it('matches Albanian "a keni tjera" (do you have others)', () => {
    assert.equal(isOtherOptionsFollowUp('a keni tjera'), true);
  });

  it('matches "a keni tjera a veq qita" (the exact screenshot phrase)', () => {
    assert.equal(isOtherOptionsFollowUp('a keni tjera a veq qita'), true);
  });

  it('matches "keni tjera"', () => {
    assert.equal(isOtherOptionsFollowUp('keni tjera'), true);
  });

  it('matches "a keni tjetra"', () => {
    assert.equal(isOtherOptionsFollowUp('a keni tjetra'), true);
  });

  it('matches "ndonje tjeter"', () => {
    assert.equal(isOtherOptionsFollowUp('ndonje tjeter'), true);
  });

  it('matches "ndonjë tjetër" with diacritics', () => {
    assert.equal(isOtherOptionsFollowUp('ndonjë tjetër'), true);
  });

  it('matches English "what else do you have"', () => {
    assert.equal(isOtherOptionsFollowUp('what else do you have'), true);
  });

  it('matches "anything else"', () => {
    assert.equal(isOtherOptionsFollowUp('anything else?'), true);
  });

  it('matches "more options"', () => {
    assert.equal(isOtherOptionsFollowUp('more options'), true);
  });

  it('matches "other options"', () => {
    assert.equal(isOtherOptionsFollowUp('other options'), true);
  });

  it('matches "any alternatives"', () => {
    assert.equal(isOtherOptionsFollowUp('any alternatives'), true);
  });

  it('does NOT match a specific product query', () => {
    assert.equal(isOtherOptionsFollowUp('a keni mass gainer 3kg'), false);
  });

  it('does NOT match a price question', () => {
    assert.equal(isOtherOptionsFollowUp('sa kushton'), false);
  });

  it('does NOT match a product attribute question', () => {
    assert.equal(isOtherOptionsFollowUp('cfare shije ka'), false);
  });

  it('does NOT match an order affirmation', () => {
    assert.equal(isOtherOptionsFollowUp('po dua ta porosis'), false);
  });
});

// ---------------------------------------------------------------------------
// extractConversationProductAnchor — "other options" follow-ups must be skipped
// ---------------------------------------------------------------------------

describe('extractConversationProductAnchor — other-options follow-ups', () => {
  it('skips "a keni tjera a veq qita" and returns the prior weight-gain query', () => {
    // Regression for the screenshot bug: the anchor must be the substantive product
    // query, not the Albanian "do you have others?" follow-up.
    const history: Message[] = [
      mockMessage({ content: 'a keni produkte te mira per shtim peshe', sent_by: 'customer' }),
      mockMessage({ content: 'Po, kemi X-Mass 3kg Qokolad.', sent_by: 'ai' }),
      mockMessage({ content: 'a keni tjera a veq qita', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.equal(anchor, 'a keni produkte te mira per shtim peshe');
  });

  it('skips "a keni tjera" and finds the prior product query', () => {
    const history: Message[] = [
      mockMessage({ content: 'Keni mass gainer?', sent_by: 'customer' }),
      mockMessage({ content: 'Po, kemi Mass Gainer 3kg.', sent_by: 'ai' }),
      mockMessage({ content: 'a keni tjera', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.equal(anchor, 'Keni mass gainer?');
  });

  it('skips "ndonje tjeter" and finds the prior product query', () => {
    const history: Message[] = [
      mockMessage({ content: 'keni proteina?', sent_by: 'customer' }),
      mockMessage({ content: 'Po, kemi Whey Protein 2kg.', sent_by: 'ai' }),
      mockMessage({ content: 'ndonje tjeter?', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.equal(anchor, 'keni proteina?');
  });

  it('skips "what else do you have?" and finds the prior product query', () => {
    const history: Message[] = [
      mockMessage({ content: 'Do you have creatine?', sent_by: 'customer' }),
      mockMessage({ content: 'Yes, we have ON Creatine.', sent_by: 'ai' }),
      mockMessage({ content: 'what else do you have?', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.equal(anchor, 'Do you have creatine?');
  });

  it('skips "other options" and finds the prior product query', () => {
    // NOTE: "Show me weight gainers" is intentionally avoided here because "weight"
    // is an attribute keyword that triggers isNaturalLanguageAttributeFollowUp, which
    // also skips the message. Instead use a query with no attribute words.
    const history: Message[] = [
      mockMessage({ content: 'Keni mass gainer?', sent_by: 'customer' }),
      mockMessage({ content: 'We have X-Mass 3kg.', sent_by: 'ai' }),
      mockMessage({ content: 'other options?', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    assert.equal(anchor, 'Keni mass gainer?');
  });

  it('falls back to AI text when only follow-up messages from customer are present', () => {
    const history: Message[] = [
      mockMessage({ content: 'We have Mass Gainer 3kg and Mega Mass 3kg.', sent_by: 'ai' }),
      mockMessage({ content: 'a keni tjera', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history);
    // Should fall back to the AI text since the only customer message is a follow-up
    assert.ok(anchor?.includes('Mass Gainer') || anchor?.includes('Mega Mass'));
  });
});

// ---------------------------------------------------------------------------
// extractConversationProductAnchor — skipMostRecentCustomerMessage (LLM-confirmed path)
//
// When the LLM confirms "other options" intent, the caller passes
// skipMostRecentCustomerMessage:true so the anchor function bypasses regex
// entirely and skips the inbound message unconditionally. This covers novel
// phrasings, slang, and dialect forms that no regex can predict.
// ---------------------------------------------------------------------------

describe('extractConversationProductAnchor — skipMostRecentCustomerMessage (LLM path)', () => {
  it('skips the latest customer message unconditionally when flag is set', () => {
    // "trego me tjeter" (Albanian: "show me another") — not in any regex pattern
    const history: Message[] = [
      mockMessage({ content: 'Keni proteina?', sent_by: 'customer' }),
      mockMessage({ content: 'Po, kemi Whey Protein 2kg.', sent_by: 'ai' }),
      mockMessage({ content: 'trego me tjeter', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history, { skipMostRecentCustomerMessage: true });
    assert.equal(anchor, 'Keni proteina?');
  });

  it('handles novel English phrasing not matched by regex ("show me the rest")', () => {
    const history: Message[] = [
      mockMessage({ content: 'Do you have creatine?', sent_by: 'customer' }),
      mockMessage({ content: 'Yes, we have ON Creatine.', sent_by: 'ai' }),
      mockMessage({ content: 'show me the rest', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history, { skipMostRecentCustomerMessage: true });
    assert.equal(anchor, 'Do you have creatine?');
  });

  it('handles novel Albanian slang not matched by regex ("cka tjeter keni")', () => {
    const history: Message[] = [
      mockMessage({ content: 'A keni mass gainer?', sent_by: 'customer' }),
      mockMessage({ content: 'Po, kemi X-Mass 3kg.', sent_by: 'ai' }),
      mockMessage({ content: 'cka tjeter keni', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history, { skipMostRecentCustomerMessage: true });
    assert.equal(anchor, 'A keni mass gainer?');
  });

  it('still skips OLDER follow-up messages via regex after skipping the inbound', () => {
    // Three-turn conversation: original query → follow-up → "other options"
    // After skipping the last customer message (the "other options" one),
    // the middle message should still be skipped by regex (price follow-up),
    // and the anchor should be the original product query.
    const history: Message[] = [
      mockMessage({ content: 'Keni creatine?', sent_by: 'customer' }),
      mockMessage({ content: 'Po, kemi ON Creatine 300g.', sent_by: 'ai' }),
      mockMessage({ content: 'sa kushton?', sent_by: 'customer' }),
      mockMessage({ content: 'Kushton 2800 ALL.', sent_by: 'ai' }),
      mockMessage({ content: 'trego me tjeter', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history, { skipMostRecentCustomerMessage: true });
    assert.equal(anchor, 'Keni creatine?');
  });

  it('falls back to AI texts when ALL prior customer messages are follow-ups', () => {
    const history: Message[] = [
      mockMessage({ content: 'We have Mass Gainer 3kg.', sent_by: 'ai' }),
      mockMessage({ content: 'sa kushton?', sent_by: 'customer' }),
      mockMessage({ content: 'Kushton 3500 ALL.', sent_by: 'ai' }),
      mockMessage({ content: 'cka tjeter keni', sent_by: 'customer' }),
    ];
    const anchor = extractConversationProductAnchor(history, { skipMostRecentCustomerMessage: true });
    // sa kushton? is also a follow-up (price), so anchor falls back to AI text
    assert.ok(anchor?.includes('Mass Gainer'));
  });

  it('behaves identically to default when flag is false', () => {
    const history: Message[] = [
      mockMessage({ content: 'Keni proteina?', sent_by: 'customer' }),
      mockMessage({ content: 'Po, kemi Whey Protein.', sent_by: 'ai' }),
      mockMessage({ content: 'a keni tjera', sent_by: 'customer' }),
    ];
    // With flag=false, "a keni tjera" is skipped by isOtherOptionsFollowUp regex
    const anchorNoFlag = extractConversationProductAnchor(history);
    // With flag=true, "a keni tjera" is skipped by the unconditional skip
    const anchorWithFlag = extractConversationProductAnchor(history, { skipMostRecentCustomerMessage: true });
    // Both should resolve to the same original query
    assert.equal(anchorNoFlag, 'Keni proteina?');
    assert.equal(anchorWithFlag, 'Keni proteina?');
  });
});
