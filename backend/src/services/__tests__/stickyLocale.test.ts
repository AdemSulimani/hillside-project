/**
 * Tests for the RC-10 sticky-locale hysteresis decision (P2-2, Slice C).
 *
 * The sticky slot must not flip the language on an ambiguous turn, but must honor a genuine
 * mid-conversation switch signalled by a high-confidence opposite-language marker. Pure — no DB/LLM.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStickyLocale } from '../stickyLocale';

describe('resolveStickyLocale', () => {
  it('reuses the sticky locale when the turn is ambiguous (no marker)', () => {
    assert.equal(resolveStickyLocale('sq', null), 'sq');
    assert.equal(resolveStickyLocale('en', null), 'en');
  });

  it('reuses the sticky locale when the marker agrees', () => {
    assert.equal(resolveStickyLocale('sq', 'sq'), 'sq');
    assert.equal(resolveStickyLocale('en', 'en'), 'en');
  });

  it('switches only on a high-confidence OPPOSITE marker (genuine mid-conversation switch)', () => {
    assert.equal(resolveStickyLocale('sq', 'en'), 'en');
    assert.equal(resolveStickyLocale('en', 'sq'), 'sq');
  });
});
