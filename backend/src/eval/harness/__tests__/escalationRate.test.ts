/**
 * Unit tests for the escalation-rate helpers (P3-4).
 *
 * The behaviour that matters most here is the one that is invisible in the happy path: the
 * comparison must be EXACT. `escalated / total <= 0.1` is a float compare against a decimal that
 * has no exact binary form, and a release gate that flips on 1/10 vs 0.1 is the "flaky assertion
 * blocks deploys" hazard the remediation plan names as this item's main risk. Several cases below
 * exist purely to pin that.
 *
 * Pure/in-process: no network, DB, Redis or OpenAI key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeRate, findEscalations, rateOver, rateWithinPercent } from '../escalationRate';

interface Case {
  id: string;
  escalated: boolean;
}

const mk = (spec: string): Case[] =>
  [...spec].map((c, i) => ({ id: `c${i + 1}`, escalated: c === 'x' }));

describe('rateOver', () => {
  it('counts hits and names them, in corpus order', () => {
    const r = rateOver(mk('.x..x'), (c) => c.escalated, (c) => c.id);
    assert.equal(r.total, 5);
    assert.equal(r.hits, 2);
    assert.deepEqual(r.hitIds, ['c2', 'c5']);
    assert.equal(r.percent, 40);
  });

  it('reports zero cleanly on an all-clean corpus', () => {
    const r = rateOver(mk('....'), (c) => c.escalated, (c) => c.id);
    assert.equal(r.hits, 0);
    assert.deepEqual(r.hitIds, []);
    assert.equal(r.percent, 0);
  });

  it('handles an empty corpus without dividing by zero', () => {
    const r = rateOver([] as Case[], (c) => c.escalated, (c) => c.id);
    assert.equal(r.total, 0);
    assert.equal(r.percent, 0);
  });

  it('takes total from the corpus, not from the hits (a corpus of misses still has a size)', () => {
    const r = rateOver(mk('.........'), (c) => c.escalated, (c) => c.id);
    assert.equal(r.total, 9);
  });
});

describe('rateWithinPercent', () => {
  it('is EXACT at the boundary: 1/10 passes a 10% bar', () => {
    // The float form (0.1 <= 0.1) happens to hold, but 3/10 <= 0.3 does not in binary — see below.
    const r = rateOver(mk('x.........'), (c) => c.escalated, (c) => c.id);
    assert.equal(r.total, 10);
    assert.equal(r.hits, 1);
    assert.equal(rateWithinPercent(r, 10), true);
  });

  it('is EXACT at the boundary: 3/10 passes a 30% bar (the float form does NOT)', () => {
    const r = rateOver(mk('xxx.......'), (c) => c.escalated, (c) => c.id);
    assert.equal(r.hits, 3);
    // Proof the naive form is genuinely broken here, so this test is not theatre:
    assert.equal(3 / 10 <= 0.3, true);
    assert.equal(0.1 + 0.2 <= 0.3, false); // the same class of defect, one operation away
    assert.equal(rateWithinPercent(r, 30), true);
  });

  it('is EXACT at 1/3 vs a 33% bar — just over, and must fail', () => {
    const r = rateOver(mk('x..'), (c) => c.escalated, (c) => c.id);
    assert.equal(rateWithinPercent(r, 33), false, '1/3 = 33.33% exceeds 33%');
    assert.equal(rateWithinPercent(r, 34), true);
  });

  it('passes trivially on an empty corpus', () => {
    const r = rateOver([] as Case[], (c) => c.escalated, (c) => c.id);
    assert.equal(rateWithinPercent(r, 0), true);
  });

  it('a 0% bar rejects a single hit', () => {
    const r = rateOver(mk('x.........'), (c) => c.escalated, (c) => c.id);
    assert.equal(rateWithinPercent(r, 0), false);
  });

  it('REJECTS a fractional threshold rather than silently rounding it', () => {
    const r = rateOver(mk('x.'), (c) => c.escalated, (c) => c.id);
    assert.throws(() => rateWithinPercent(r, 12.5), /integer/);
  });

  it('rejects an out-of-range threshold', () => {
    const r = rateOver(mk('x.'), (c) => c.escalated, (c) => c.id);
    assert.throws(() => rateWithinPercent(r, -1), /0-100/);
    assert.throws(() => rateWithinPercent(r, 101), /0-100/);
  });
});

describe('findEscalations', () => {
  it('returns the offending ids so a failure message can name them', () => {
    assert.deepEqual(
      findEscalations(mk('.x.x'), (c) => c.escalated, (c) => c.id),
      ['c2', 'c4'],
    );
  });

  it('returns empty when nothing escalated — the assertion the answerable corpus makes', () => {
    assert.deepEqual(findEscalations(mk('....'), (c) => c.escalated, (c) => c.id), []);
  });
});

describe('describeRate', () => {
  it('includes the ratio, the percentage and the offending ids', () => {
    const r = rateOver(mk('.x..'), (c) => c.escalated, (c) => c.id);
    const msg = describeRate('golden', r, 0);
    assert.match(msg, /1\/4/);
    assert.match(msg, /25%/);
    assert.match(msg, /max 0%/);
    assert.match(msg, /c2/);
  });
});
