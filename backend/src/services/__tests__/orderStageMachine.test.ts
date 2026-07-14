/**
 * Tests for the deterministic order_stage FSM + consolidated order lexicons (P2-2, RC-07/08/22).
 *
 * The FSM replaces three stochastic LLM order-classifiers; these tests assert it reproduces the
 * legacy 7-conjunct draft-order gate deterministically and that the retired asymmetries cannot
 * arise: consent is stage-gated (no `po`-in-a-complaint order), the new-order bypass is a
 * `confirmed`-stage precondition (I3 tightening), and there is no confidence field to flip (RC-07).
 * All pure/in-process — no network/DB/OpenAI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideOrderStage,
  detectNewOrderSignalLexical,
  detectOrderConsentLexical,
  normalizeStage,
  slotsComplete,
  type OrderSlots,
  type InboundSignals,
  type OrderStageEvent,
} from '../orderStageMachine';

const COMPLETE: OrderSlots = {
  hasProduct: true,
  hasAddress: true,
  hasPhone: true,
  hasName: true,
  isReadyToOrder: true,
  intentScorePasses: true,
};

const NO_SIGNALS: InboundSignals = {
  consentDetected: false,
  newOrderDetected: false,
  providesOrderDetails: false,
};

const inbound = (
  slots: OrderSlots,
  signals: Partial<InboundSignals> = {},
  orderClosingAsked = false,
): OrderStageEvent => ({
  kind: 'inbound',
  slots,
  signals: { ...NO_SIGNALS, ...signals },
  orderClosingAsked,
});

// ---------------------------------------------------------------------------
// slotsComplete
// ---------------------------------------------------------------------------
describe('slotsComplete', () => {
  it('is true when all six factual conjuncts are present', () => {
    assert.equal(slotsComplete(COMPLETE), true);
  });

  for (const key of Object.keys(COMPLETE) as (keyof OrderSlots)[]) {
    it(`is false when ${key} is missing`, () => {
      assert.equal(slotsComplete({ ...COMPLETE, [key]: false }), false);
    });
  }
});

// ---------------------------------------------------------------------------
// normalizeStage
// ---------------------------------------------------------------------------
describe('normalizeStage', () => {
  it('maps NULL/undefined/empty/unknown to browsing', () => {
    assert.equal(normalizeStage(null), 'browsing');
    assert.equal(normalizeStage(undefined), 'browsing');
    assert.equal(normalizeStage(''), 'browsing');
    assert.equal(normalizeStage('nonsense'), 'browsing');
  });
  it('round-trips a valid stored stage', () => {
    for (const s of ['browsing', 'collecting', 'awaiting_confirmation', 'confirmed'] as const) {
      assert.equal(normalizeStage(s), s);
    }
  });
});

// ---------------------------------------------------------------------------
// decideOrderStage — the create gate (7-conjunct reproduction)
// ---------------------------------------------------------------------------
describe('decideOrderStage: create gate', () => {
  it('awaiting + complete + consent -> confirmed, create', () => {
    const d = decideOrderStage('awaiting_confirmation', inbound(COMPLETE, { consentDetected: true }));
    assert.deepEqual(d, { nextStage: 'confirmed', shouldCreateOrder: true });
  });

  it('awaiting + complete + providesOrderDetails && orderClosingAsked -> create', () => {
    const d = decideOrderStage('awaiting_confirmation', inbound(COMPLETE, { providesOrderDetails: true }, true));
    assert.equal(d.shouldCreateOrder, true);
  });

  it('awaiting + complete + providesOrderDetails but NOT orderClosingAsked -> no create', () => {
    const d = decideOrderStage('awaiting_confirmation', inbound(COMPLETE, { providesOrderDetails: true }, false));
    assert.equal(d.shouldCreateOrder, false);
    assert.equal(d.nextStage, 'awaiting_confirmation');
  });

  it('awaiting + complete + no consent + no details -> no create, stays awaiting', () => {
    const d = decideOrderStage('awaiting_confirmation', inbound(COMPLETE));
    assert.deepEqual(d, { nextStage: 'awaiting_confirmation', shouldCreateOrder: false });
  });

  it('awaiting + INCOMPLETE + consent -> no create (slot gate wins)', () => {
    const d = decideOrderStage(
      'awaiting_confirmation',
      inbound({ ...COMPLETE, hasPhone: false }, { consentDetected: true }),
    );
    assert.equal(d.shouldCreateOrder, false);
  });

  it('browsing + complete + consent -> no create (po-in-a-complaint guard)', () => {
    const d = decideOrderStage('browsing', inbound(COMPLETE, { consentDetected: true }));
    assert.equal(d.shouldCreateOrder, false);
  });

  it('collecting + complete + consent -> no create (consent only in awaiting)', () => {
    const d = decideOrderStage('collecting', inbound(COMPLETE, { consentDetected: true }));
    assert.equal(d.shouldCreateOrder, false);
  });
});

// ---------------------------------------------------------------------------
// decideOrderStage — repeat order / I3 re-expression
// ---------------------------------------------------------------------------
describe('decideOrderStage: repeat order (I3)', () => {
  it('confirmed + complete + newOrderDetected -> confirmed, create', () => {
    const d = decideOrderStage('confirmed', inbound(COMPLETE, { newOrderDetected: true }));
    assert.deepEqual(d, { nextStage: 'confirmed', shouldCreateOrder: true });
  });

  it('confirmed + complete + NO newOrderDetected -> no create (duplicate-trigger suppressed)', () => {
    const d = decideOrderStage('confirmed', inbound(COMPLETE));
    assert.equal(d.shouldCreateOrder, false);
  });

  it('confirmed + incomplete + newOrderDetected -> no create, re-arms to collecting', () => {
    const d = decideOrderStage('confirmed', inbound({ ...COMPLETE, hasAddress: false }, { newOrderDetected: true }));
    assert.deepEqual(d, { nextStage: 'collecting', shouldCreateOrder: false });
  });

  it('browsing + complete + newOrderDetected (first-ever) -> NO create (I3 tightening)', () => {
    const d = decideOrderStage('browsing', inbound(COMPLETE, { newOrderDetected: true }));
    assert.equal(d.shouldCreateOrder, false);
  });
});

// ---------------------------------------------------------------------------
// decideOrderStage — collection advancement & lifecycle events
// ---------------------------------------------------------------------------
describe('decideOrderStage: advancement & lifecycle', () => {
  it('browsing + hasProduct (not ready) -> collecting', () => {
    const d = decideOrderStage('browsing', inbound({ ...COMPLETE, isReadyToOrder: false, intentScorePasses: false }));
    assert.equal(d.nextStage, 'collecting');
    assert.equal(d.shouldCreateOrder, false);
  });

  it('browsing + isReadyToOrder -> collecting', () => {
    const d = decideOrderStage(
      'browsing',
      inbound({ hasProduct: false, hasAddress: false, hasPhone: false, hasName: false, isReadyToOrder: true, intentScorePasses: false }),
    );
    assert.equal(d.nextStage, 'collecting');
  });

  it('browsing + nothing -> stays browsing', () => {
    const empty: OrderSlots = { hasProduct: false, hasAddress: false, hasPhone: false, hasName: false, isReadyToOrder: false, intentScorePasses: false };
    const d = decideOrderStage('browsing', inbound(empty));
    assert.deepEqual(d, { nextStage: 'browsing', shouldCreateOrder: false });
  });

  it('assistant_data_confirmation_sent: collecting -> awaiting; confirmed stays confirmed', () => {
    assert.equal(decideOrderStage('collecting', { kind: 'assistant_data_confirmation_sent' }).nextStage, 'awaiting_confirmation');
    assert.equal(decideOrderStage('confirmed', { kind: 'assistant_data_confirmation_sent' }).nextStage, 'confirmed');
  });

  it('assistant_order_closing_asked: browsing -> collecting; awaiting/confirmed unchanged', () => {
    assert.equal(decideOrderStage('browsing', { kind: 'assistant_order_closing_asked' }).nextStage, 'collecting');
    assert.equal(decideOrderStage('awaiting_confirmation', { kind: 'assistant_order_closing_asked' }).nextStage, 'awaiting_confirmation');
    assert.equal(decideOrderStage('confirmed', { kind: 'assistant_order_closing_asked' }).nextStage, 'confirmed');
  });

  it('order_created from any stage -> confirmed, no create', () => {
    for (const s of ['browsing', 'collecting', 'awaiting_confirmation', 'confirmed'] as const) {
      assert.deepEqual(decideOrderStage(s, { kind: 'order_created' }), { nextStage: 'confirmed', shouldCreateOrder: false });
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism: same (stage, event) -> identical decision N times
// ---------------------------------------------------------------------------
describe('decideOrderStage: determinism', () => {
  it('yields byte-identical decisions across 25 replays', () => {
    const event = inbound(COMPLETE, { consentDetected: true });
    const first = decideOrderStage('awaiting_confirmation', event);
    for (let i = 0; i < 25; i += 1) {
      assert.deepEqual(decideOrderStage('awaiting_confirmation', event), first);
    }
  });
});

// ---------------------------------------------------------------------------
// Consolidated lexicons — consent (Gheg) parity + new-order signal
// ---------------------------------------------------------------------------
describe('detectOrderConsentLexical', () => {
  for (const yes of ['po', 'ok', 'në rregull', 'mirë', 'dakord', 'pranoj', 'bone', 'veç bone', 'po beje', 'dua ta porosis', 'yes please order this']) {
    it(`recognizes consent: "${yes}"`, () => assert.equal(detectOrderConsentLexical(yes), true));
  }
  for (const no of ['nuk jam i kënaqur', 'kam një problem me porosinë e vjetër', 'sa kushton', 'faleminderit shumë']) {
    it(`does NOT treat as consent: "${no}"`, () => assert.equal(detectOrderConsentLexical(no), false));
  }
});

describe('detectNewOrderSignalLexical', () => {
  for (const yes of ['dua edhe një', 'porosi tjetër', 'nje tjeter', 'one more', 'order again']) {
    it(`recognizes new-order: "${yes}"`, () => assert.equal(detectNewOrderSignalLexical(yes), true));
  }
  for (const no of ['sa kushton', 'faleminderit', 'po']) {
    it(`does NOT treat as new-order: "${no}"`, () => assert.equal(detectNewOrderSignalLexical(no), false));
  }
});
