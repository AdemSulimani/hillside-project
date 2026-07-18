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

describe('50+-turn depth scenario (RC-13 acceptance, projector level)', () => {
  // The spec's acceptance: a 50+-turn conversation never re-asks a provided field and never
  // denies a previously-recommended in-stock product. The pipeline-level version needs a live
  // stack; THIS is the committed stand-in at the seam that decides it: the fields the model
  // needs must still be present in the assembled context after 50+ turns of chatter has pushed
  // every load-bearing message far outside the 40-row history window.
  it('slots + recommendation anchor survive 60 turns of chatter and a deep window', () => {
    const chatter: SummaryMessage[] = [];
    for (let i = 0; i < 60; i++) {
      chatter.push({
        isCustomer: i % 2 === 0,
        text: i % 2 === 0 ? `A eshte i mire produkti per fillester? (pyetja ${i})` : `Po, eshte shume i pershtatshem. (pergjigja ${i})`,
      });
    }
    const s = buildConversationSummary({
      slots: { name: 'Arben', phone: '+38344123456', address: 'Rruga B, nr 12, Prishtina', orderStage: 'awaiting_confirmation' },
      recommendedProducts: [{ name: 'Mass Gainer 3kg Qokolad', price: 52, discountedPrice: null }],
      olderMessages: chatter,
      maxTailChars: 600,
    });
    assert.ok(s);
    // Never re-ask: every provided field is present in the injected context.
    assert.match(s!, /Arben/);
    assert.match(s!, /\+38344123456/);
    assert.match(s!, /Rruga B, nr 12, Prishtina/);
    // Never deny: the prior in-stock recommendation is present with its price.
    assert.match(s!, /Mass Gainer 3kg Qokolad/);
    assert.match(s!, /€52/);
    // The chatter tail stayed bounded — depth cannot crowd out the load-bearing facts.
    assert.ok(s!.length < 2000, `summary stayed bounded (got ${s!.length} chars)`);
  });

  it('is deterministic at depth: identical 60-turn input → byte-identical summary', () => {
    const chatter: SummaryMessage[] = [];
    for (let i = 0; i < 60; i++) chatter.push({ isCustomer: i % 2 === 0, text: `turn ${i}` });
    const args = {
      slots: { name: 'Arben', phone: '+38344123456', address: 'Rruga B', orderStage: 'collecting' },
      recommendedProducts: [{ name: 'Whey 2kg', price: 30, discountedPrice: null }],
      olderMessages: chatter,
    };
    assert.equal(buildConversationSummary(args), buildConversationSummary(args));
  });
});
