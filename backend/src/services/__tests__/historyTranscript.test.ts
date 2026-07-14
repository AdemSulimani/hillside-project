/**
 * P2-3 (RC-16) tests for the delivery-filtered transcript predicates. Pure — no DB / Redis / LLM.
 * Guards the key correctness point (verified in the source): a flagged reply was DELIVERED, so it is
 * RELABELED to `system`, never dropped; only send-failed non-customer rows are dropped.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  historyRoleFor,
  keepMessageInHistory,
  type HistoryRowLike,
} from '../historyTranscript';

const row = (over: Partial<HistoryRowLike>): HistoryRowLike => ({
  sent_by: 'ai',
  flagged: false,
  send_status: null,
  content: 'A normal delivered sales reply about the product.',
  ...over,
});

// A canned-copy predicate stub: only the literal 'HOLDING' text is treated as canned.
const isCanned = (c: string): boolean => c.trim() === 'HOLDING';

describe('keepMessageInHistory', () => {
  it('always keeps customer (inbound) rows, even with a failed marker', () => {
    assert.equal(keepMessageInHistory(row({ sent_by: 'customer', send_status: 'failed' })), true);
  });

  it('drops a non-customer row whose send failed (never delivered)', () => {
    assert.equal(keepMessageInHistory(row({ sent_by: 'ai', send_status: 'failed' })), false);
    assert.equal(keepMessageInHistory(row({ sent_by: 'human', send_status: 'failed' })), false);
  });

  it('keeps a non-customer row with NULL send_status (ambiguous → treated as delivered)', () => {
    assert.equal(keepMessageInHistory(row({ sent_by: 'ai', send_status: null })), true);
    assert.equal(keepMessageInHistory(row({ sent_by: 'ai', send_status: undefined })), true);
  });

  it('never keys exclusion on any value other than the literal "failed"', () => {
    assert.equal(keepMessageInHistory(row({ sent_by: 'ai', send_status: 'sent' })), true);
    assert.equal(keepMessageInHistory(row({ sent_by: 'ai', send_status: 'delivered' })), true);
  });
});

describe('historyRoleFor', () => {
  it('maps customer rows to user', () => {
    assert.equal(historyRoleFor(row({ sent_by: 'customer' }), isCanned), 'user');
  });

  it('maps a delivered, unflagged, non-canned AI/human row to assistant', () => {
    assert.equal(historyRoleFor(row({ sent_by: 'ai' }), isCanned), 'assistant');
    assert.equal(historyRoleFor(row({ sent_by: 'human' }), isCanned), 'assistant');
  });

  it('RELABELS a flagged (delivered, low-quality) reply to system — never drops it', () => {
    // This is the crux of the P2-3 correctness fix: flagged replies were sent to the customer.
    assert.equal(historyRoleFor(row({ sent_by: 'ai', flagged: true }), isCanned), 'system');
    // keepMessageInHistory still keeps it (only send-failed rows are dropped).
    assert.equal(keepMessageInHistory(row({ sent_by: 'ai', flagged: true })), true);
  });

  it('maps canned holding/escalation copy to system', () => {
    assert.equal(historyRoleFor(row({ sent_by: 'ai', content: 'HOLDING' }), isCanned), 'system');
  });

  it('customer precedence: a customer row is user even if flagged/canned', () => {
    assert.equal(
      historyRoleFor(row({ sent_by: 'customer', flagged: true, content: 'HOLDING' }), isCanned),
      'user',
    );
  });
});
