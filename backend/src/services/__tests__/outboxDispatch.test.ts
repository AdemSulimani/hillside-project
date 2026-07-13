/**
 * P1-1 (RC-20, RC-21): unit coverage for the outbox dedupe-key builder and the send-action
 * predicate that drive exactly-once dispatch. The DB-level behaviour (ON CONFLICT dedupe, the
 * staging flip, relay claim/drain) is exercised by the integration suite; here we lock the pure
 * pieces that decide idempotency.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aiReplyDedupeKey } from '../../db/models/outbox';
import { decideSendAction } from '../replyIdempotency';

const CONV = '22222222-2222-2222-2222-222222222222';

describe('aiReplyDedupeKey', () => {
  it('is deterministic and scoped by conversation + inbound id', () => {
    assert.equal(
      aiReplyDedupeKey(CONV, 'mid.1'),
      aiReplyDedupeKey(CONV, 'mid.1'),
    );
    assert.equal(aiReplyDedupeKey(CONV, 'mid.1'), `ai.reply:${CONV}:mid.1`);
  });

  it('distinguishes different inbound ids (a new turn is a distinct effect)', () => {
    assert.notEqual(aiReplyDedupeKey(CONV, 'mid.1'), aiReplyDedupeKey(CONV, 'mid.2'));
  });

  it('distinguishes different conversations', () => {
    assert.notEqual(
      aiReplyDedupeKey(CONV, 'mid.1'),
      aiReplyDedupeKey('33333333-3333-3333-3333-333333333333', 'mid.1'),
    );
  });
});

describe('decideSendAction (dispatch gate)', () => {
  it('a sent row never re-hits the channel (exactly-once delivery)', () => {
    assert.equal(decideSendAction({ status: 'sent', sendAttempts: 9, maxSendAttempts: 5 }), 'noop');
  });

  it('a fresh/staged row sends', () => {
    assert.equal(decideSendAction({ status: null, sendAttempts: 0, maxSendAttempts: 5 }), 'send');
    assert.equal(decideSendAction({ status: 'staged', sendAttempts: 0, maxSendAttempts: 5 }), 'send');
  });

  it('a failed row resends under the cap and stops at it', () => {
    assert.equal(decideSendAction({ status: 'failed', sendAttempts: 4, maxSendAttempts: 5 }), 'resend');
    assert.equal(decideSendAction({ status: 'failed', sendAttempts: 5, maxSendAttempts: 5 }), 'noop');
  });
});
