/**
 * P3-5 (RC-26, rules R4 + R16): the deterministic half of price intent.
 *
 * THE DEFECT, and why it is not the one the audit's R16 row proposes. Phase 7 offers two fixes for
 * R16 — extend the recommendation/comparison exclusion to price+attribute compounds, or "make the
 * assessor treat 'çmimi' as answerable-by-design (the rule's rationale is right: the catalog always
 * has the price)". The second is wrong on this codebase, and the reason is one line:
 *
 *     includePrice: customerAskedPrice || customerAskedDiscount        (aiService.ts)
 *
 * The catalog is injected WITHOUT price lines when price intent is missed. So on EV-010's compound
 * question the model genuinely had no price to state, and the fail-closed gap assessor reporting
 * `missing_info: ["çmimi"]` was TELLING THE TRUTH. Filtering price out of `missing_info` would
 * suppress a true signal and ship a reply that never answers the question. The defect is upstream:
 * the price word was in the customer's text, the keyword list already contained it, and nothing
 * consulted the list because the LLM classifier had already returned a confident `false`.
 *
 * These tests pin the lexical detector as a pure function. The union itself (classifier `false`
 * losing to a lexical `true`) is a one-line short-circuit in `customerAskedAboutPrice`, which is
 * unreachable without a network call — the suite has no mocking framework by design, so the
 * detector is what gets pinned, and the EV-010 case is asserted on it directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lexicallyAsksAboutPrice } from '../priceIntentLexicon';

describe('lexicallyAsksAboutPrice — the EV-010 regression', () => {
  it('detects the price half of the compound Gheg question the classifier missed', () => {
    // EV-010, alert dcf5c812 (2026-06-27): fired WITH the recommendation/comparison exclusion
    // already live, which is what proves the exclusion is not the fix. "sa kushtojn" is an
    // unambiguous price ask; `kushtojn` has been in the keyword list all along.
    assert.equal(lexicallyAsksAboutPrice('Me qfar shije i keni edhe sa kushtojn'), true);
  });

  it('detects the earlier EV-010 message too', () => {
    // alert 45247737 (2026-06-23), which predates the exclusion entirely.
    assert.equal(
      lexicallyAsksAboutPrice('sa kushton qikjo optium nutrition gold standart edhe qfar shije e ka'),
      true,
    );
  });
});

describe('lexicallyAsksAboutPrice — Albanian and Gheg forms', () => {
  for (const message of [
    'sa kushton?',
    'sa kushtojn?',
    'sa kushtojne kto?',
    'sa kushtoi?',
    'sa ben?',
    'cmimi?',
    'çmimi i ketij produkti?',
    'qmimi?',
    'sa eshte cmimi',
    'cili eshte me i lire?',
    'cila eshte me e shtrenjte?',
    'krahasim cmimesh',
  ]) {
    it(`detects "${message}"`, () => {
      assert.equal(lexicallyAsksAboutPrice(message), true);
    });
  }

  it('is diacritic-insensitive — çmim and cmim are the same ask', () => {
    assert.equal(lexicallyAsksAboutPrice('ÇMIMI?'), true);
    assert.equal(lexicallyAsksAboutPrice('cmimi?'), true);
  });
});

describe('lexicallyAsksAboutPrice — English and symbols', () => {
  for (const message of [
    'how much is this?',
    'what is the price?',
    'what does it cost?',
    'which is the cheapest?',
    'which is most expensive?',
    'is it under $50?',
    'do you have anything around €20?',
  ]) {
    it(`detects "${message}"`, () => {
      assert.equal(lexicallyAsksAboutPrice(message), true);
    });
  }
});

describe('lexicallyAsksAboutPrice — must not fire on non-price messages', () => {
  // The flag can only ADD prices to the catalog context, so a false positive here means
  // volunteering a price the customer never asked for — a direct R4/R5 violation
  // ("price only when explicitly asked", "no stock/price volunteering").
  for (const message of [
    'a keni proteina?',
    'me qfar shije i keni?',
    'kur vjen porosia?',
    'do you have whey protein?',
    'what flavours are available?',
    'is this in stock?',
    'faleminderit!',
    '',
    '   ',
  ]) {
    it(`does not fire on "${message}"`, () => {
      assert.equal(lexicallyAsksAboutPrice(message), false);
    });
  }
});

describe('lexicallyAsksAboutPrice — contract', () => {
  it('never throws on odd input', () => {
    assert.doesNotThrow(() => lexicallyAsksAboutPrice(undefined as unknown as string));
    assert.doesNotThrow(() => lexicallyAsksAboutPrice(null as unknown as string));
  });

  it('is pure — same input, same answer', () => {
    const m = 'sa kushton kjo?';
    assert.equal(lexicallyAsksAboutPrice(m), lexicallyAsksAboutPrice(m));
  });
});
