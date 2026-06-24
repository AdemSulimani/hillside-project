/**
 * Tests for the uncertain-answer fallback guard (uncertainAnswerFallbackGuard.ts).
 *
 * Invariants:
 *  - isUncertainDeflection detects negative-knowledge / uncertainty wording in
 *    English and Albanian (with and without diacritics / curly apostrophes).
 *  - It NEVER fires on grounded answers, order-flow requests, or closing replies
 *    (high precision — no change to normal behaviour).
 *  - shouldEscalateUncertainAnswer honours every exclusion (disabled, already
 *    escalated, out-of-stock canned, order flow) and the combined signal set.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GET_BACK_TO_YOU_MESSAGES,
  isOutOfStockReply,
  isUncertainDeflection,
  shouldEscalateUncertainAnswer,
  type UncertainAnswerDecisionInput,
} from '../uncertainAnswerFallbackGuard';

// ---------------------------------------------------------------------------
// isUncertainDeflection — should FIRE
// ---------------------------------------------------------------------------

describe('isUncertainDeflection — positive cases', () => {
  const deflections = [
    "We don't have information about that.",
    'We do not have any details about that product.',
    "I don't have that information.",
    'Unfortunately, we cannot answer that question.',
    "I'm not sure about that.",
    'I am not certain about this.',
    "I don't know the answer to that.",
    'We do not have access to that information.',
    'There is no information about this in our system.',
    "I can't answer that, sorry.",
    'That information is not available.',
    // Albanian
    'Nuk kemi informacion për këtë.',
    'Nuk e dimë saktësisht.',
    'Nuk e di.',
    'Nuk jam i sigurt për këtë.',
    "Nuk mund t'ju përgjigjem për këtë.",
    'Nuk ka informacion për këtë produkt.',
    'Këtë informacion nuk e kemi.',
  ];

  for (const reply of deflections) {
    it(`fires for: "${reply}"`, () => {
      assert.equal(isUncertainDeflection(reply), true);
    });
  }
});

// ---------------------------------------------------------------------------
// isUncertainDeflection — should NOT fire (normal behaviour preserved)
// ---------------------------------------------------------------------------

describe('isUncertainDeflection — negative cases', () => {
  const safeReplies = [
    'The product costs €25 and is in stock.',
    'Carbo One 1kg is available in lemon flavor.',
    'Please share your name, phone number, and delivery address.',
    'Thank you for your order! Please confirm the information you provided is correct.',
    'No problem, take care.',
    'Your order will arrive within 24 hours.',
    'We have this product available. Would you like to order?',
    // Albanian grounded / order-flow replies
    'Çmimi është 25 euro dhe është në stok.',
    'Ju lutem na tregoni emrin, numrin dhe adresën tuaj.',
    'Faleminderit për porosinë!',
    '', // empty
  ];

  for (const reply of safeReplies) {
    it(`does not fire for: "${reply}"`, () => {
      assert.equal(isUncertainDeflection(reply), false);
    });
  }
});

// ---------------------------------------------------------------------------
// isOutOfStockReply — out of stock is reliable info, never escalated
// ---------------------------------------------------------------------------

describe('isOutOfStockReply', () => {
  const outOfStock = [
    'Hello, this product is currently out of stock.',
    'Sorry, that item is sold out at the moment.',
    'This product is not in stock right now.',
    'Përshëndetje, produkti për momentin është jashtë stokut.',
    'Ky produkt nuk është në stok për momentin.',
    'Stoku ka mbaruar, por do të rifurnizohet së shpejti.',
  ];
  for (const reply of outOfStock) {
    it(`detects out of stock: "${reply}"`, () => {
      assert.equal(isOutOfStockReply(reply), true);
    });
  }

  const notOutOfStock = [
    "We don't carry that product.",
    'We do not have that product in our catalog.',
    'That product is not available.',
    'The product costs €25 and is in stock.',
    'Nuk e kemi këtë produkt.',
  ];
  for (const reply of notOutOfStock) {
    it(`is not out of stock: "${reply}"`, () => {
      assert.equal(isOutOfStockReply(reply), false);
    });
  }
});

// ---------------------------------------------------------------------------
// shouldEscalateUncertainAnswer — combined decision
// ---------------------------------------------------------------------------

describe('shouldEscalateUncertainAnswer', () => {
  const base: UncertainAnswerDecisionInput = {
    replyText: "We don't have information about that.",
    enabled: true,
    alreadyEscalated: false,
    isOosCannedReply: false,
    isOrderFlowReply: false,
    negativeAvailabilityDetected: false,
  };

  it('escalates a knowledge deflection when enabled and no exclusions apply', () => {
    assert.equal(shouldEscalateUncertainAnswer(base), true);
  });

  it('escalates when the upstream availability classifier flagged it, even without deterministic match', () => {
    assert.equal(
      shouldEscalateUncertainAnswer({
        ...base,
        replyText: 'We do not carry that product.',
        negativeAvailabilityDetected: true,
      }),
      true,
    );
  });

  it('does NOT escalate when the guard is disabled', () => {
    assert.equal(shouldEscalateUncertainAnswer({ ...base, enabled: false }), false);
  });

  it('does NOT escalate when an earlier escalation already handled the turn', () => {
    assert.equal(shouldEscalateUncertainAnswer({ ...base, alreadyEscalated: true }), false);
  });

  it('does NOT escalate the deliberate out-of-stock canned reply', () => {
    assert.equal(shouldEscalateUncertainAnswer({ ...base, isOosCannedReply: true }), false);
  });

  it('does NOT escalate an order-flow reply', () => {
    assert.equal(shouldEscalateUncertainAnswer({ ...base, isOrderFlowReply: true }), false);
  });

  it('does NOT escalate a grounded, helpful reply', () => {
    assert.equal(
      shouldEscalateUncertainAnswer({
        ...base,
        replyText: 'The product costs €25 and is in stock.',
      }),
      false,
    );
  });

  it('does NOT escalate an out-of-stock reply (delivered to the customer as-is)', () => {
    assert.equal(
      shouldEscalateUncertainAnswer({
        ...base,
        replyText: 'Hello, this product is currently out of stock.',
        negativeAvailabilityDetected: true,
      }),
      false,
    );
  });

  it('does NOT escalate a free-form Albanian out-of-stock reply', () => {
    assert.equal(
      shouldEscalateUncertainAnswer({
        ...base,
        replyText: 'Ky produkt nuk është në stok për momentin.',
        negativeAvailabilityDetected: true,
      }),
      false,
    );
  });

  it('STILL escalates "we don\'t carry that product" (no stock wording)', () => {
    assert.equal(
      shouldEscalateUncertainAnswer({
        ...base,
        replyText: 'We do not carry that product.',
        negativeAvailabilityDetected: true,
      }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Holding copy
// ---------------------------------------------------------------------------

describe('GET_BACK_TO_YOU_MESSAGES', () => {
  it('provides English and Albanian copy that never claims unavailability', () => {
    assert.match(GET_BACK_TO_YOU_MESSAGES.en, /get back to you shortly/i);
    assert.ok(GET_BACK_TO_YOU_MESSAGES.sq.length > 0);
    assert.doesNotMatch(GET_BACK_TO_YOU_MESSAGES.en, /not available|don't have/i);
  });
});
