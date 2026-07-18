/**
 * Tests for the generic shadow-comparison recorder (P3-4).
 *
 * THE CENTRAL ASSERTION is the byte-identical one. `processAIReply.ts` used to build its
 * order-stage branch strings inline; P3-4 replaced that with `buildShadowBranch` so P3-1's ~20
 * classifier cutovers share one idiom. That refactor is only safe if the emitted string is
 * unchanged — historical `ai_decision_ledger` rows carry the old encoding, and a report that
 * silently stops parsing them would lose exactly the provenance P1-5 exists to preserve. The
 * literals below are what the inline code produced, transcribed by hand from it.
 *
 * Pure/in-process: no network, DB, Redis or OpenAI key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildShadowBranch, resolveShadowValue } from '../shadowComparison';
import { parseShadowBranch } from '../../eval/harness/shadowDiff';

describe('buildShadowBranch reproduces the order_stage encoding EXACTLY', () => {
  it('agree — matches the inline `agree:${fsm}:stage=${effectiveStage}` form', () => {
    const out = buildShadowBranch({
      classifier: 'order_stage',
      legacy: true,
      deterministic: true,
      context: { stage: 'awaiting_confirmation' },
    });
    assert.equal(out.agree, true);
    assert.equal(out.branch, 'agree:true:stage=awaiting_confirmation');
    assert.equal(out.passed, true);
  });

  it('agree on false — the encoding carries the value, not just "they matched"', () => {
    const out = buildShadowBranch({
      classifier: 'order_stage',
      legacy: false,
      deterministic: false,
      context: { stage: 'collecting' },
    });
    assert.equal(out.branch, 'agree:false:stage=collecting');
    assert.equal(out.passed, false);
  });

  it('diverge — matches the inline `diverge:legacy=X:det=Y:stage=Z` form', () => {
    const out = buildShadowBranch({
      classifier: 'order_stage',
      legacy: false,
      deterministic: true,
      context: { stage: 'collecting' },
    });
    assert.equal(out.agree, false);
    assert.equal(out.branch, 'diverge:legacy=false:det=true:stage=collecting');
    assert.equal(out.passed, true, 'passed reports the DETERMINISTIC verdict');
  });

  it('the reverse divergence', () => {
    const out = buildShadowBranch({
      classifier: 'order_stage',
      legacy: true,
      deterministic: false,
      context: { stage: 'idle' },
    });
    assert.equal(out.branch, 'diverge:legacy=true:det=false:stage=idle');
  });
});

describe('encoding rules', () => {
  it('omits the context suffix entirely when there is none', () => {
    assert.equal(buildShadowBranch({ classifier: 'c', legacy: 1, deterministic: 1 }).branch, 'agree:1');
  });

  it('sorts context keys — insertion order must not leak into the ledger', () => {
    const a = buildShadowBranch({
      classifier: 'c',
      legacy: 'x',
      deterministic: 'x',
      context: { zeta: 1, alpha: 2 },
    });
    const b = buildShadowBranch({
      classifier: 'c',
      legacy: 'x',
      deterministic: 'x',
      context: { alpha: 2, zeta: 1 },
    });
    assert.equal(a.branch, b.branch);
    assert.equal(a.branch, 'agree:x:alpha=2:zeta=1');
  });

  it('compares by VALUE, so 1 and "1" DIVERGE (a type mismatch is a real divergence)', () => {
    // Coercion would report agreement here and hide exactly what a shadow window exists to catch:
    // a deterministic replacement whose verdict differs in type from the classifier it replaces.
    const out = buildShadowBranch<unknown>({ classifier: 'c', legacy: 1, deterministic: '1' });
    assert.equal(out.agree, false);
    assert.equal(out.branch, 'diverge:legacy=1:det=1');
  });

  it('passed is a strict boolean check — Boolean("false") must not report true', () => {
    // `decision_events.passed` is a boolean verdict; reporting the opposite of the deterministic
    // decision would be worse than reporting nothing.
    assert.equal(buildShadowBranch<unknown>({ classifier: 'c', legacy: 'false', deterministic: 'false' }).passed, false);
    assert.equal(buildShadowBranch({ classifier: 'c', legacy: true, deterministic: true }).passed, true);
    assert.equal(buildShadowBranch({ classifier: 'c', legacy: false, deterministic: false }).passed, false);
  });

  it('REJECTS a reserved context key rather than emitting an ambiguous branch', () => {
    // `legacy=`/`det=` encode the comparison; reusing them would make the string unparseable.
    for (const key of ['legacy', 'det']) {
      assert.throws(
        () => buildShadowBranch({ classifier: 'c', legacy: 1, deterministic: 2, context: { [key]: 'x' } }),
        /reserved/,
        `context key "${key}" should be rejected`,
      );
    }
  });
});

describe('round-trip: what the producer writes, the reader parses', () => {
  const cases: Array<{
    legacy: unknown;
    deterministic: unknown;
    context?: Record<string, string | number | boolean>;
  }> = [
    { legacy: true, deterministic: true, context: { stage: 'awaiting_confirmation' } },
    { legacy: false, deterministic: true, context: { stage: 'collecting' } },
    { legacy: 'a', deterministic: 'b', context: { stage: 'x', locale: 'sq' } },
    { legacy: 1, deterministic: 1 },
  ];

  for (const c of cases) {
    it(`${JSON.stringify(c)}`, () => {
      const out = buildShadowBranch<unknown>({ classifier: 'c', ...c });
      const parsed = parseShadowBranch(out.branch);
      assert.equal(parsed.kind, out.agree ? 'agree' : 'diverge');
      if (out.agree) {
        assert.equal(parsed.value, String(c.deterministic));
      } else {
        assert.equal(parsed.legacy, String(c.legacy));
        assert.equal(parsed.deterministic, String(c.deterministic));
      }
      for (const [k, v] of Object.entries(c.context ?? {})) {
        assert.equal(parsed.context[k], String(v));
      }
    });
  }
});

describe('resolveShadowValue', () => {
  it('off and shadow both keep the LEGACY value — that is what makes a shadow window safe', () => {
    assert.equal(resolveShadowValue('off', 'legacy', 'det'), 'legacy');
    assert.equal(resolveShadowValue('shadow', 'legacy', 'det'), 'legacy');
  });

  it('on hands over to the deterministic value', () => {
    assert.equal(resolveShadowValue('on', 'legacy', 'det'), 'det');
  });

  it('mirrors the live order_stage line: mode === "on" ? fsm : legacy', () => {
    const legacy = false;
    const fsm = true;
    assert.equal(resolveShadowValue('shadow', legacy, fsm), legacy);
    assert.equal(resolveShadowValue('on', legacy, fsm), fsm);
  });
});
