/**
 * Unit tests for the invariance comparator (P3-4).
 *
 * The remediation plan asks for these explicitly — "Unit: assertion helpers (determinism
 * comparator, token-membership, escalation-rate)" — and for a good reason: every golden suite
 * reports through these helpers, so a bug here makes an entire release gate lie in whichever
 * direction the bug points.
 *
 * Pure/in-process: no network, DB, Redis or OpenAI key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countMatching,
  describeInvariance,
  makeSeededRng,
  replayUnderPerturbation,
  rngInt,
  rngPick,
  stableKey,
} from '../invariance';

describe('makeSeededRng', () => {
  it('is reproducible: the same seed yields the same stream', () => {
    const a = makeSeededRng(42);
    const b = makeSeededRng(42);
    const seqA = Array.from({ length: 25 }, () => a());
    const seqB = Array.from({ length: 25 }, () => b());
    assert.deepEqual(seqA, seqB);
  });

  it('different seeds yield different streams', () => {
    const a = makeSeededRng(1);
    const b = makeSeededRng(2);
    assert.notDeepEqual(
      Array.from({ length: 10 }, () => a()),
      Array.from({ length: 10 }, () => b()),
    );
  });

  it('stays in [0, 1)', () => {
    const rng = makeSeededRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
    }
  });

  it('does not collapse to a constant (the LCG is actually mixing)', () => {
    const rng = makeSeededRng(3);
    const distinct = new Set(Array.from({ length: 200 }, () => rng()));
    assert.ok(distinct.size > 150, `only ${distinct.size} distinct draws in 200`);
  });
});

describe('rngInt / rngPick', () => {
  it('rngInt stays within bounds', () => {
    const rng = makeSeededRng(11);
    for (let i = 0; i < 500; i++) {
      const v = rngInt(rng, 5);
      assert.ok(Number.isInteger(v) && v >= 0 && v < 5, `bad draw ${v}`);
    }
  });

  it('rngPick only ever returns members of the list', () => {
    const rng = makeSeededRng(13);
    const items = ['a', 'b', 'c'];
    for (let i = 0; i < 100; i++) assert.ok(items.includes(rngPick(rng, items)));
  });

  it('rngPick THROWS on an empty list rather than yielding undefined behind a T annotation', () => {
    // A corpus drawing `undefined` would still produce a green invariance sweep — stable because
    // nothing was perturbed. That is a gate that has stopped guarding, and it must be loud.
    assert.throws(() => rngPick(makeSeededRng(1), []), /empty list/);
  });
});

describe('stableKey', () => {
  it('is insensitive to object key order (the iteration-order flake class)', () => {
    assert.equal(stableKey({ a: 1, b: 2 }), stableKey({ b: 2, a: 1 }));
  });

  it('is SENSITIVE to array order (element order is a real difference)', () => {
    assert.notEqual(stableKey([1, 2]), stableKey([2, 1]));
  });

  it('distinguishes genuinely different values', () => {
    assert.notEqual(stableKey({ escalated: true }), stableKey({ escalated: false }));
  });

  it('handles nesting and null without throwing', () => {
    assert.equal(stableKey({ x: { b: null, a: [1, { z: 1, y: 2 }] } }), stableKey({ x: { a: [1, { y: 2, z: 1 }] , b: null } }));
  });

  it('survives a cycle rather than blowing the stack', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    assert.ok(stableKey(cyclic).includes('__cycle__'));
  });
});

describe('replayUnderPerturbation', () => {
  it('reports stable when the decision ignores the perturbation', () => {
    const report = replayUnderPerturbation({
      runs: 20,
      seed: 1,
      perturb: (rng) => rng(),
      decide: () => ({ escalated: false }),
    });
    assert.equal(report.runs, 20);
    assert.equal(report.stable, true);
    assert.equal(report.distinct.length, 1);
    assert.equal(report.firstDivergenceRun, null);
  });

  it('reports UNSTABLE and names the run when the decision follows the perturbation', () => {
    const report = replayUnderPerturbation({
      runs: 20,
      seed: 1,
      perturb: (_rng, run) => run,
      decide: (run) => ({ escalated: run >= 3 }),
    });
    assert.equal(report.stable, false);
    assert.equal(report.distinct.length, 2);
    assert.equal(report.firstDivergenceRun, 4, 'run index is 1-based');
  });

  it('is itself reproducible: the same seed gives the same outcome sequence', () => {
    const build = (): unknown[] =>
      replayUnderPerturbation({
        runs: 30,
        seed: 0xc0ffee,
        perturb: (rng) => rng() < 0.5,
        decide: (flip) => ({ flip }),
      }).outcomes;
    assert.deepEqual(build(), build());
  });

  it('a different seed genuinely changes the draws (the seed is wired through)', () => {
    const outcomes = (seed: number): unknown[] =>
      replayUnderPerturbation({
        runs: 30,
        seed,
        perturb: (rng) => rng(),
        decide: (v) => ({ v }),
      }).outcomes;
    assert.notDeepEqual(outcomes(1), outcomes(2));
  });

  it('honours a custom comparison key', () => {
    // Outcomes differ in a field the key ignores → still "stable".
    const report = replayUnderPerturbation({
      runs: 10,
      seed: 5,
      perturb: (_rng, run) => run,
      decide: (run) => ({ escalated: false, noise: run }),
      key: (o) => String(o.escalated),
    });
    assert.equal(report.stable, true);
  });
});

describe('countMatching', () => {
  it('counts only the runs satisfying the predicate', () => {
    const report = replayUnderPerturbation({
      runs: 10,
      seed: 2,
      perturb: (_rng, run) => run,
      decide: (run) => ({ escalated: run % 2 === 0 }),
    });
    assert.equal(countMatching(report, (o) => o.escalated), 5);
  });
});

describe('describeInvariance', () => {
  it('says "stable" without listing anything when nothing moved', () => {
    const report = replayUnderPerturbation({
      runs: 3,
      seed: 1,
      perturb: () => 0,
      decide: () => 'same',
    });
    assert.match(describeInvariance('case', report), /stable across 3 draws/);
  });

  it('names the divergence run and shows the distinct outcomes (the message must be actionable)', () => {
    const report = replayUnderPerturbation({
      runs: 4,
      seed: 1,
      perturb: (_rng, run) => run,
      decide: (run) => (run === 0 ? 'answer' : 'escalate'),
    });
    const msg = describeInvariance('IN1', report);
    assert.match(msg, /IN1/);
    assert.match(msg, /first divergence at run 2/);
    assert.match(msg, /answer/);
    assert.match(msg, /escalate/);
  });
});
