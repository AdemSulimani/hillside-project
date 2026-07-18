/**
 * P3-4 — corpus hygiene.
 *
 * WHY A TEST AND NOT A CONVENTION. The remediation plan names "false confidence" as this item's
 * main hazard: "the harness only guards what it encodes." The two ways a corpus quietly stops
 * guarding are both mechanical, so both get a mechanical check:
 *
 *   1. IT SHRINKS. Someone deletes a case to go green, and the gate keeps passing with less
 *      coverage. Sizes are pinned; growing a corpus requires updating the floor deliberately.
 *   2. IT LOSES PROVENANCE. A case with no `source` is a magic string nobody dares change and
 *      eventually deletes. Every case must cite the evidence it came from.
 *
 * The convention is inherited from `eval/ghegFluency/corpus.ts` (P2-5), which pinned exactly this.
 *
 * Offline: reads corpus modules only. No DB, Redis, network or OpenAI key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GOLDEN_ANSWERABLE, GOLDEN_CORPUS, GOLDEN_TRUE_GAPS } from '../../corpora/goldenGapGate';
import { EV_ALERT_CASES, FCD0AF7E_TRANSCRIPT } from '../../corpora/evReplay';
import { FABRICATED_REPLIES, GROUNDED_REPLIES } from '../../corpora/fabrication';
import { ADVERSARIAL_LABELS, AUDIT_RECORDED_DRAWS } from '../../corpora/gapGatePolicies';
import { GHEG_CORPUS_WITH_EV_010 } from '../../ghegFluency/corpus';

/** Cites an audit artefact: EV-nnn, an IN-n live-replay input, or a hex conversation/alert id. */
const CITES_EVIDENCE = /(EV-\d+|IN[123]\b|conv [0-9a-f]{8}|alert [0-9a-f]{8}|[0-9a-f]{8})/;

describe('every corpus case cites its evidence', () => {
  it('gap-gate corpus', () => {
    for (const c of GOLDEN_CORPUS) {
      assert.ok(c.source.trim().length > 0, `${c.id}: empty source`);
      assert.ok(
        CITES_EVIDENCE.test(c.source) || /control/i.test(c.source),
        `${c.id}: source "${c.source}" cites no evidence and is not labelled a control`,
      );
      assert.ok(c.gloss.trim().length > 0, `${c.id}: no English gloss`);
      assert.ok(c.rationale.trim().length > 20, `${c.id}: rationale too thin to review`);
    }
  });

  it('EV alert corpus', () => {
    for (const c of EV_ALERT_CASES) {
      assert.match(c.source, /EV-\d+/, `${c.alertId}: source must cite an EV entry`);
      assert.ok(c.rationale.trim().length > 20, `${c.alertId}: rationale too thin`);
      assert.ok(c.originalReply.trim().length > 0, `${c.alertId}: empty reply fixture`);
    }
  });

  it('fabrication corpus', () => {
    for (const c of FABRICATED_REPLIES) {
      assert.ok(CITES_EVIDENCE.test(c.source) || /control/i.test(c.source), `${c.id}: ${c.source}`);
      assert.ok(c.expectViolationSpans.length > 0, `${c.id}: expects no violations`);
      assert.ok(c.expectKinds.length > 0, `${c.id}: expects no violation kind`);
    }
    for (const c of GROUNDED_REPLIES) {
      assert.ok(CITES_EVIDENCE.test(c.source) || /control/i.test(c.source), `${c.id}: ${c.source}`);
      assert.ok(c.injectedCatalog.includes('price:'), `${c.id}: catalog fixture has no prices`);
    }
  });
});

describe('corpus sizes are pinned (a corpus that shrinks stops guarding)', () => {
  it('gap gate', () => {
    assert.ok(GOLDEN_ANSWERABLE.length >= 18, `answerable: ${GOLDEN_ANSWERABLE.length} < 18`);
    assert.ok(GOLDEN_TRUE_GAPS.length >= 4, `true gaps: ${GOLDEN_TRUE_GAPS.length} < 4`);
  });

  it('EV replay: exactly the three recorded alerts, and the six-turn transcript', () => {
    assert.equal(EV_ALERT_CASES.length, 3, 'the dev DB contained exactly three hallucination alerts');
    assert.equal(FCD0AF7E_TRANSCRIPT.length, 6);
  });

  it('fabrication', () => {
    assert.ok(FABRICATED_REPLIES.length >= 4);
    assert.ok(GROUNDED_REPLIES.length >= 6);
  });

  it('Gheg (P2-5, still intact)', () => {
    assert.equal(GHEG_CORPUS_WITH_EV_010.length, 18);
  });
});

describe('ids are unique and stable (failures are grepped by id)', () => {
  const dupes = (ids: string[]): string[] =>
    ids.filter((id, i) => ids.indexOf(id) !== i);

  it('gap-gate ids', () => {
    assert.deepEqual(dupes(GOLDEN_CORPUS.map((c) => c.id)), []);
  });

  it('fabrication ids', () => {
    assert.deepEqual(dupes([...FABRICATED_REPLIES, ...GROUNDED_REPLIES].map((c) => c.id)), []);
  });

  it('EV alert ids', () => {
    assert.deepEqual(dupes(EV_ALERT_CASES.map((c) => c.alertId)), []);
  });
});

describe('the Albanian corpus reflects how customers actually write', () => {
  it('Gheg and standard cases carry NO Albanian diacritics (0 of 40 real messages did — EV-030)', () => {
    for (const c of GOLDEN_ANSWERABLE) {
      if (c.dialect === 'english') continue;
      assert.equal(
        /[ëçËÇ]/.test(c.text),
        false,
        `${c.id}: customer text carries diacritics real customers do not type: "${c.text}"`,
      );
    }
  });

  it('the corpus is majority Albanian, as real traffic is (39/40 in EV-030)', () => {
    const albanian = GOLDEN_ANSWERABLE.filter((c) => c.locale === 'sq').length;
    assert.ok(
      albanian * 2 > GOLDEN_ANSWERABLE.length,
      `only ${albanian}/${GOLDEN_ANSWERABLE.length} Albanian cases`,
    );
  });
});

describe('the adversarial label set stays anchored to measured behaviour', () => {
  it('carries the four labels the audit actually recorded', () => {
    // These are the measured false-escalation drivers. If one is dropped, the corresponding
    // real-world defect stops being exercised.
    for (const measured of ['marka', 'cila eshte me e mire', 'më e mirë', 'ma shum']) {
      assert.ok(
        ADVERSARIAL_LABELS.includes(measured),
        `"${measured}" was measured in production and must stay in the adversarial set`,
      );
    }
  });

  it('is broad enough that invariance is a real property, not a coincidence', () => {
    assert.ok(ADVERSARIAL_LABELS.length >= 10, `only ${ADVERSARIAL_LABELS.length} labels`);
  });

  it('the audit-recorded draws are exactly 8 per input, as the audit replayed them', () => {
    for (const [id, draws] of Object.entries(AUDIT_RECORDED_DRAWS)) {
      assert.equal(draws.length, 8, `${id}: ${draws.length} draws, expected 8`);
    }
    // IN3's defining detail: two DIFFERENT escalation reasons at temperature 0.
    const in3 = new Set(AUDIT_RECORDED_DRAWS.IN3.map((d) => JSON.stringify(d.missing)));
    assert.equal(in3.size, 2, 'IN3 must keep both measured missing-sets — that is the RC-01 evidence');
  });
});
