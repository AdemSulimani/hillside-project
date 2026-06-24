/**
 * Tests for the cross-turn price-consistency guard
 * (conversationFactConsistencyGuard.ts).
 *
 * Covers:
 *  - Detection of a price stated in the current reply that contradicts a prior AI turn.
 *  - No false positive when prices match.
 *  - No false positive when the prior reply contains multiple prices (ambiguous).
 *  - No false positive when the prior reply is a holding/escalation message.
 *  - Fail-open: no detection when the current reply has no price, or multiple prices.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../../db/models/message';
import { detectCrossMessagePriceInconsistency } from '../conversationFactConsistencyGuard';

function mockAiMessage(content: string, offsetMs = 0): Message {
  return {
    id: `msg-${Math.random()}`,
    conversation_id: 'conv1',
    tenant_id: 't1',
    content,
    sent_by: 'ai',
    external_message_id: null,
    created_at: new Date(Date.now() - offsetMs),
    updated_at: new Date(),
    status: 'sent',
    metadata: null,
    edited_at: null,
    is_edited: false,
  } as unknown as Message;
}

describe('detectCrossMessagePriceInconsistency', () => {
  it('detects a price mismatch between current reply and a prior AI turn', () => {
    const history = [mockAiMessage('The product costs €25.', 60000)];
    const result = detectCrossMessagePriceInconsistency('The product is €30.', history);
    assert.equal(result.length, 1);
    assert.ok(Math.abs(result[0].currentPrice - 30) < 0.01);
    assert.ok(Math.abs(result[0].priorPrice - 25) < 0.01);
  });

  it('returns empty when prices match exactly', () => {
    const history = [mockAiMessage('Price is €25.')];
    assert.deepEqual(detectCrossMessagePriceInconsistency('The product is €25.', history), []);
  });

  it('returns empty when prior reply has multiple prices (ambiguous product reference)', () => {
    const history = [mockAiMessage('Product A is €25 and Product B is €40.')];
    assert.deepEqual(detectCrossMessagePriceInconsistency('The product is €30.', history), []);
  });

  it('returns empty when current reply states no price', () => {
    const history = [mockAiMessage('Price is €25.')];
    assert.deepEqual(detectCrossMessagePriceInconsistency('Available in chocolate flavor.', history), []);
  });

  it('returns empty when current reply states multiple prices (ambiguous)', () => {
    const history = [mockAiMessage('Price is €25.')];
    assert.deepEqual(detectCrossMessagePriceInconsistency('From €20 to €50.', history), []);
  });

  it('skips holding/escalation messages in the prior history', () => {
    const history = [
      mockAiMessage("Hello, we will notify you shortly regarding the brand information.", 60000),
      mockAiMessage('Price is €25.', 120000),
    ];
    const result = detectCrossMessagePriceInconsistency('The product is €25.', history);
    assert.deepEqual(result, []); // matching the €25 prior — no inconsistency
  });

  it('skips holding messages written in Albanian (sq)', () => {
    const history = [
      mockAiMessage("Përshëndetje, do t'ju njoftojmë së shpejti.", 60000),
      mockAiMessage('Price is €25.', 120000),
    ];
    const result = detectCrossMessagePriceInconsistency('The product is €30.', history);
    // Only prior with a price is the €25 one → inconsistency detected
    assert.equal(result.length, 1);
  });

  it('returns empty when history is empty', () => {
    assert.deepEqual(detectCrossMessagePriceInconsistency('The product is €25.', []), []);
  });

  it('only looks at AI messages, not customer messages', () => {
    const customerMsg = {
      ...mockAiMessage('Price should be €10.'),
      sent_by: 'customer',
    } as unknown as Message;
    assert.deepEqual(detectCrossMessagePriceInconsistency('The product is €30.', [customerMsg]), []);
  });
});
