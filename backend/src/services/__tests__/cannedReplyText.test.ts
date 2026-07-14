/**
 * P2-3 (RC-16) tests for the shared canned-reply constants + the `isCannedHoldingCopy` classifier.
 * Pure — no DB / Redis / LLM (ReplyLocale is a type-only import, so this does not load aiService).
 * Confirms every canned holding/escalation/procedural message is recognised (so the transcript maps
 * it to `system`) and a genuine sales reply is not (no false-positive).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_CONFIRMATION_MESSAGES,
  HOLDING_MESSAGES,
  MISSING_CUSTOMER_NAME_MESSAGES,
  isCannedHoldingCopy,
  normalizeCannedText,
} from '../cannedReplyText';

describe('isCannedHoldingCopy', () => {
  it('recognises every HOLDING_MESSAGES value in each locale', () => {
    for (const locale of ['sq', 'en'] as const) {
      for (const text of Object.values(HOLDING_MESSAGES[locale])) {
        assert.equal(isCannedHoldingCopy(text), true, `holding: ${text}`);
      }
    }
  });

  it('recognises the data-confirmation and missing-name prompts in each locale', () => {
    for (const locale of ['sq', 'en'] as const) {
      assert.equal(isCannedHoldingCopy(DATA_CONFIRMATION_MESSAGES[locale]), true);
      assert.equal(isCannedHoldingCopy(MISSING_CUSTOMER_NAME_MESSAGES[locale]), true);
    }
  });

  it('is robust to diacritics / whitespace / case (normalized match)', () => {
    const original = HOLDING_MESSAGES.sq.usageEscalation;
    const mangled = `  ${original.toUpperCase().replace(/ë/gi, 'e').replace(/ç/gi, 'c')}\n`;
    assert.equal(isCannedHoldingCopy(mangled), true);
  });

  it('recognises the legacy verbatim usage-escalation variant', () => {
    assert.equal(
      isCannedHoldingCopy("Pershendetje, se shpejti do t'ju kontaktoje nje specialist lidhur me kete ceshtje."),
      true,
    );
  });

  it('does NOT match a genuine sales reply (no false positive)', () => {
    assert.equal(isCannedHoldingCopy('Sigurisht! Proteina 50 servings kushton €25. A doni ta porosisni?'), false);
    assert.equal(isCannedHoldingCopy('Yes, the vanilla protein is in stock at €25.'), false);
  });

  it('returns false for empty / whitespace', () => {
    assert.equal(isCannedHoldingCopy(''), false);
    assert.equal(isCannedHoldingCopy('   '), false);
  });

  it('normalizeCannedText folds diacritics and collapses whitespace', () => {
    assert.equal(normalizeCannedText('  Çështje   ËË  '), 'ceshtje ee');
  });
});
