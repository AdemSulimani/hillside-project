/**
 * P3-4 GOLDEN SET — the gap gate (RC-01). THIS IS A RELEASE GATE.
 *
 * A failure here means an answerable catalog question would be escalated to a human and the
 * conversation paused with no automatic resume (RC-14) — the audit's dominant end-state, and the
 * single most expensive defect in the program. Do not skip a case to go green; fix the gate.
 *
 * THREE ASSERTIONS, IN ORDER OF WHAT THEY BUY:
 *
 *  1. INVARIANCE (the standing guard). Every answerable case is replayed N=20 times, each run
 *     drawing a DIFFERENT adversarial assessor output. The decision must not move. Note carefully:
 *     the N runs are N different stochastic draws, NOT N repetitions of one input — repeating a
 *     pure function proves nothing. See `harness/invariance.ts` for why the naming matters.
 *
 *  2. THE META-TEST (proof the gate bites). The remediation plan requires the harness to
 *     "reproduce the audit's findings … run against the pre-fix codebase → it CATCHES IN1/IN3 8/8
 *     escalation … then goes green against the end-state". Here that is done by replaying the
 *     audit's OWN recorded assessor outputs through both policies: the frozen pre-fix combiner must
 *     escalate 8/8, the shipped one 0/8. A harness that passes both ways is decoration.
 *
 *  3. TRUE GAPS (anti-vacuity). A gate that never escalates would ace assertion 1. Four cases with
 *     a genuinely absent structured attribute must still escalate.
 *
 * Offline: pure functions only, no DB, Redis, network, clock or OpenAI key. Reproducible by
 * construction — every draw comes from a seeded LCG, so three CI runs give identical pass/fail.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_RECORDED_DRAWS,
  decideOutcomeDeterministicFirst,
  decideOutcomeLegacy,
  drawAdversarialAssessment,
  type GapScenario,
} from '../../corpora/gapGatePolicies';
import {
  AUDIT_8_OF_8_CASE_IDS,
  GOLDEN_ANSWERABLE,
  GOLDEN_CORPUS,
  GOLDEN_TRUE_GAPS,
} from '../../corpora/goldenGapGate';
import type { GapGateCase } from '../../corpora/types';
import {
  countMatching,
  describeInvariance,
  replayUnderPerturbation,
} from '../../harness/invariance';
import { describeRate, findEscalations, rateOver, rateWithinPercent } from '../../harness/escalationRate';

const RUNS = 20; // the remediation plan's N≥20

/** Each case gets its OWN seed. A shared seed would replay one perturbation stream per case and
 *  silently narrow coverage to a fraction of what the run count advertises. */
const seedFor = (index: number): number => 0xc0ffee + index * 7919;

const scenarioFor = (c: GapGateCase): Omit<GapScenario, 'assessment'> => ({
  requested: c.requested,
  products: c.products,
  imageUsableKeys: new Set(c.imageUsableKeys ?? []),
  locale: c.locale,
});

// ---------------------------------------------------------------------------
// 1. INVARIANCE — the standing guard
// ---------------------------------------------------------------------------

describe('RC-01 golden set: answerable questions never escalate, on any assessor draw', () => {
  GOLDEN_ANSWERABLE.forEach((c, index) => {
    it(`${c.id} (${c.dialect}) — invariant across ${RUNS} adversarial draws: "${c.text.replace(/\n/g, ' / ')}"`, () => {
      const base = scenarioFor(c);
      const report = replayUnderPerturbation({
        runs: RUNS,
        seed: seedFor(index),
        perturb: (rng) => drawAdversarialAssessment(rng),
        decide: (assessment) => {
          const out = decideOutcomeDeterministicFirst({ ...base, assessment });
          // Compare on the DECISION, not the prose. RC-03's own edge case says to assert decision
          // class, never byte-identical text — hosted models are not bit-deterministic.
          return { escalated: out.escalated, status: out.status };
        },
      });

      assert.ok(report.stable, describeInvariance(c.id, report));
      assert.equal(
        countMatching(report, (o) => o.escalated),
        0,
        `${c.id}: an answerable question escalated. ${c.rationale}`,
      );
    });
  });

  it(`the whole answerable corpus escalates 0% (max-escalation-rate gate)`, () => {
    const outcomes = GOLDEN_ANSWERABLE.map((c, index) => {
      const base = scenarioFor(c);
      const report = replayUnderPerturbation({
        runs: RUNS,
        seed: seedFor(index),
        perturb: (rng) => drawAdversarialAssessment(rng),
        decide: (assessment) => decideOutcomeDeterministicFirst({ ...base, assessment }),
      });
      return { id: c.id, escalated: countMatching(report, (o) => o.escalated) > 0 };
    });

    const rate = rateOver(outcomes, (o) => o.escalated, (o) => o.id);
    // Deliberately 0, not a percentage: the audit measured 8/8 on two answerable inputs, so the
    // post-fix target is zero. A rate threshold here would absorb a real regression under the bar
    // AND make the gate's strictness a function of corpus size.
    assert.ok(rateWithinPercent(rate, 0), describeRate('answerable corpus', rate, 0));
  });
});

// ---------------------------------------------------------------------------
// 2. THE META-TEST — the harness must reproduce the audit
// ---------------------------------------------------------------------------

describe('RC-01 meta-test: the pre-fix policy reproduces the audit, the shipped one does not', () => {
  for (const id of AUDIT_8_OF_8_CASE_IDS) {
    const c = GOLDEN_ANSWERABLE.find((x) => x.id === id);

    it(`${id}: the corpus still carries the case (guard on the guard)`, () => {
      assert.ok(c, `${id} vanished from GOLDEN_ANSWERABLE — this meta-test would pass vacuously`);
      assert.ok(AUDIT_RECORDED_DRAWS[id], `no recorded draws for ${id}`);
      assert.equal(AUDIT_RECORDED_DRAWS[id].length, 8, 'the audit replayed each input exactly 8×');
    });

    it(`${id}: PRE-FIX policy escalates 8/8 — the audit's measured failure, reproduced`, () => {
      assert.ok(c);
      const base = scenarioFor(c);
      const escalations = AUDIT_RECORDED_DRAWS[id].filter(
        (assessment) => decideOutcomeLegacy({ ...base, assessment }).escalated,
      ).length;
      assert.equal(
        escalations,
        8,
        `expected the pre-fix gate to escalate 8/8 on ${id} (docs/audit/10-runtime-verification.md). ` +
          `Got ${escalations}/8. If this drops, the meta-test no longer proves the fix bites.`,
      );
    });

    it(`${id}: SHIPPED policy escalates 0/8 on those same draws`, () => {
      assert.ok(c);
      const base = scenarioFor(c);
      const escalations = AUDIT_RECORDED_DRAWS[id].filter(
        (assessment) => decideOutcomeDeterministicFirst({ ...base, assessment }).escalated,
      ).length;
      assert.equal(escalations, 0, `${id} still escalates under the deterministic-first gate`);
    });
  }

  it('the pre-fix policy is genuinely worse across the whole answerable corpus', () => {
    // Not a per-case number (the draws are sampled), but a corpus-level fact: the legacy policy
    // escalates a large share of answerable questions and the shipped one escalates none.
    let legacyEscalated = 0;
    let shippedEscalated = 0;
    GOLDEN_ANSWERABLE.forEach((c, index) => {
      const base = scenarioFor(c);
      const legacy = replayUnderPerturbation({
        runs: RUNS,
        seed: seedFor(index),
        perturb: (rng) => drawAdversarialAssessment(rng),
        decide: (assessment) => decideOutcomeLegacy({ ...base, assessment }),
      });
      const shipped = replayUnderPerturbation({
        runs: RUNS,
        seed: seedFor(index),
        perturb: (rng) => drawAdversarialAssessment(rng),
        decide: (assessment) => decideOutcomeDeterministicFirst({ ...base, assessment }),
      });
      legacyEscalated += countMatching(legacy, (o) => o.escalated);
      shippedEscalated += countMatching(shipped, (o) => o.escalated);
    });

    const total = GOLDEN_ANSWERABLE.length * RUNS;
    assert.equal(shippedEscalated, 0, 'the shipped gate escalated an answerable question');
    assert.ok(
      legacyEscalated > total / 2,
      `the pre-fix policy escalated only ${legacyEscalated}/${total} — too few for the meta-test to ` +
        'mean anything. Either the frozen legacy combiner drifted toward the fix, or the adversarial ' +
        'label set stopped resembling what the assessor actually emitted.',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. TRUE GAPS — anti-vacuity
// ---------------------------------------------------------------------------

describe('RC-01 anti-vacuity: a genuine gap still escalates', () => {
  GOLDEN_TRUE_GAPS.forEach((c, index) => {
    it(`${c.id} — escalates on every draw: ${c.rationale}`, () => {
      const base = scenarioFor(c);
      const report = replayUnderPerturbation({
        runs: RUNS,
        seed: seedFor(1000 + index),
        perturb: (rng) => drawAdversarialAssessment(rng),
        decide: (assessment) => ({
          escalated: decideOutcomeDeterministicFirst({ ...base, assessment }).escalated,
        }),
      });
      assert.ok(report.stable, describeInvariance(c.id, report));
      assert.equal(
        countMatching(report, (o) => o.escalated),
        RUNS,
        `${c.id}: a genuinely absent attribute was NOT escalated — the gate has gone fail-open`,
      );
    });
  });

  it('the corpus contains both outcome labels (a one-sided corpus proves nothing)', () => {
    const labels = new Set(GOLDEN_CORPUS.map((c) => c.expect));
    assert.deepEqual([...labels].sort(), ['answer', 'escalate']);
    assert.ok(GOLDEN_ANSWERABLE.length >= 18, `only ${GOLDEN_ANSWERABLE.length} answerable cases`);
    assert.ok(GOLDEN_TRUE_GAPS.length >= 4, `only ${GOLDEN_TRUE_GAPS.length} true-gap cases`);
  });

  it('covers all three dialect arms (RC-25: Gheg is where defects surface first)', () => {
    const dialects = new Set(GOLDEN_ANSWERABLE.map((c) => c.dialect));
    for (const d of ['standard', 'gheg', 'english']) {
      assert.ok(dialects.has(d as GapGateCase['dialect']), `no ${d} case in the answerable corpus`);
    }
    assert.ok(
      GOLDEN_ANSWERABLE.filter((c) => c.dialect === 'gheg').length >= 6,
      'the core market deserves more than a token Gheg case',
    );
  });
});

// ---------------------------------------------------------------------------
// Stability — the property that lets this be a release gate at all
// ---------------------------------------------------------------------------

describe('the golden set is reproducible (CI runs it 3× and requires identical pass/fail)', () => {
  it('replaying the same case twice yields byte-identical outcome sequences', () => {
    const c = GOLDEN_ANSWERABLE[0];
    const base = scenarioFor(c);
    const run = (): unknown =>
      replayUnderPerturbation({
        runs: RUNS,
        seed: seedFor(0),
        perturb: (rng) => drawAdversarialAssessment(rng),
        decide: (assessment) => decideOutcomeDeterministicFirst({ ...base, assessment }),
      }).outcomes;
    assert.deepEqual(run(), run());
  });

  it('the adversarial draws are not degenerate — the sweep really varies the assessor', () => {
    // If the sampler collapsed to one value, invariance would hold trivially and guard nothing.
    const seen = new Set<string>();
    const report = replayUnderPerturbation({
      runs: 200,
      seed: 1234,
      perturb: (rng) => drawAdversarialAssessment(rng),
      decide: (a) => {
        seen.add(JSON.stringify([a.ok, a.missing]));
        return a.ok;
      },
    });
    assert.equal(report.runs, 200);
    assert.ok(seen.size > 10, `only ${seen.size} distinct assessor outputs in 200 draws`);
  });
});
