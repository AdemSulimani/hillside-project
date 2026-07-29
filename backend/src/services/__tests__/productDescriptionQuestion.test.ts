/**
 * isProductDescriptionQuestion — the deterministic detector that (a) selects the full
 * description mode for the prompt and (b) since the 2026-07-29 follow-up-routing fixes,
 * routes description/ingredient follow-ups through the discussed-products resolver in
 * `needsContextualResolver` (aiService). A missed phrasing here means a fresh fusion
 * search over stopword tokens and a gap-check judged against the wrong products.
 *
 * Pure: imports only productDescriptionPromptService (no OpenAI client).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isProductDescriptionQuestion } from '../productDescriptionPromptService';

describe('isProductDescriptionQuestion — Albanian/Gheg composition and purpose phrasings', () => {
  it('matches the bare follow-up forms live traffic uses', () => {
    for (const message of [
      'Qfar permban?',
      'Cfare permban ky produkt?',
      'Per qfare sherben?',
      'Nga cfare perbehet?',
      'Cka ka brenda?',
      'Qka ka brenda ky produkt?',
      'A permban sheqer?',
    ]) {
      assert.equal(isProductDescriptionQuestion(message), true, message);
    }
  });

  it('still matches the pre-existing English and Albanian forms', () => {
    for (const message of [
      'What is it made of?',
      'Tell me more about it',
      'Cfare eshte?',
      'A ka perberes natyral?',
    ]) {
      assert.equal(isProductDescriptionQuestion(message), true, message);
    }
  });

  it('does not match availability, price, or recommendation questions', () => {
    for (const message of [
      'A keni bsn creatine vlla edhe sa kushton',
      'Sa kushton Carbo one 1kg Limon?',
      'Cilen me sugjeron ti?',
      'A ka najfar shije a jo',
    ]) {
      assert.equal(isProductDescriptionQuestion(message), false, message);
    }
  });
});
