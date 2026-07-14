/**
 * P2-3 (RC-13) tests for the slot-backed summary projector. Pure — no DB / Redis / LLM.
 * Asserts: persisted slots + last-recommendation anchor are injected; the extractive tail is a
 * SUPERSET of the legacy summary's load-bearing content (last-2 customer highlights); determinism;
 * the token bound; and graceful NULL-slot fallback (never emits "null", never throws).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConversationSummary,
  type SummaryMessage,
  type SummaryProduct,
} from '../conversationSummary';

const olderMessages: SummaryMessage[] = [
  { isCustomer: true, text: 'Hi, do you have vanilla protein?' },
  { isCustomer: false, text: 'Yes! Vanilla Whey 50 servings is €25 and in stock.' },
  { isCustomer: true, text: 'My name is Arben and my number is +38344123456.' },
  { isCustomer: true, text: 'Deliver to Rruga B, nr 12, Prishtina.' },
  { isCustomer: false, text: 'Great, your order will arrive within 48 hours.' },
];

const recs: SummaryProduct[] = [
  { name: 'Vanilla Whey 50 servings', price: 25, discountedPrice: null },
];

describe('buildConversationSummary', () => {
  it('injects persisted slots (name/phone/address/order stage)', () => {
    const s = buildConversationSummary({
      slots: { name: 'Arben', phone: '+38344123456', address: 'Rruga B, nr 12', orderStage: 'collecting' },
      recommendedProducts: [],
      olderMessages,
    });
    assert.ok(s);
    assert.match(s!, /Arben/);
    assert.match(s!, /\+38344123456/);
    assert.match(s!, /Rruga B, nr 12/);
    assert.match(s!, /collecting/);
  });

  it('injects the last-recommended in-stock products with price', () => {
    const s = buildConversationSummary({ slots: {}, recommendedProducts: recs, olderMessages });
    assert.ok(s);
    assert.match(s!, /Vanilla Whey 50 servings/);
    assert.match(s!, /€25/);
  });

  it('carries the legacy load-bearing content (superset): last-2 customer highlights + last assistant preview', () => {
    const s = buildConversationSummary({ slots: {}, recommendedProducts: [], olderMessages });
    assert.ok(s);
    // last two customer messages are the load-bearing highlights the legacy summary carried
    assert.match(s!, /My name is Arben/);
    assert.match(s!, /Rruga B, nr 12, Prishtina/);
    // NEW: the last delivered assistant line (an ETA) is retained too — the legacy summary dropped it
    assert.match(s!, /arrive within 48 hours/);
  });

  it('is deterministic (same input → identical output)', () => {
    const args = { slots: { name: 'Arben' }, recommendedProducts: recs, olderMessages };
    assert.equal(buildConversationSummary(args), buildConversationSummary(args));
  });

  it('honours the token bound on the extractive tail', () => {
    const long: SummaryMessage[] = Array.from({ length: 40 }, (_, i) => ({
      isCustomer: i % 2 === 0,
      text: `message ${i} ${'x'.repeat(200)}`,
    }));
    const s = buildConversationSummary({
      slots: {},
      recommendedProducts: [],
      olderMessages: long,
      maxTailChars: 120,
    });
    assert.ok(s);
    assert.ok(s!.length <= 140, `expected bounded tail, got length ${s!.length}`);
  });

  it('gracefully degrades on NULL slots — never emits "null", never throws, falls back to the tail', () => {
    const s = buildConversationSummary({
      slots: { name: null, phone: null, address: null, orderStage: null },
      recommendedProducts: [],
      olderMessages,
    });
    assert.ok(s);
    assert.doesNotMatch(s!, /null/);
    assert.match(s!, /My name is Arben/); // still carries the customer fact from the tail
  });

  it('returns null when there is no older segment AND no slots/recs', () => {
    assert.equal(
      buildConversationSummary({ slots: {}, recommendedProducts: [], olderMessages: [] }),
      null,
    );
  });

  it('drops a zero-priced product price gracefully (name only)', () => {
    const s = buildConversationSummary({
      slots: {},
      recommendedProducts: [{ name: 'Sampler', price: 0, discountedPrice: null }],
      olderMessages,
    });
    assert.ok(s);
    assert.match(s!, /Sampler/);
    assert.doesNotMatch(s!, /Sampler \(€/);
  });
});
