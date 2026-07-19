/**
 * P3-6 — the tier-downgrade comparator and its bar.
 *
 * This is the arithmetic that decides whether a cheaper model ships. It is pure and offline so
 * that decision never depends on a paid API call being reachable — the same reason
 * `shadowDiff.test.ts` exists beside `shadowReport.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTierReport, meetsTierBar, renderDecision, type TierCase } from '../tierComparison';

const c = (over: Partial<TierCase> & Pick<TierCase, 'id' | 'corpus'>): TierCase => ({
  baseline: { answerable: true },
  candidate: { answerable: true },
  ...over,
});

describe('renderDecision', () => {
  it('is key-order independent so structurally equal decisions compare equal', () => {
    assert.equal(renderDecision({ a: 1, b: 2 }), renderDecision({ b: 2, a: 1 }));
  });

  it('distinguishes a value from its string form', () => {
    // The `Object.is` lesson from shadowComparison: under coercion `1` and `'1'` would report
    // AGREE, hiding a genuine type divergence between two models' outputs.
    assert.notEqual(renderDecision({ x: 1 }), renderDecision({ x: '1' }));
  });
});

describe('buildTierReport', () => {
  it('scores agreement per corpus and overall', () => {
    const report = buildTierReport({
      role: 'classifier',
      baselineModel: 'gpt-4o',
      candidateModel: 'gpt-4o-mini',
      cases: [
        c({ id: 'A1', corpus: 'gheg' }),
        c({ id: 'A2', corpus: 'gheg', candidate: { answerable: false } }),
        c({ id: 'B1', corpus: 'gap_gate_true_gaps' }),
      ],
    });
    assert.equal(report.total, 3);
    assert.equal(report.agree, 2);
    // Floored, matching shadowDiff — a 99% bar must not be cleared by 98.6% rounding up.
    assert.equal(report.agreementPercent, 66);
    assert.equal(report.corpora.find((x) => x.corpus === 'gheg')!.agreementPercent, 50);
  });

  it('separates a REGRESSION from a mere disagreement', () => {
    const report = buildTierReport({
      role: 'classifier',
      baselineModel: 'gpt-4o',
      candidateModel: 'gpt-4o-mini',
      cases: [
        // Baseline right, candidate wrong ⇒ a real regression.
        c({
          id: 'R1',
          corpus: 'gap_gate_true_gaps',
          baseline: { answerable: false },
          candidate: { answerable: true },
          expected: { answerable: false },
        }),
        // Candidate right, baseline wrong ⇒ an improvement. Reported, never a licence to ship.
        c({
          id: 'I1',
          corpus: 'gap_gate_true_gaps',
          baseline: { answerable: true },
          candidate: { answerable: false },
          expected: { answerable: false },
        }),
      ],
    });
    const corpus = report.corpora[0];
    assert.equal(corpus.regressions, 1);
    assert.equal(corpus.improvements, 1);
    // Both disagree, so raw agreement is 0% — which is exactly why agreement alone cannot gate a
    // downgrade and the bar checks regressions separately.
    assert.equal(report.agreementPercent, 0);
  });

  it('computes the cost saving ratio', () => {
    const report = buildTierReport({
      role: 'classifier',
      baselineModel: 'gpt-4o',
      candidateModel: 'gpt-4o-mini',
      cases: [c({ id: 'A1', corpus: 'gheg' })],
      baselineUsd: 0.1,
      candidateUsd: 0.006,
    });
    assert.equal(report.cost.savingRatio, 0.94);
  });
});

describe('meetsTierBar', () => {
  const base = {
    role: 'classifier',
    baselineModel: 'gpt-4o',
    candidateModel: 'gpt-4o-mini',
  };
  const perfect = (n: number, corpus = 'gheg') =>
    buildTierReport({
      ...base,
      cases: Array.from({ length: n }, (_, i) => c({ id: `A${i}`, corpus })),
    });

  it('refuses a sample too small to be evidence', () => {
    // 100% agreement over 3 cases is not evidence — the same reasoning meetsCutoverBar records.
    const verdict = meetsTierBar(perfect(3), { minPercent: 98, minRows: 20 });
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /only 3 cases/);
  });

  it('passes a clean run over a sufficient sample', () => {
    assert.equal(meetsTierBar(perfect(50), { minPercent: 98, minRows: 20 }).pass, true);
  });

  it('fails a NON-DETERMINISTIC candidate regardless of its scores', () => {
    // RC-03's mechanism: a model that answers the same input differently across identical runs
    // makes every downstream guard judge each run differently. No price makes that acceptable.
    const report = { ...perfect(50), candidateDistinctRuns: 2 };
    const verdict = meetsTierBar(report, { minPercent: 98, minRows: 20 });
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /NON-DETERMINISTIC/);
  });

  it('fails on ANY regression in a zero-tolerance corpus, even at high agreement', () => {
    const cases: TierCase[] = [
      ...Array.from({ length: 99 }, (_, i) => c({ id: `A${i}`, corpus: 'gap_gate_true_gaps' })),
      c({
        id: 'BAD',
        corpus: 'gap_gate_true_gaps',
        baseline: { answerable: false },
        candidate: { answerable: true },
        expected: { answerable: false },
      }),
    ];
    const report = buildTierReport({ ...base, cases });
    assert.equal(report.agreementPercent, 99, 'agreement alone would clear a 98% bar');

    const verdict = meetsTierBar(report, {
      minPercent: 98,
      minRows: 20,
      zeroRegressionCorpora: ['gap_gate_true_gaps'],
    });
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /1 regression/);
  });

  it('applies the agreement floor once the hard gates pass', () => {
    const cases: TierCase[] = [
      ...Array.from({ length: 90 }, (_, i) => c({ id: `A${i}`, corpus: 'gheg' })),
      ...Array.from({ length: 10 }, (_, i) =>
        c({ id: `D${i}`, corpus: 'gheg', candidate: { answerable: false } }),
      ),
    ];
    const verdict = meetsTierBar(buildTierReport({ ...base, cases }), {
      minPercent: 98,
      minRows: 20,
    });
    assert.equal(verdict.pass, false);
    assert.match(verdict.reason, /90% < 98%/);
  });
});
