import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectRecentlyDiscussedProductIds,
  type Message,
} from '../../db/models/message';
import { isContextOnlyFollowUp } from '../productRetrievalService';

// NOTE: these tests deliberately avoid importing aiService — that module loads the
// OpenAI client (which throws without OPENAI_API_KEY) and other runtime dependencies.
// The detection logic that actually drives multi-turn anchor extraction lives in
// productRetrievalService, and the persisted-context source of truth is the message
// model helper below; both are import-safe.

// ---------------------------------------------------------------------------
// Minimal Message stub builder (mirrors the shape mapMessageRow produces).
// ---------------------------------------------------------------------------
function mockMessage(
  overrides: Partial<Message> & { sent_by: Message['sent_by'] },
): Message {
  return {
    id: Math.random().toString(36).slice(2),
    tenant_id: 't1',
    conversation_id: 'conv1',
    external_message_id: Math.random().toString(36).slice(2),
    direction: overrides.sent_by === 'customer' ? 'inbound' : 'outbound',
    type: 'text',
    content: null,
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
    product_ids: [],
    created_at: new Date(),
    ...overrides,
  } as Message;
}

describe('collectRecentlyDiscussedProductIds (persisted multi-turn product context)', () => {
  it('returns the product IDs of the most recent AI message that surfaced products', () => {
    const history: Message[] = [
      mockMessage({ content: 'weight gain products?', sent_by: 'customer' }),
      mockMessage({ content: 'Mass gainer, Mega mass', sent_by: 'ai', product_ids: ['A', 'B'] }),
      mockMessage({ content: 'sa kushtojn kto', sent_by: 'customer' }),
    ];
    assert.deepEqual(collectRecentlyDiscussedProductIds(history), ['A', 'B']);
  });

  it('skips AI messages with no products (escalations / clarifying questions)', () => {
    const history: Message[] = [
      mockMessage({ content: 'weight gain?', sent_by: 'customer' }),
      mockMessage({ content: 'Mass gainer, Mega mass', sent_by: 'ai', product_ids: ['A', 'B'] }),
      mockMessage({ content: 'sa kushtojn', sent_by: 'customer' }),
      mockMessage({ content: 'Could you clarify?', sent_by: 'ai', product_ids: [] }),
      mockMessage({ content: 'the ones you listed', sent_by: 'customer' }),
    ];
    assert.deepEqual(collectRecentlyDiscussedProductIds(history), ['A', 'B']);
  });

  it('prefers the latest recommendation when products change across turns', () => {
    const history: Message[] = [
      mockMessage({ content: 'creatine?', sent_by: 'customer' }),
      mockMessage({ content: 'ON Creatine', sent_by: 'ai', product_ids: ['C1'] }),
      mockMessage({ content: 'weight gain?', sent_by: 'customer' }),
      mockMessage({ content: 'Mass gainer, Mega mass', sent_by: 'ai', product_ids: ['A', 'B'] }),
      mockMessage({ content: 'what flavors?', sent_by: 'customer' }),
    ];
    assert.deepEqual(collectRecentlyDiscussedProductIds(history), ['A', 'B']);
  });

  it('ignores product IDs on customer/inbound messages', () => {
    const history: Message[] = [
      mockMessage({ content: 'spoofed', sent_by: 'customer', product_ids: ['X'] }),
    ];
    assert.deepEqual(collectRecentlyDiscussedProductIds(history), []);
  });

  it('returns empty when no AI message has products', () => {
    const history: Message[] = [
      mockMessage({ content: 'hello', sent_by: 'customer' }),
      mockMessage({ content: 'Hi!', sent_by: 'ai', product_ids: [] }),
    ];
    assert.deepEqual(collectRecentlyDiscussedProductIds(history), []);
  });
});

describe('isContextOnlyFollowUp — informal / plural / deictic price follow-ups', () => {
  const contextFollowUps = [
    'Sa kushtojn kto',
    'sa kushtojn kto?',
    'sa kushtojne keto',
    'Sa kushton?',
    'sa kushtojn',
    'kushton',
    'cmimi',
    'qmimi?',
    'price',
    'cost',
    'how much',
    'tell me more',
    'about this',
  ];

  for (const msg of contextFollowUps) {
    it(`treats "${msg}" as a context-only follow-up`, () => {
      assert.equal(isContextOnlyFollowUp(msg), true);
    });
  }

  it('does not classify a genuine new product query as a context-only follow-up', () => {
    assert.equal(
      isContextOnlyFollowUp('Do you have whey protein chocolate flavor in stock?'),
      false,
    );
    assert.equal(isContextOnlyFollowUp('a keni mass gainer 3kg'), false);
  });
});
