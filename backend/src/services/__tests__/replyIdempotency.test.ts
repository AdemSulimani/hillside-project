/**
 * P1-1 (RC-20): unit tests for the pure idempotency core.
 *
 * These exercise the I/O-free pieces the post-send pipeline builds on: the key derivation is
 * deterministic and stable across BullMQ attempts, slot-sensitive, and collision-resistant
 * across field boundaries; the null-send placeholder is deterministic; and the send-action
 * predicate resolves the staged/sent/failed lifecycle correctly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveReplyIdempotencyKey,
  nullSendPlaceholderExternalId,
  decideSendAction,
  imageReplySlot,
} from '../replyIdempotency';

const CONV = '11111111-1111-1111-1111-111111111111';
const INBOUND = 'mid.ABC123';

describe('deriveReplyIdempotencyKey', () => {
  it('is deterministic for identical inputs (stable across BullMQ attempts)', () => {
    const a = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: INBOUND,
      replySlot: 'main',
    });
    const b = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: INBOUND,
      replySlot: 'main',
    });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/); // sha256 hex
  });

  it('is slot-sensitive: the main reply and a holding message never share a key', () => {
    const main = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: INBOUND,
      replySlot: 'main',
    });
    const holding = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: INBOUND,
      replySlot: 'holding:sensitive',
    });
    assert.notEqual(main, holding);
  });

  it('changes with the logical inbound id (a new turn is a new key)', () => {
    const t1 = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: 'mid.turn1',
      replySlot: 'main',
    });
    const t2 = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: 'mid.turn2',
      replySlot: 'main',
    });
    assert.notEqual(t1, t2);
  });

  it('distinguishes per-product image slots', () => {
    const p1 = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: INBOUND,
      replySlot: imageReplySlot('prod-1'),
    });
    const p2 = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: INBOUND,
      replySlot: imageReplySlot('prod-2'),
    });
    assert.notEqual(p1, p2);
  });

  it('resists field-boundary collisions (separator cannot be forged by concatenation)', () => {
    // Without a non-forgeable separator, ('ab', 'c') and ('a', 'bc') could hash equal.
    const x = deriveReplyIdempotencyKey({
      conversationId: 'ab',
      logicalInboundExternalId: 'c',
      replySlot: 'main',
    });
    const y = deriveReplyIdempotencyKey({
      conversationId: 'a',
      logicalInboundExternalId: 'bc',
      replySlot: 'main',
    });
    assert.notEqual(x, y);
  });
});

describe('nullSendPlaceholderExternalId', () => {
  it('is deterministic for a given idempotency key (retry reuses the same external id)', () => {
    const key = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: INBOUND,
      replySlot: 'main',
    });
    assert.equal(nullSendPlaceholderExternalId(key), nullSendPlaceholderExternalId(key));
  });

  it('carries the ai_ prefix and a bounded length', () => {
    const key = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: INBOUND,
      replySlot: 'main',
    });
    const placeholder = nullSendPlaceholderExternalId(key);
    assert.match(placeholder, /^ai_[0-9a-f]{32}$/);
  });

  it('distinguishes different keys', () => {
    const kMain = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: INBOUND,
      replySlot: 'main',
    });
    const kHolding = deriveReplyIdempotencyKey({
      conversationId: CONV,
      logicalInboundExternalId: INBOUND,
      replySlot: 'holding:price',
    });
    assert.notEqual(nullSendPlaceholderExternalId(kMain), nullSendPlaceholderExternalId(kHolding));
  });
});

describe('decideSendAction', () => {
  it('sends when nothing is staged yet', () => {
    assert.equal(decideSendAction({ status: null, sendAttempts: 0, maxSendAttempts: 3 }), 'send');
  });

  it('sends on a freshly staged row', () => {
    assert.equal(
      decideSendAction({ status: 'staged', sendAttempts: 0, maxSendAttempts: 3 }),
      'send',
    );
  });

  it('no-ops the send when the reply was already delivered (sent → self-heal only)', () => {
    assert.equal(decideSendAction({ status: 'sent', sendAttempts: 1, maxSendAttempts: 3 }), 'noop');
  });

  it('resends a prior failed send while under the attempt cap', () => {
    assert.equal(
      decideSendAction({ status: 'failed', sendAttempts: 1, maxSendAttempts: 3 }),
      'resend',
    );
  });

  it('stops re-sending once the attempt cap is reached', () => {
    assert.equal(
      decideSendAction({ status: 'failed', sendAttempts: 3, maxSendAttempts: 3 }),
      'noop',
    );
  });
});
