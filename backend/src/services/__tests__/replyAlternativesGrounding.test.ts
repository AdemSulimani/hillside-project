/**
 * P3-5 (RC-25/RC-26, rules R6/R13): the uncertain-answer guard's catalog-grounded carve-out.
 *
 * THE AUDITED DEFECT, reproduced then fixed. `processAIReply` passed
 * `hasMatchingProductsInContext: matchedProducts.length > 0` — THIS TURN's retrieval window —
 * into `shouldEscalateUncertainAnswer`, while the guard's own doc comment states the intent as
 * "the catalog context contained matching alternatives". The two diverge exactly when retrieval
 * misses, and the consequence is that a reply the PROMPT MANDATES gets replaced by a holding
 * message and the conversation paused with no automatic exit:
 *
 *   R6  "If a product is not available in the catalog, clearly state that it is not available."
 *   R13 "...clearly state that it is unavailable and suggest 2-3 alternatives from the same category."
 *
 * The tests below hold the reply and the catalog fixed and vary ONLY the reference set, which is
 * what isolates the defect from every other input to the guard.
 *
 * The second half pins `replyNamesActiveCatalogProduct`'s over-match guards. That predicate is a
 * deliberate SIBLING of `nameMatchesCatalogIndex`, not a reuse: the latter's
 * `CONTAINMENT_MIN_LENGTH = 4` is calibrated for a short suspected name, and applying it to a
 * whole reply over a large catalog resurrects the `%shije%` class P2-5 documented (an unanchored
 * substring matching 46/257 rows).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { replyNamesActiveCatalogProduct } from '../catalogGuardReferenceService';
import { shouldEscalateUncertainAnswer } from '../uncertainAnswerFallbackGuard';

/** A realistic Albanian supplement catalog, in the shape of the live dev tenant. */
const CATALOG = [
  'Mega Mass 3kg Vanilje',
  'Carbo One 1kg me shije limon',
  'Whey',
  'Kafe',
  'Creatine Monohydrate 300g',
  'Protein Bar Çokollatë',
];

/** R13-compliant: says the asked-for item is unavailable, then offers real catalog products. */
const R13_COMPLIANT_REPLY =
  'Na vjen keq, nuk e kemi atë produkt. Mund t’ju ofrojmë Mega Mass 3kg Vanilje ose ' +
  'Carbo One 1kg me shije limon.';

/** A bare deflection: unavailable, no alternative named. */
const BARE_DEFLECTION = 'Na vjen keq, nuk e kemi atë produkt.';

function decide(over: {
  hasMatchingProductsInContext: boolean;
  replyText?: string;
}): boolean {
  return shouldEscalateUncertainAnswer({
    replyText: over.replyText ?? R13_COMPLIANT_REPLY,
    enabled: true,
    alreadyEscalated: false,
    isOosCannedReply: false,
    isOrderFlowReply: false,
    negativeAvailabilityDetected: true,
    hasMatchingProductsInContext: over.hasMatchingProductsInContext,
  });
}

describe('R6/R13 — the retrieval-window defect', () => {
  it('REPRODUCES it: an empty window escalates the reply the rules mandate', () => {
    // Flag-off / pre-P3-5: `matchedProducts.length > 0` is false because retrieval missed, so a
    // correct, catalog-grounded, rule-compliant reply becomes a holding message + a pause.
    assert.equal(decide({ hasMatchingProductsInContext: false }), true);
  });

  it('FIXES it: the same reply is not escalated once the reference set is the catalog', () => {
    const namedRealProduct = replyNamesActiveCatalogProduct(R13_COMPLIANT_REPLY, CATALOG);
    assert.equal(namedRealProduct, true, 'the reply names two real active products');
    // This is the exact expression processAIReply now passes:
    //   matchedProducts.length > 0 || replyNamedRealProduct
    assert.equal(decide({ hasMatchingProductsInContext: false || namedRealProduct }), false);
  });

  it('a populated window still suppresses, unchanged from before', () => {
    assert.equal(decide({ hasMatchingProductsInContext: true }), false);
  });

  it('PRESERVES the lane: a bare deflection naming nothing still escalates', () => {
    // The widening must not delete the guard. This is the reply the guard exists for.
    const namedRealProduct = replyNamesActiveCatalogProduct(BARE_DEFLECTION, CATALOG);
    assert.equal(namedRealProduct, false);
    assert.equal(decide({ replyText: BARE_DEFLECTION, hasMatchingProductsInContext: namedRealProduct }), true);
  });

  it('the carve-out cannot suppress a generic uncertainty deflection', () => {
    // `hasMatchingProductsInContext` gates only the negative-availability branch — an "I don't
    // know" reply routes independently, so no amount of catalog grounding silences it.
    assert.equal(
      shouldEscalateUncertainAnswer({
        replyText: 'Nuk kam informacion për këtë.',
        enabled: true,
        alreadyEscalated: false,
        isOosCannedReply: false,
        isOrderFlowReply: false,
        negativeAvailabilityDetected: false,
        hasMatchingProductsInContext: true,
      }),
      true,
    );
  });
});

describe('replyNamesActiveCatalogProduct — over-match guards', () => {
  it('matches a multi-token catalog title mentioned in the reply', () => {
    assert.equal(replyNamesActiveCatalogProduct('Kemi Mega Mass 3kg Vanilje.', CATALOG), true);
  });

  it('matches a long single-token name', () => {
    assert.equal(replyNamesActiveCatalogProduct('Provoni Creatine Monohydrate 300g.', CATALOG), true);
  });

  it('IGNORES short single-token catalog names in ordinary prose', () => {
    // "Whey" and "Kafe" are real catalog rows AND ordinary words. A 4-char containment rule would
    // rescue both of these replies, silencing a genuine deflection — the %shije% failure mode.
    assert.equal(replyNamesActiveCatalogProduct('Nuk kemi whey në stok.', CATALOG), false);
    assert.equal(replyNamesActiveCatalogProduct('Nuk kemi kafe.', CATALOG), false);
  });

  it('respects word boundaries — a name inside a longer word does not count', () => {
    const catalog = ['Massive Gainer'];
    assert.equal(replyNamesActiveCatalogProduct('Kjo është massively e mirë.', catalog), false);
    assert.equal(replyNamesActiveCatalogProduct('Kemi Massive Gainer.', catalog), true);
  });

  it('is diacritic- and case-insensitive (Albanian titles)', () => {
    assert.equal(replyNamesActiveCatalogProduct('kemi protein bar cokollate', CATALOG), true);
    assert.equal(replyNamesActiveCatalogProduct('KEMI PROTEIN BAR ÇOKOLLATË', CATALOG), true);
  });

  it('tolerates punctuation between and around the name', () => {
    assert.equal(replyNamesActiveCatalogProduct('Alternativa: "Mega Mass 3kg Vanilje".', CATALOG), true);
  });

  it('is false for an empty reply, an empty catalog, or blank catalog rows', () => {
    assert.equal(replyNamesActiveCatalogProduct('', CATALOG), false);
    assert.equal(replyNamesActiveCatalogProduct('   ', CATALOG), false);
    assert.equal(replyNamesActiveCatalogProduct(R13_COMPLIANT_REPLY, []), false);
    assert.equal(replyNamesActiveCatalogProduct(R13_COMPLIANT_REPLY, ['', '  ']), false);
  });

  it('does not match a product the reply never names', () => {
    assert.equal(
      replyNamesActiveCatalogProduct('Na vjen keq, provoni një dyqan tjetër.', CATALOG),
      false,
    );
  });
});
